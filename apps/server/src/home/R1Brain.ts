// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalJsonInEffect:off preferSchemaOverJson:off
/**
 * The room's brain, routed per turn by the brain's routing table's `voice` row (no restart): his Anthropic key from
 * Settings → APIs (streamed with the room's tools, quickest), or his subscription via a Claude Code process started
 * ahead and waiting on stdin (one turn each, no tools). "auto" is the key with the subscription named as its fallback,
 * used when the key fails before a word was said (R1Device decides that).
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";

import { brainRoute, credentialOf } from "@t3tools/baton-shared/brainRoutes";
import { DEFAULT_ROUTING } from "@t3tools/baton-shared/costRouting";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { onSubscription } from "../baton/BrainRoutes.ts";
import { createVoiceSessions, type SessionSpec } from "./VoiceSessions.ts";
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
  /** `device`: the R1 that heard the turn, when the loop said (a replay's pretend R1 has no speaker to change). */
  readonly run: (name: string, input: unknown, device?: string) => Effect.Effect<ToolOutcome>;
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

/** A turn for a warm subscription session (VoiceSessions). */
export interface SessionToolTurn extends ToolTurn {
  /** The vessel that heard it: each has its own warm session waiting. */
  readonly vessel: string;
  /** A tool call started before she said a word: the vessel says a short line (`web`: a search, which takes seconds). */
  readonly cue: (web: boolean) => void;
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
    /** The subscription's turn with tools, in the vessel's warm session: its words as they come. */
    readonly session: (turn: SessionToolTurn) => Stream.Stream<string, R1BrainError>;
    /** Warms a session for this vessel now, so the first turn is as quick as the rest. */
    readonly warm: (
      turn: Pick<SessionToolTurn, "vessel" | "system" | "tools">,
    ) => Effect.Effect<void>;
  }
>()("t3/home/R1Brain") {}

/** Model calls in one turn; the last one may not call a tool, so the turn always ends in words. */
export const MAX_ROUNDS = 4;

/**
 * A spoken turn with tools: a round's tool calls run together and their results go back, until a round calls none or
 * the cap is reached. Only that last round is spoken: words before a tool call ("I'll ask your laptop…") are a promise
 * its outcome may break, so the room hears the outcome (and the route's "One moment." if it is slow).
 */
export const toolLoop = <E>(
  converse: (request: ConverseRequest) => Stream.Stream<ConversePart, E>,
  turn: ToolTurn,
) =>
  Stream.callback<string, E>((queue) =>
    Effect.gen(function* () {
      const startedAt = yield* Clock.currentTimeMillis;
      let firstAt: number | null = null;
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
              text += part.text;
              firstAt ??= now;
            }),
          ),
          Effect.exit,
        );
        if (ran._tag === "Failure") return yield* Queue.failCause(queue, ran.cause);
        if (calls.length === 0) {
          if (text !== "") Queue.offerUnsafe(queue, text);
          break;
        }
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
  readonly model: string;
  readonly bornAt: number;
  onLine: (line: string) => void;
  onExit: () => void;
}

/** @public */
export const make = Effect.fn("R1Brain.make")(function* (system: string) {
  const settings = yield* ServerSettingsService;
  const api = yield* DictationCleanupApi;
  let ready: Warm | null = null;
  /** The routing table's row for spoken turns; voice never reads the cheap model. */
  const voice = settings.getSettings.pipe(
    Effect.map((value) => brainRoute(value, "voice", DEFAULT_ROUTING.cheap)),
  );
  const spawn = (model: string): Warm => {
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
      model,
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
  const take = (model: string): Warm => {
    const old = ready;
    ready = null;
    if (
      old !== null &&
      old.model === model &&
      old.proc.exitCode === null &&
      Date.now() - old.bornAt < MAX_IDLE_MS
    )
      return old;
    old?.proc.kill();
    return spawn(model);
  };
  yield* Effect.addFinalizer(() => Effect.sync(() => ready?.proc.kill()));

  /** Which way the next turn goes: the key, the subscription, or the key with the subscription named behind it. */
  const route: Effect.Effect<R1Route> = Effect.gen(function* () {
    const row = yield* voice;
    if (credentialOf(row.use).kind === "subscription") return "subscription" as const;
    if (row.fallback === null || credentialOf(row.fallback).kind !== "subscription")
      return "api" as const;
    return (yield* api.configured) ? ("auto" as const) : ("subscription" as const);
  }).pipe(Effect.orElseSucceed(() => "subscription" as const));

  const viaSubscription = (user: string) =>
    Stream.callback<string, R1BrainError>((queue) =>
      Effect.gen(function* () {
        const path = onSubscription(
          yield* voice.pipe(Effect.mapError(() => new R1BrainError({ detail: "settings" }))),
        );
        if ("refused" in path) return yield* new R1BrainError({ detail: path.refused });
        const { model } = path;
        const warm = take(model);
        // The next subscription turn's process starts now, unless turns go by the key.
        if ((yield* route) === "subscription") ready = spawn(model);
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
    Stream.unwrap(
      Effect.map(voice, (row) => toolLoop((request) => api.converse(row, request), turn)),
    ).pipe(
      Stream.mapError(
        (error) =>
          new R1BrainError({
            detail:
              error._tag === "DictationCleanupError"
                ? `key: ${error.reason}`
                : error._tag === "BrainRefused"
                  ? `refused: ${error.why}`
                  : "settings",
          }),
      ),
    );

  const sessions = createVoiceSessions();
  yield* Effect.addFinalizer(() => Effect.promise(() => sessions.close()));
  /** The subscription session a vessel's turns run in, from the voice row. */
  const sessionSpec = Effect.fn("R1Brain.sessionSpec")(function* (
    turn: Pick<SessionToolTurn, "system" | "tools">,
  ) {
    const row = yield* voice.pipe(Effect.mapError(() => new R1BrainError({ detail: "settings" })));
    const path = onSubscription(row);
    if ("refused" in path) return yield* new R1BrainError({ detail: path.refused });
    return {
      model: path.model,
      effort: row.effort,
      system: turn.system,
      tools: turn.tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.input_schema as Readonly<Record<string, unknown>>,
      })),
    } satisfies SessionSpec;
  });

  const session = (turn: SessionToolTurn) =>
    Stream.callback<string, R1BrainError>((queue) =>
      Effect.gen(function* () {
        const spec = yield* sessionSpec(turn);
        const context = yield* Effect.context<never>();
        const startedAt = yield* Clock.currentTimeMillis;
        let firstAt: number | null = null;
        // The first thing the room hears: her words, or the cue when a tool call starts first.
        let actAt: number | null = null;
        const used: Array<string> = [];
        // Where a turn's time goes, in ms from the start: the model starting a call, the tool running, her words.
        const steps: Array<string> = [];
        const step = (what: string) => steps.push(`${what}@${Date.now() - startedAt}`);
        const ran = yield* Effect.tryPromise({
          // Interrupted (he cut her off), the signal aborts and the session is replaced.
          try: (signal) =>
            sessions.turn(turn.vessel, spec, turn.user, {
              signal,
              run: (name, args) => {
                step(`run:${name}`);
                return Effect.runPromiseWith(context)(turn.run(name, args)).then((outcome) => {
                  step(`ran:${name}`);
                  // A failed tool is an MCP error result: the model sees it as one.
                  if (outcome.isError) throw new Error(outcome.text);
                  return {
                    text: outcome.text,
                    ...(outcome.image === undefined
                      ? {}
                      : {
                          images: [{ data: outcome.image.data, mimeType: outcome.image.mediaType }],
                        }),
                  };
                });
              },
              onEvent: (event) => {
                if (event.type === "text") {
                  if (firstAt === null) step("words");
                  firstAt ??= Date.now();
                  actAt ??= firstAt;
                  Queue.offerUnsafe(queue, event.text);
                } else if (event.type === "tool") {
                  used.push(event.name);
                  step(`call:${event.name}`);
                  actAt ??= Date.now();
                  // Before her first word only: once she is talking, she says it herself.
                  if (firstAt === null && used.length === 1) turn.cue(event.web);
                }
              },
            }),
          catch: (error) =>
            new R1BrainError({
              detail: (error instanceof Error ? error.message : String(error)).slice(0, 300),
            }),
        }).pipe(Effect.exit);
        yield* Effect.logInfo("R1 tool turn", {
          route: "session",
          tools: used,
          ms: (yield* Clock.currentTimeMillis) - startedAt,
          brainFirstMs: firstAt === null ? null : firstAt - startedAt,
          firstActMs: actAt === null ? null : actAt - startedAt,
          steps: steps.join(" "),
        });
        if (ran._tag === "Failure") return yield* Queue.failCause(queue, ran.cause);
        yield* Queue.end(queue);
      }),
    );

  const warm = Effect.fn("R1Brain.warm")(
    function* (turn: Pick<SessionToolTurn, "vessel" | "system" | "tools">) {
      if ((yield* route) !== "subscription") return;
      const spec = yield* sessionSpec(turn);
      yield* Effect.promise(() => sessions.warm(turn.vessel, spec).catch(() => undefined));
    },
    (effect) => effect.pipe(Effect.ignore),
  );
  return {
    route,
    subscription: viaSubscription,
    converse,
    session,
    warm,
  } satisfies R1Brain["Service"];
});

export const layer = (system: string) => Layer.effect(R1Brain, make(system));
