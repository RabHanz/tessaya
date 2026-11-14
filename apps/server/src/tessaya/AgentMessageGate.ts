/**
 * Records agent-to-agent sends and refusals, and limits each sender per minute, counted from those rows here, on the
 * machine that receives it. The Record never decides a send: unreadable, the send goes ahead; unwritable, the send's
 * own answer stands, so a retry never delivers twice.
 */
import { recordText } from "@t3tools/tessaya-shared/audit";
import { decideMessage } from "@t3tools/tessaya-shared/trust";
import { OrchestratorMcpFailure, type ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { callerLinkOrigin } from "../mcp/linkOrigin.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { loadCaller } from "../mcp/threadAccess.ts";
import { TessayaRecordService } from "./TessayaRecordService.ts";

const KIND = "agent_message";
const MINUTE_MS = 60_000;
const isMcpFailure = Schema.is(OrchestratorMcpFailure);
/** A name the sender chose, quoted for the Record. */
const quoted = (text: string): string => JSON.stringify(text);

/**
 * Per sender: sends started in the last minute (two at once cannot both pass before either is recorded), and when a
 * refusal was last recorded (a flood is refused every time but recorded once a minute; Record rows are capped).
 */
const senders = new Map<string, { started: Array<number>; refusedAt: number | null }>();

export interface MessageSend {
  /** Who is sending, by something it cannot choose: a delegation tree, a link session, a client session. */
  readonly sender: string;
  readonly ref: string;
  readonly project: string | null;
  readonly subject: string;
}

/** The Record and the per-minute limit around one agent-to-agent send. */
export const gateMessage = Effect.fn("AgentMessageGate.gateMessage")(function* <A, E, R>(
  message: MessageSend,
  send: Effect.Effect<A, E, R>,
) {
  const record = yield* Effect.serviceOption(TessayaRecordService);
  const sender = recordText(message.sender, 60);
  const now = yield* Clock.currentTimeMillis;
  const mine = senders.get(sender) ?? { started: [], refusedAt: null };
  senders.set(sender, mine);
  const write = (outcome: "sent" | "refused", detail: string) =>
    Option.match(record, {
      onNone: () => Effect.void,
      onSome: (r) =>
        r
          .append({
            kind: KIND,
            actor: sender,
            project: message.project,
            ref: message.ref,
            subject: message.subject,
            outcome,
            detail,
          })
          .pipe(Effect.ignoreCause),
    });
  const refused = (detail: string) =>
    Effect.suspend(() => {
      if (mine.refusedAt !== null && mine.refusedAt > now - MINUTE_MS) return Effect.void;
      mine.refusedAt = now;
      return write("refused", detail);
    });

  const recorded = yield* Option.match(record, {
    onNone: () => Effect.succeed(0),
    onSome: (r) =>
      r
        .query({
          kind: KIND,
          actor: sender,
          outcome: "sent",
          since: DateTime.formatIso(DateTime.makeUnsafe(now - MINUTE_MS)),
          limit: 500,
        })
        .pipe(
          Effect.map((rows) => rows.length),
          Effect.catchCause(() => Effect.succeed(0)),
        ),
  });
  mine.started = mine.started.filter((at) => at > now - MINUTE_MS);
  const verdict = decideMessage({ sentLastMinute: Math.max(recorded, mine.started.length) });
  if (verdict.verdict === "deny") {
    yield* refused(verdict.why);
    return yield* new OrchestratorMcpFailure({ code: "capability_denied", message: verdict.why });
  }
  mine.started.push(now);
  return yield* send.pipe(
    Effect.tapError((error) =>
      Effect.sync(() => {
        // Nothing was sent, so it does not count.
        const at = mine.started.lastIndexOf(now);
        if (at >= 0) mine.started.splice(at, 1);
      }).pipe(Effect.andThen(refused(isMcpFailure(error) ? error.message : String(error)))),
    ),
    Effect.tap(() => write("sent", "")),
  );
});

/** `t3_thread_send`: gated, except inside one delegation tree, where the from-line is left off too. */
export const gateThreadSend = Effect.fn("AgentMessageGate.gateThreadSend")(function* <A, E, R>(
  input: { readonly threadId: ThreadId },
  send: Effect.Effect<A, E, R>,
) {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const caller = Option.getOrUndefined(yield* loadCaller().pipe(Effect.option));
  const origin = caller === undefined ? undefined : callerLinkOrigin(caller);
  const target =
    caller === undefined
      ? null
      : yield* caller.threads.getThreadShell(input.threadId).pipe(Effect.orElseSucceed(() => null));
  const root = caller?.caller?.lineage.rootThreadId;
  if (root !== undefined && target !== null && root === target.lineage.rootThreadId)
    return yield* send;
  return yield* gateMessage(
    {
      sender:
        root !== undefined
          ? `thread:${root}`
          : origin !== undefined
            ? `link:${origin.sessionId}`
            : `client:${scope.client?.sessionId ?? "unknown"}`,
      ref: input.threadId,
      project: target?.projectId ?? null,
      subject: `To thread ${quoted(target?.title ?? input.threadId)}`,
    },
    send,
  );
});
