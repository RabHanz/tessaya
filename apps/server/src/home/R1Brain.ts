// @effect-diagnostics nodeBuiltinImport:off globalJsonInEffect:off preferSchemaOverJson:off
/**
 * The room's fast brain: one Claude Code process (Haiku, no tools, thinking off) started ahead of the turn and
 * waiting on stdin, so a turn pays only the model's first token (about 1 s measured on hetzner), not the CLI's
 * start-up (about 3 s). Each process answers one turn and exits; the next is already waiting.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

export class R1BrainError extends Schema.TaggedError<R1BrainError>()("R1BrainError", {
  detail: Schema.String,
}) {}

export class R1Brain extends Context.Service<
  R1Brain,
  {
    /** The reply to one user message, as text deltas in order. */
    readonly stream: (user: string) => Stream.Stream<string, R1BrainError>;
    /** Starts a waiting process now, so the first turn is fast too. */
    readonly warm: Effect.Effect<void>;
  }
>()("t3/home/R1Brain") {}

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

  const stream = (user: string) =>
    Stream.callback<string, R1BrainError>((queue) =>
      Effect.gen(function* () {
        const warm = take();
        ready = spawn();
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
  const warm = Effect.sync(() => {
    ready ??= spawn();
  });
  return { stream, warm } satisfies R1Brain["Service"];
});

export const layer = (system: string) => Layer.effect(R1Brain, make(system));
