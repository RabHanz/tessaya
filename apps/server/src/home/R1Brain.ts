// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalJsonInEffect:off preferSchemaOverJson:off
/**
 * The room's brain, routed per turn by the `roomBrain` setting (no restart): his Anthropic key from Settings → APIs
 * (Haiku streamed with the room's tools, quickest), or his subscription via a Claude Code process started ahead and
 * waiting on stdin (one turn each, no tools). "auto" uses the key, and the subscription when the key fails before a
 * word was said (R1Device decides that).
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";

import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ServerSettingsService } from "../serverSettings.ts";
import {
  DictationCleanupApi,
  type ConversePart,
  type ConverseRequest,
} from "../speech/DictationCleanupApi.ts";

export class R1BrainError extends Schema.TaggedError<R1BrainError>()("R1BrainError", {
  detail: Schema.String,
}) {}

export type R1Route = "api" | "subscription" | "auto";

/** One tool the room may call, as the Messages API takes it, and what running it said. */
export interface RoomTool {
  readonly name: string;
  readonly description: string;
  readonly input_schema: unknown;
}
export interface ToolOutcome {
  readonly text: string;
  readonly isError: boolean;
  /** A picture the model should see with the result (the R1's camera); never kept past the turn. */
  readonly image?: { readonly mediaType: string; readonly data: string };
  /** A house or device act's status (done, asked, refused…), for the eyes and the Record. */
  readonly status?: string;
}

/**
 * The room's tools as the server built them (R1Tools.layer), handed in rather than imported so the room's code stays
 * out of the toolkits' import graph; null without them, and the turn speaks the acts form.
 */
export interface RoomToolSet {
  readonly specs: ReadonlyArray<RoomTool>;
  readonly run: (name: string, input: unknown) => Effect.Effect<ToolOutcome>;
}
export const RoomTools = Context.Reference<RoomToolSet | null>("t3/home/RoomTools", {
  defaultValue: () => null,
});
export interface ToolTurn {
  readonly system: string;
  readonly user: string;
  readonly tools: ReadonlyArray<RoomTool>;
  readonly run: (name: string, input: unknown) => Effect.Effect<ToolOutcome>;
}

export class R1Brain extends Context.Service<
  R1Brain,
  {
    /** Which way this turn goes. */
    readonly route: Effect.Effect<R1Route>;
    /** The subscription's reply to one user message (the ACTS form), as text deltas in order. */
    readonly subscription: (user: string) => Stream.Stream<string, R1BrainError>;
    /** The key's turn with tools: its words as they come, tool rounds in between (`toolLoop`). */
    readonly converse: (turn: ToolTurn) => Stream.Stream<string, R1BrainError>;
    /** Starts a waiting process now, so the first turn is fast too. */
    readonly warm: Effect.Effect<void>;
  }
>()("t3/home/R1Brain") {}

/** Model calls in one turn; the last one may not call a tool, so the turn always ends in words. */
export const MAX_ROUNDS = 4;

/**
 * A spoken turn with tools: each round's words go out as they come (so "Let me check." is heard while the tool runs),
 * then its tool calls run together and their results go back, until a round calls none or the cap is reached.
 */
export const toolLoop = <E>(
  converse: (request: ConverseRequest) => Stream.Stream<ConversePart, E>,
  turn: ToolTurn,
) =>
  Stream.callback<string, E>((queue) =>
    Effect.gen(function* () {
      const startedAt = yield* Clock.currentTimeMillis;
      let firstAt: number | null = null;
      let said = "";
      const used: Array<string> = [];
      const messages: Array<unknown> = [{ role: "user", content: turn.user }];
      let rounds = 0;
      while (rounds < MAX_ROUNDS) {
        rounds += 1;
        const calls: Array<Extract<ConversePart, { type: "tool" }>> = [];
        let text = "";
        const ran = yield* converse({
          system: turn.system,
          messages,
          tools: turn.tools,
          maxTokens: 400,
          toolChoice: rounds === MAX_ROUNDS ? "none" : "auto",
        }).pipe(
          Stream.runForEach((part) =>
            Effect.map(Clock.currentTimeMillis, (now) => {
              if (part.type === "tool") return void calls.push(part);
              // A new round's words start a new sentence for the room's speech.
              const gap = text === "" && said !== "" && !/\s$/.test(said) ? " " : "";
              text += part.text;
              said += gap + part.text;
              firstAt ??= now;
              Queue.offerUnsafe(queue, gap + part.text);
            }),
          ),
          Effect.exit,
        );
        if (ran._tag === "Failure") return yield* Queue.failCause(queue, ran.cause);
        if (calls.length === 0) break;
        used.push(...calls.map((c) => c.name));
        const outcomes = yield* Effect.forEach(calls, (c) => turn.run(c.name, c.input), {
          concurrency: "unbounded",
        });
        messages.push(
          {
            role: "assistant",
            content: [
              ...(text === "" ? [] : [{ type: "text", text }]),
              ...calls.map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: c.input })),
            ],
          },
          {
            role: "user",
            content: calls.map((c, i) => ({
              type: "tool_result",
              tool_use_id: c.id,
              content:
                outcomes[i]!.image === undefined
                  ? outcomes[i]!.text
                  : [
                      {
                        type: "image",
                        source: {
                          type: "base64",
                          media_type: outcomes[i]!.image!.mediaType,
                          data: outcomes[i]!.image!.data,
                        },
                      },
                      { type: "text", text: outcomes[i]!.text },
                    ],
              ...(outcomes[i]!.isError ? { is_error: true } : {}),
            })),
          },
        );
      }
      yield* Effect.logInfo("R1 tool turn", {
        rounds,
        tools: used,
        ms: (yield* Clock.currentTimeMillis) - startedAt,
        brainFirstMs: firstAt === null ? null : firstAt - startedAt,
      });
      yield* Queue.end(queue);
    }),
  );

/** A waiting process older than this is replaced, so a turn never lands on stale credentials. */
const MAX_IDLE_MS = 10 * 60_000;

/** One stream-json line from Claude Code: a text delta, the end of the turn, or nothing we use. */
export const readLine = (
  line: string,
): { readonly delta?: string; readonly done?: true; readonly error?: string } => {
  let m: {
    type?: string;
    is_error?: boolean;
    result?: unknown;
    event?: { type?: string; delta?: { type?: string; text?: string } };
  };
  try {
    m = JSON.parse(line) as typeof m;
  } catch {
    return {};
  }
  if (
    m.type === "stream_event" &&
    m.event?.type === "content_block_delta" &&
    m.event.delta?.type === "text_delta"
  )
    return m.event.delta.text ? { delta: m.event.delta.text } : {};
  if (m.type === "result")
    return m.is_error === true ? { error: String(m.result ?? "failed") } : { done: true };
  return {};
};

interface Warm {
  readonly proc: NodeChildProcess.ChildProcess;
  readonly bornAt: number;
  onLine: (line: string) => void;
  onExit: () => void;
}

/** @public */
export const make = Effect.fn("R1Brain.make")(function* (system: string, model = "haiku") {
  const settings = yield* ServerSettingsService;
  const api = yield* DictationCleanupApi;
  let ready: Warm | null = null;
  const spawn = (): Warm => {
    const proc = NodeChildProcess.spawn(
      "claude",
      [
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--include-partial-messages",
        "--verbose",
        "--model",
        model,
        "--system-prompt",
        system,
        "--settings",
        JSON.stringify({ disableAllHooks: true, alwaysThinkingEnabled: false }),
        "--tools",
        "",
        "--disable-slash-commands",
        "--strict-mcp-config",
        "--permission-mode",
        "dontAsk",
        // No CLAUDE.md or settings files: his global instructions would ride along with every turn and slow it.
        "--setting-sources",
        "",
      ],
      { stdio: ["pipe", "pipe", "ignore"], windowsHide: true, cwd: NodeOS.tmpdir() },
    );
    const warm: Warm = {
      proc,
      bornAt: Date.now(),
      onLine: () => undefined,
      onExit: () => undefined,
    };
    let buf = "";
    proc.stdout?.setEncoding("utf8");
    proc.stdout?.on("data", (chunk: string) => {
      buf += chunk;
      for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
        warm.onLine(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    });
    proc.on("exit", () => {
      if (ready === warm) ready = null;
      warm.onExit();
    });
    proc.on("error", () => undefined);
    return warm;
  };
  const take = (): Warm => {
    const old = ready;
    ready = null;
    if (old !== null && old.proc.exitCode === null && Date.now() - old.bornAt < MAX_IDLE_MS)
      return old;
    old?.proc.kill();
    return spawn();
  };
  yield* Effect.addFinalizer(() => Effect.sync(() => ready?.proc.kill()));

  /** Which way the next turn goes: the key, the subscription, or the key with the subscription behind it. */
  const route: Effect.Effect<R1Route> = Effect.gen(function* () {
    const mode = (yield* settings.getSettings).roomBrain;
    if (mode !== "auto") return mode;
    return (yield* api.configured) ? ("auto" as const) : ("subscription" as const);
  }).pipe(Effect.orElseSucceed(() => "subscription" as const));

  const viaSubscription = (user: string) =>
    Stream.callback<string, R1BrainError>((queue) =>
      Effect.gen(function* () {
        const warm = take();
        // The next subscription turn's process starts now, unless turns go by the key.
        if ((yield* route) === "subscription") ready = spawn();
        yield* Effect.addFinalizer(() => Effect.sync(() => warm.proc.kill()));
        const failed = yield* Effect.callback<string | null>((resume) => {
          warm.onLine = (line) => {
            const r = readLine(line);
            if (r.delta !== undefined) Queue.offerUnsafe(queue, r.delta);
            if (r.done) resume(Effect.succeed(null));
            if (r.error !== undefined) resume(Effect.succeed(r.error));
          };
          warm.onExit = () => resume(Effect.succeed("claude exited before answering"));
          warm.proc.stdin?.write(
            `${JSON.stringify({ type: "user", message: { role: "user", content: user } })}\n`,
          );
        });
        if (failed !== null)
          yield* Queue.fail(queue, new R1BrainError({ detail: failed.slice(0, 300) }));
        else yield* Queue.end(queue);
      }),
    );

  const converse = (turn: ToolTurn) =>
    toolLoop(api.converse, turn).pipe(
      Stream.mapError(
        (error) =>
          new R1BrainError({
            detail: error._tag === "DictationCleanupError" ? `key: ${error.reason}` : "settings",
          }),
      ),
    );

  // Only the subscription route needs a process waiting; the key route never starts one.
  const warm = Effect.gen(function* () {
    if ((yield* route) === "subscription") ready ??= spawn();
  });
  return { route, subscription: viaSubscription, converse, warm } satisfies R1Brain["Service"];
});

export const layer = (system: string) => Layer.effect(R1Brain, make(system));
