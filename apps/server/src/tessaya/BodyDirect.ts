/**
 * "Agent drives her" (M-089): one direction, one model, only the three body tools, on a playground's sandbox bus (and,
 * when he asks, her desk body too). It runs on her own brain loop (R1Brain: his key or his subscription, whichever her
 * routing uses) with the model he picked, records its usage as "body-playground", and reports each call as it lands,
 * how long until the body first moved, and the direction eval's flags (bodyGrade).
 */
import { brainRoute } from "@t3tools/tessaya-shared/brainRoutes";
import { grade, type Graded } from "@t3tools/tessaya-shared/bodyGrade";
import { DEFAULT_ROUTING } from "@t3tools/tessaya-shared/costRouting";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { Tool } from "effect/ai";

import { R1Brain, type RoomTool, type ToolOutcome } from "../home/R1Brain.ts";
import { advertisedJsonSchema } from "../mcp/advertisedJsonSchema.ts";
import { BodyTools } from "../mcp/toolkits/body/tools.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { movePlayground, scenePlayground, statePlayground } from "./BodyPlayground.ts";
import { moveBody, playScene, type BodyCaller } from "./TessayaBody.ts";
import { listDollarsOf } from "./BrainUsage.ts";
import type { RateTable } from "../usage/usagePricing.ts";

export const DIRECT_MODELS = ["haiku", "sonnet", "opus", "brain"] as const;
export type DirectModel = (typeof DIRECT_MODELS)[number];
const API_ID: Readonly<Record<Exclude<DirectModel, "brain">, string>> = {
  haiku: "claude-haiku-5-5",
  sonnet: "claude-sonnet-5-5",
  opus: "claude-opus-5-5",
};

const SPECS: ReadonlyArray<RoomTool> = BodyTools.map((tool: Tool.Any) => ({
  name: tool.name,
  description: Tool.getDescription(tool) ?? "",
  input_schema: advertisedJsonSchema(tool),
}));

export const DIRECT_SYSTEM = `You direct one 3D body with the body tools, as an outside agent would. Act the direction out on the body: call tessaya_body_move (give perform for how it feels and moves, then act, gesture, look or keys for specifics, and then for what follows) or tessaya_body_scene for a timeline. Call tessaya_body_state first only if you need what this body can do. Then say in one short line what you did and why.`;

export interface DirectCall {
  readonly name: string;
  readonly input: unknown;
  /** ms from the direction. */
  readonly atMs: number;
  readonly ok: boolean;
  readonly said: string;
}
export interface DirectProgress {
  readonly model: DirectModel;
  readonly said: string;
  calls: DirectCall[];
  done: boolean;
  reasoning: string;
  firstMotionMs: number | null;
  ms: number | null;
  graded: Graded | null;
  error: string | null;
}

/** The model a run uses, by its API name (for pricing): "brain" is her voice row's. */
export const directModelId = Effect.fn("BodyDirect.modelId")(function* (model: DirectModel) {
  if (model !== "brain") return API_ID[model];
  const settings = yield* Effect.serviceOption(ServerSettingsService);
  if (Option.isNone(settings)) return API_ID.sonnet;
  const row = yield* settings.value.getSettings.pipe(
    Effect.map((s) => brainRoute(s, "voice", DEFAULT_ROUTING.cheap)),
    Effect.orElseSucceed(() => null),
  );
  const m = row?.model ?? "sonnet";
  return API_ID[m as keyof typeof API_ID] ?? m;
});

/**
 * What one run costs before it runs, at list price: the system prompt and the three tools' schemas each round, two
 * rounds, a few hundred tokens out each. On his plan it is the plan's equivalent; null when the price list lacks it.
 */
export const estimateDirect = (rates: RateTable | null, modelId: string, said: string) => {
  const prompt = Math.ceil((DIRECT_SYSTEM.length + JSON.stringify(SPECS).length + said.length) / 4);
  const rounds = 2;
  const tokens = {
    model: modelId,
    input: prompt,
    cacheRead: prompt * (rounds - 1),
    cacheWrite: 0,
    output: 500 * rounds,
  };
  return { tokens, usd: listDollarsOf(rates, tokens) };
};

/** Runs one direction; `progress` fills in as calls land, so a page can show them live. */
export const directBody = Effect.fn("BodyDirect.direct")(function* (input: {
  readonly said: string;
  readonly model: DirectModel;
  readonly playground: string;
  /** Also on her desk body, through the same doors as any agent's move (body focus still decides). */
  readonly alsoHer: boolean;
  readonly progress: DirectProgress;
}) {
  const brain = yield* Effect.serviceOption(R1Brain);
  const p = input.progress;
  if (Option.isNone(brain)) {
    p.error = "Her brain isn't running on this server.";
    p.done = true;
    return p;
  }
  const started = yield* Clock.currentTimeMillis;
  // An agent's hand with the weakest presence: it never takes her body from a conversation he is in.
  const caller: BodyCaller = {
    id: `playground:${input.model}`,
    kind: "agent",
    mayBePrivate: false,
    thread: "playground",
    signal: "look",
  };
  const run = (name: string, raw: unknown): Effect.Effect<ToolOutcome> =>
    Effect.gen(function* () {
      const args = (raw !== null && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
      const { target: _t, playground: _p, ...rest } = args;
      const answer: { readonly ok: boolean; readonly said?: string } =
        name === "tessaya_body_move"
          ? yield* movePlayground(rest, caller, input.playground)
          : name === "tessaya_body_scene"
            ? yield* scenePlayground(rest["scene"], caller, rest["dryRun"] === true, input.playground)
            : name === "tessaya_body_state"
              ? { ok: true, ...statePlayground(input.playground) }
              : { ok: false, said: `Only the body tools run here, not ${name}.` };
      if (input.alsoHer && answer.ok && name !== "tessaya_body_state")
        yield* (name === "tessaya_body_move"
          ? moveBody(rest, caller)
          : playScene(rest["scene"], caller, rest["dryRun"] === true)
        ).pipe(Effect.ignore);
      const at = (yield* Clock.currentTimeMillis) - started;
      const moved = answer.ok && name !== "tessaya_body_state" && rest["dryRun"] !== true;
      if (moved && p.firstMotionMs === null) p.firstMotionMs = at;
      p.calls.push({ name, input: rest, atMs: at, ok: answer.ok, said: answer.said ?? "" });
      return { text: JSON.stringify(answer), isError: !answer.ok };
    }).pipe(
      Effect.catchCause(() => Effect.succeed({ text: "That body call failed.", isError: true })),
    );
  const turn = {
    vessel: `playground-${input.model}`,
    system: DIRECT_SYSTEM,
    user: input.said,
    tools: SPECS,
    run,
    cue: () => undefined,
    feature: "body-playground",
    ...(input.model === "brain" ? {} : { model: input.model }),
  };
  const route = yield* brain.value.route;
  const words = yield* (route === "subscription"
    ? brain.value.session(turn)
    : brain.value.converse(turn)
  ).pipe(
    Stream.runFold(
      () => "",
      (a, b: string) => a + b,
    ),
    Effect.timeoutOption("2 minutes"),
    Effect.catchCause(() => Effect.succeed(Option.none<string>())),
  );
  p.reasoning = Option.getOrElse(words, () => "").trim();
  if (Option.isNone(words) && p.calls.length === 0) p.error = "The model didn't answer.";
  p.graded = grade({ calls: p.calls.map((c) => c.name), inputs: p.calls.map((c) => c.input) });
  p.ms = (yield* Clock.currentTimeMillis) - started;
  p.done = true;
  return p;
});

// shortcut: runs live in memory for the page that started them; a restart forgets them (their usage rows stay)
const runs = new Map<string, DirectProgress>();
const MAX_RUNS = 24;
export const startedRun = (id: string, progress: DirectProgress) => {
  runs.set(id, progress);
  while (runs.size > MAX_RUNS) runs.delete(runs.keys().next().value!);
};
export const runOf = (id: string) => runs.get(id) ?? null;

/** A rated run as a row of the direction eval's results, so `harvest.ts` takes the file as it is. */
export const ratedRow = (
  id: string,
  p: DirectProgress,
  good: boolean,
  note: string,
  at: number,
) => {
  const graded = p.graded ?? grade({ calls: [], inputs: [] });
  return {
    id: `playground-${id}`,
    said: p.said,
    split: "seen",
    category: "playground",
    calls: p.calls.map((c) => c.name).join(" "),
    input: null,
    bodyInputs: p.calls.map((c) => c.input),
    reply: p.reasoning,
    graded,
    score: good ? 5 : 1,
    why: note,
    pass: good && graded.moved && graded.overSpeed.length === 0 && graded.corrections === 0,
    ms: p.ms ?? 0,
    model: p.model,
    ratedAt: at,
  };
};
