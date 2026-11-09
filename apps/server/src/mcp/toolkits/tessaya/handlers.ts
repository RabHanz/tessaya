import {
  BATON_JOB_WS_METHODS,
  BATON_MEMORY_WS_METHODS,
  BATON_ORCHESTRATION_WS_METHODS,
  BATON_PHONE_WS_METHODS,
  BATON_RECORD_WS_METHODS,
  BATON_SESSIONS_WS_METHODS,
  BATON_WATCH_WS_METHODS,
  BATON_WS_METHODS,
  BATON_WEAVE_WS_METHODS,
  BatonDesktopState,
} from "@t3tools/baton-contracts";
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { recordText } from "@t3tools/baton-shared/audit";

import { clientMessageFrom, withAgentMessageFrom } from "../../../baton/AgentMessageFrom.ts";
import { gateMessage } from "../../../baton/AgentMessageGate.ts";
import { AskOwner } from "../../../baton/BatonPhoneInbox.ts";
import packageJson from "../../../../package.json" with { type: "json" };
import * as BatonRpcHandlers from "../../../baton/BatonRpcHandlers.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller } from "../../threadAccess.ts";
import { TessayaToolkit } from "./tools.ts";

const decodeAsked = Schema.decodeUnknownOption(
  Schema.Struct({
    ok: Schema.optional(Schema.Boolean),
    status: Schema.optional(Schema.String),
    line: Schema.optional(Schema.String),
  }),
);

/** A name the caller chose, as one capped line, quoted for the Record. */
const quoted = (text: string): string => JSON.stringify(recordText(text, 100));

const decodeStateReply = Schema.decodeUnknownOption(
  Schema.Struct({
    connected: Schema.Boolean,
    at: Schema.NullOr(Schema.String),
    state: Schema.NullOr(BatonDesktopState),
  }),
);

const failed = (cause: unknown) =>
  new OrchestratorMcpFailure({
    code: "orchestration_error",
    message:
      typeof cause === "object" && cause !== null && "reason" in cause
        ? String(cause.reason)
        : "Tessaya could not answer that.",
  });

export const layer = McpToolAccess.toLayer(
  TessayaToolkit,
  Effect.gen(function* () {
    const handlers = yield* BatonRpcHandlers.makeHandlers;
    const random = yield* SecureRandom.SecureRandom;
    // No RPC session here, so the inbox's AskSource stays "device": the desktop's gate asks him before any act.
    const phone = (op: "ask" | "askGet", args: Record<string, unknown>) =>
      Effect.map(handlers[BATON_PHONE_WS_METHODS.call]({ op, args }), ({ value }) =>
        Option.getOrNull(decodeAsked(value)),
      );
    // The agent's own requests carry its session in their id, so it reads only those and is capped per session.
    const ownerOf = Effect.map(McpInvocationContext.McpInvocationContext, (scope) =>
      (scope.client?.sessionId ?? "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 24),
    );
    // A request for the Director, filed as this agent's (an outside client's session, or a thread agent's thread).
    const askHim = Effect.fn("TessayaMcp.askHim")(function* (text: string) {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const owner = (scope.client?.sessionId ?? `t${scope.thread?.threadId ?? "unknown"}`)
        .replace(/[^a-zA-Z0-9]/g, "")
        .slice(0, 24);
      const id = `mcp-${owner}-${yield* random.uuidV4()}`;
      const asked = yield* phone("ask", { id, text }).pipe(
        Effect.provideService(AskOwner, owner),
        Effect.mapError(failed),
      );
      return {
        id: asked?.ok === false ? null : id,
        status: asked?.status ?? "not asked",
        line: asked?.line ?? "Nothing was asked.",
      };
    });
    // The same handlers as the clients' RPC, behind T3's read check for this credential.
    const call = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      readCaller().pipe(
        Effect.filterOrFail(
          ({ scope }) => scope.client !== undefined,
          () =>
            new OrchestratorMcpFailure({
              code: "capability_denied",
              message: "Tessaya's tools are for agents signed in from outside T3 Code.",
            }),
        ),
        Effect.andThen(effect.pipe(Effect.mapError(failed))),
      );
    return {
      tessaya_jobs: McpToolAccess.reads(() => call(handlers[BATON_JOB_WS_METHODS.jobList]())),
      tessaya_watch: McpToolAccess.reads(() => call(handlers[BATON_WATCH_WS_METHODS.watchGet]())),
      // State and names only: no synopsis, prompt or folder, and a walled project's work by its project's name.
      // A linked server of his gets its projects and accounts resolved; any other outside reader, neither.
      tessaya_fleet: McpToolAccess.reads(() =>
        McpInvocationContext.McpInvocationContext.pipe(
          Effect.flatMap((scope) =>
            call(
              handlers[BATON_WS_METHODS.fleetGet]({
                forOutside: true,
                ...(scope.client?.linked === true ? { forLinked: true } : {}),
              }),
            ),
          ),
        ),
      ),
      tessaya_record: McpToolAccess.reads((input) =>
        call(handlers[BATON_RECORD_WS_METHODS.list]({ ...input, limit: input.limit ?? 30 })),
      ),
      // Read as a client (MemoryViewer's default here): walls hold, no persona can be named, his own view is closed.
      tessaya_team_board: McpToolAccess.reads(() =>
        call(handlers[BATON_JOB_WS_METHODS.jobTeam]({})),
      ),
      // Read as a client (MemoryViewer's default here): walls hold and no persona can be named.
      tessaya_memory_search: McpToolAccess.reads((input) =>
        call(
          handlers[BATON_MEMORY_WS_METHODS.search]({ text: input.text, limit: input.limit ?? 10 }),
        ),
      ),
      // A client's view, as for search: a walled item has no history to an outside agent.
      tessaya_memory_history: McpToolAccess.reads((input) =>
        call(handlers[BATON_MEMORY_WS_METHODS.history]({ id: input.id })),
      ),
      tessaya_rules: McpToolAccess.reads((input) =>
        call(handlers[BATON_ORCHESTRATION_WS_METHODS.ruleList](input)),
      ),
      tessaya_in_flight: McpToolAccess.reads(() =>
        call(handlers[BATON_SESSIONS_WS_METHODS.inFlight]()),
      ),
      // Titles and folders only: the history index would let an agent test any word against every transcript.
      tessaya_sessions: McpToolAccess.reads((input) =>
        call(
          handlers[BATON_SESSIONS_WS_METHODS.list]({
            ...input,
            limit: input.limit ?? 30,
            history: false,
          }),
        ),
      ),
      tessaya_ask: McpToolAccess.writesWithCapability((input) =>
        call(
          Effect.gen(function* () {
            const owner = yield* ownerOf;
            const id = `mcp-${owner}-${yield* random.uuidV4()}`;
            const asked = yield* phone("ask", { id, text: input.text }).pipe(
              Effect.provideService(AskOwner, owner),
            );
            return {
              id: asked?.ok === false ? null : id,
              status: asked?.status ?? "not asked",
              line: asked?.line ?? "Nothing was asked.",
            };
          }),
        ),
      ),
      tessaya_state: McpToolAccess.reads((input) =>
        call(
          Effect.map(
            handlers[BATON_PHONE_WS_METHODS.call]({ op: "stateGet", args: {} }),
            ({ value }) => {
              const got = Option.getOrNull(decodeStateReply(value));
              return {
                connected: got?.connected === true,
                at: got?.at ?? null,
                section: input.section,
                value:
                  got?.connected === true && got.state !== null
                    ? got.state[input.section]
                    : "Tessaya's desktop app isn't connected to this server, so only the server's own facts are here.",
                server: { version: packageJson.version },
              };
            },
          ),
        ),
      ),
      // Only this agent's own requests: another agent's, the phone's and the web bar's are not its to read.
      tessaya_ask_status: McpToolAccess.reads((input) =>
        call(
          Effect.map(
            Effect.flatMap(ownerOf, (owner) =>
              input.id.startsWith(`mcp-${owner}-`)
                ? phone("askGet", { id: input.id })
                : Effect.succeed(null),
            ),
            (asked) => ({
              id: asked === null ? null : input.id,
              status: asked?.status ?? "unknown",
              line: asked?.line ?? "No such request.",
            }),
          ),
        ),
      ),
      // Typing into a pane needs full access, here and before a call leaves for a link, within any narrowed modes the
      // caller passed on. The session reads who sent it, quoted; the limit and the Record key on the client's session,
      // never its name. Delivering what waits is a write too, so it goes here.
      weave_send: McpToolAccess.writesEnvironment(
        (input) =>
          McpInvocationContext.McpInvocationContext.pipe(
            Effect.flatMap((scope) => {
              const label = scope.client?.label ?? "an outside agent";
              return gateMessage(
                {
                  sender: `outside:${scope.client?.sessionId ?? "unknown"}`,
                  ref: input.to,
                  project: null,
                  subject: `To session ${quoted(input.to)} from ${quoted(label)}`,
                },
                call(
                  handlers[BATON_WEAVE_WS_METHODS.send]({
                    to: input.to,
                    text: withAgentMessageFrom(
                      clientMessageFrom(scope.client ?? { label }),
                      input.text,
                    ),
                    from: label,
                    ...(input.job === undefined ? {} : { job: input.job }),
                  }).pipe(
                    Effect.tap(() => handlers[BATON_WEAVE_WS_METHODS.tick]().pipe(Effect.ignore)),
                  ),
                ),
              );
            }),
          ),
        { linkedCallers: "allowed" },
      ),
      // Never the move itself: a request he answers on his own screen, where the desktop's gate asks him every time.
      tessaya_move_into_tessaya: McpToolAccess.writesThreads(
        (input) => [input.threadId],
        (input) =>
          askHim(
            `Move the Terminal thread ${input.threadId} into Tessaya (thread_move_into_tessaya): its terminal session ends and the same conversation continues in Tessaya.`,
          ),
      ),
      weave_list: McpToolAccess.reads((input) =>
        call(
          handlers[BATON_WEAVE_WS_METHODS.list](
            input.limit === undefined ? {} : { limit: input.limit },
          ),
        ),
      ),
    };
  }),
);
