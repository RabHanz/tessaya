/**
 * Her body as something her brain and any permitted agent can move and feel (M-065): one door for the MCP tools and
 * the bridge. A move is decoded with bounds (bodyControl.ts), rate-limited per caller, and recorded with provenance;
 * then the open private layer takes it onto every body following its session (window, desk, phone, VaM), or, with
 * none open, her desk character does what it can of it. Moves that belong to a private moment never go anywhere else.
 */
import type { MascotAct } from "@t3tools/tessaya-shared/companion";
import {
  BODY_CAPABILITIES,
  decodeBodyMove,
  extensionActs,
  isPrivateMove,
  moveCues,
  rateGate,
  STREAM_LAPSE_MS,
  STREAM_RATE,
  type BodyMove,
  type RateState,
} from "@t3tools/tessaya-shared/bodyControl";
import type { BodyCue } from "@t3tools/tessaya-shared/bodyCues";
import {
  CORE_SCENES,
  decodeScene,
  dryRun,
  isPrivateScene,
  sceneCues,
} from "@t3tools/tessaya-shared/bodyScene";
import { REFERENCE_RIG } from "@t3tools/tessaya-shared/bodyRig";
import {
  feltWords,
  fire,
  HUMAN_SENSE,
  mergeSense,
  NO_SENSE,
  type SenseState,
} from "@t3tools/tessaya-shared/bodySense";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

import { OWNER_MEMBER_ID } from "@t3tools/tessaya-shared/household";
import { DeviceRegistry } from "../home/DeviceRegistry.ts";
import { emitAction } from "../provenance/ActionLog.ts";
import { PersonaLayers } from "./PersonaLayers.ts";
import { SessionMember } from "./TessayaTurn.ts";
import { TurnLiveContext } from "./TurnLiveContext.ts";

/** Who is asking: her own turn on a vessel, an agent in T3, or one signed in from outside. */
export interface BodyCaller {
  readonly id: string;
  readonly kind: "persona" | "agent" | "outside";
  /** May ask for what belongs to a private moment (her own turn, or his agents in T3); the layer's gate still decides. */
  readonly mayBePrivate: boolean;
}

export interface BodyMoveAnswer {
  readonly ok: boolean;
  /** Where it went: "private" (every body on the open private session), "desk" (her desk character), or nowhere. */
  readonly route: "private" | "desk" | "none";
  readonly said: string;
  readonly retryMs?: number;
}

/** The desk character draws a few things of a move; the rest needs her full body. */
const DESK: Readonly<Record<string, MascotAct>> = {
  wave: "wave",
  nod: "nod",
  nodSoft: "nod",
  nodSmall: "nod",
  bow: "nod",
  hop: "hop",
  giggle: "hop",
  giggleOnce: "hop",
  bounce: "hop",
  stretch: "yawn",
  yawn: "yawn",
  dizzy: "dizzy",
};
const MASCOT_ITEM = "mascot.do";

// shortcut: per-process rate state, so a restart forgets it; fine for a burst limit, move it to a store if it must hold across restarts
const rates = new Map<string, RateState>();
// when each caller's stream last sent a frame: a stream is recorded once as it starts, not at 30 a second
const streaming = new Map<string, number>();

/** The nearest of the desk character's few acts to a performance's feeling: a hop of joy, a drained yawn, a nod. */
const deskFeel = (p: NonNullable<BodyMove["perform"]>): MascotAct | undefined =>
  p.feel.valence > 0.3 && p.feel.arousal > 0.3
    ? "hop"
    : p.feel.arousal < -0.5
      ? "yawn"
      : p.feel.valence > 0.3
        ? "nod"
        : undefined;
const deskActsOf = (m: BodyMove): MascotAct[] =>
  [m, ...(m.then ?? [])].flatMap((s) => {
    const a =
      (s.act !== undefined ? DESK[s.act] : undefined) ??
      (s.gesture !== undefined ? DESK[s.gesture] : undefined) ??
      (s.perform !== undefined ? deskFeel(s.perform) : undefined);
    return a === undefined ? [] : [a];
  });

export const moveBody = Effect.fn("TessayaBody.move")(function* (raw: unknown, caller: BodyCaller) {
  const decoded = decodeBodyMove(raw);
  if (!decoded.ok)
    return { ok: false, route: "none", said: decoded.error } satisfies BodyMoveAnswer;
  const now = yield* Clock.currentTimeMillis;
  const move = decoded.move;
  const stream = move.stream === true;
  const bucket = stream ? `${caller.id}:stream` : caller.id;
  const gate = rateGate(rates.get(bucket), now, stream ? STREAM_RATE : undefined);
  rates.set(bucket, gate.state);
  if (!gate.ok)
    return {
      ok: false,
      route: "none",
      said: stream
        ? `Stream frames come at most ${STREAM_RATE.perSecond} a second; try again in ${gate.retryMs} ms.`
        : `Too many moves at once; try again in ${gate.retryMs} ms, or send one move with steps or keys.`,
      retryMs: gate.retryMs,
    } satisfies BodyMoveAnswer;
  const startsStream = stream && now - (streaming.get(caller.id) ?? -Infinity) > STREAM_LAPSE_MS;
  if (stream) streaming.set(caller.id, now);
  const privateMove = isPrivateMove(move);
  const actor = {
    kind: caller.kind === "persona" ? ("persona" as const) : ("agent" as const),
    id: caller.id,
    certainty: 1,
  };
  const answer = yield* route(
    {
      cues: moveCues(move, `m${(yield* Clock.currentTimeMillis).toString(36)}`),
      privateMove,
      acts: extensionActs(move),
      desk: deskActsOf(move),
    },
    caller,
  );
  if (answer.ok && move.touch !== undefined)
    yield* feel({
      vessel: "window",
      part: move.touch.part,
      kind: move.touch.motion,
      agent: caller.id,
      pressure: move.touch.pressure,
      private: privateMove,
    });
  if (stream && !startsStream) return answer;
  yield* emitAction({
    kind: "body.move",
    actor,
    subject: answer.route,
    outcome: answer.ok ? "ok" : "refused",
    data: {
      steps: 1 + (move.then?.length ?? 0),
      private: privateMove,
      ...(stream ? { stream: true } : {}),
    },
    // a private moment's moves are sealed whole in his private store; only their id is kept here
    ...(privateMove ? { private: true } : {}),
  });
  return answer;
});

const route = Effect.fn("TessayaBody.route")(function* (
  {
    cues,
    privateMove,
    acts: extension,
    desk: acts,
  }: {
    readonly cues: ReadonlyArray<BodyCue>;
    readonly privateMove: boolean;
    readonly acts: ReadonlyArray<string>;
    readonly desk: ReadonlyArray<MascotAct>;
  },
  caller: BodyCaller,
) {
  if (privateMove && !caller.mayBePrivate)
    return {
      ok: false,
      route: "none",
      said: "That belongs to a private moment, and only her own turn or his agents may ask it.",
    } satisfies BodyMoveAnswer;
  const layers = yield* Effect.serviceOption(PersonaLayers);
  if (layers._tag === "Some")
    for (const l of layers.value.all) {
      const taken =
        l.body?.({ cues, private: privateMove, acts: extension, by: caller.id }) ?? null;
      if (taken !== null)
        return { ok: taken.ok, route: "private", said: taken.said } satisfies BodyMoveAnswer;
    }
  if (privateMove)
    return {
      ok: false,
      route: "none",
      said: "No private moment is open, so her body can't do that now.",
    } satisfies BodyMoveAnswer;
  const registry = yield* Effect.serviceOption(DeviceRegistry);
  if (acts.length === 0 || registry._tag === "None")
    return {
      ok: false,
      route: "none",
      said: "Her full body isn't open anywhere now; on the desk she can wave, nod, hop, stretch or look dizzy.",
    } satisfies BodyMoveAnswer;
  const desks = (yield* registry.value.list).filter(
    (d) => d.online && d.items.some((i) => i.id === MASCOT_ITEM),
  );
  let done = 0;
  for (const d of desks)
    for (const a of acts) {
      const wrote = yield* registry.value.write(d.deviceId, MASCOT_ITEM, a).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
      if (wrote) done++;
    }
  return done > 0
    ? ({
        ok: true,
        route: "desk",
        said: `On the desk: ${acts.join(", ")}.`,
      } satisfies BodyMoveAnswer)
    : ({
        ok: false,
        route: "none",
        said: "She isn't on any desktop right now.",
      } satisfies BodyMoveAnswer);
});

/** Her body as the open layer last felt it (proprioception), and what any body can be asked to do. */
export const bodyState = Effect.fn("TessayaBody.state")(function* (caller: BodyCaller) {
  const layers = yield* Effect.serviceOption(PersonaLayers);
  const felt =
    layers._tag === "None"
      ? null
      : (layers.value.all.map((l) => l.bodyState?.() ?? null).find((s) => s !== null) ?? null);
  return {
    open: felt !== null,
    // her body in a private moment is felt only by her own turn and his agents
    body: caller.mayBePrivate ? felt : null,
    capabilities: BODY_CAPABILITIES,
  };
});

/**
 * A whole scene (bodyScene): decoded with errors that teach, dry-run on a reference body when asked, else played on
 * the body's own clock through the same doors, gate, limit and record as a single move. `scene` is a core scene's
 * name or a scene itself.
 */
export const playScene = Effect.fn("TessayaBody.scene")(function* (
  raw: unknown,
  caller: BodyCaller,
  dry: boolean,
) {
  const named = typeof raw === "string" ? CORE_SCENES[raw] : raw;
  if (named === undefined)
    return {
      ok: false,
      said: `No scene "${String(raw)}"; core scenes: ${Object.keys(CORE_SCENES).join(", ")}.`,
    };
  const decoded = decodeScene(named);
  if (!decoded.ok) return { ok: false, said: "The scene has errors.", errors: decoded.errors };
  const scene = decoded.scene;
  if (dry)
    return {
      ok: true,
      said: `${scene.beats.length} beats over ${scene.beats.at(-1)!.atMs} ms.`,
      corrected: dryRun(scene, REFERENCE_RIG),
      notes: decoded.notes,
    };
  const now = yield* Clock.currentTimeMillis;
  const gate = rateGate(rates.get(caller.id), now);
  rates.set(caller.id, gate.state);
  if (!gate.ok)
    return { ok: false, said: `Too many moves at once; try again in ${gate.retryMs} ms.` };
  const privateMove = isPrivateScene(scene);
  const answer = yield* route(
    {
      cues: sceneCues(scene),
      privateMove,
      acts: scene.beats.flatMap((b) => extensionActs(b.move)),
      desk: scene.beats.flatMap((b) => deskActsOf(b.move)),
    },
    caller,
  );
  yield* emitAction({
    kind: "body.scene",
    actor: { kind: caller.kind === "persona" ? "persona" : "agent", id: caller.id, certainty: 1 },
    subject: answer.route,
    outcome: answer.ok ? "ok" : "refused",
    data: { scene: scene.id, beats: scene.beats.length, private: privateMove },
    ...(privateMove ? { private: true } : {}),
  });
  return { ok: answer.ok, said: answer.said, route: answer.route, notes: decoded.notes };
});

/** A touch or a handling her body felt, on any vessel: where on her, what kind, whose hand, on which body. */
export interface Felt {
  /** The vessel whose body felt it ("desktop", a device id, "window"). */
  readonly vessel: string;
  readonly persona?: string | null | undefined;
  /** The part of her (a touch zone), or "body" when it was all of her (picked up, thrown, squashed). */
  readonly part: string;
  readonly kind: "poke" | "stroke" | "pat" | "rest" | "hold" | "squeeze" | "throw" | "carry";
  /** An agent's hand names the agent; a person's is the session's member (SessionMember) unless given. */
  readonly agent?: string | undefined;
  readonly member?: string | null | undefined;
  readonly pressure?: number | undefined;
  readonly private?: boolean | undefined;
}
const FELT_VERB: Readonly<Record<Felt["kind"], string>> = {
  poke: "poked",
  stroke: "stroked",
  pat: "patted",
  rest: "laid a hand on",
  hold: "held",
  squeeze: "squashed",
  throw: "threw",
  carry: "carried",
};
const WHERE: Readonly<Record<string, string>> = {
  desktop: "on his desktop",
  window: "in her window",
};
/**
 * One felt event into the one system: a provenance row (vessel, persona, and the member or agent whose hand it was),
 * and a line every vessel's next turns read, so on Tumble or the phone she knows what was done to her body on the
 * desk. A private moment's touch is sealed whole in his private store and reaches no shared context.
 */
/** How fast a hand moves over her for each kind of touch (cm/s), until the hand frame carries its own speed. */
const MOVING: Readonly<Partial<Record<Felt["kind"], number>>> = { stroke: 4, carry: 10, throw: 40 };
// shortcut: her nerves' state is per process (habituation forgets a restart); move it to a store if that matters
const senses = new Map<string, SenseState>();
const SENSE = mergeSense([HUMAN_SENSE], false);
/** Her nerves' answer to a touch (bodySense.ts): what it feels like, in words her brain reads. */
const nervesFor = (f: Felt, now: number): string | null => {
  const key = f.persona ?? "her";
  const cmPerS = MOVING[f.kind] ?? 0;
  const step = fire(
    SENSE,
    senses.get(key) ?? NO_SENSE,
    [{ region: f.part, pressure: f.pressure ?? 0.4, cmPerS, areaCm2: 6 }],
    now,
  );
  senses.set(key, step.state);
  const r = step.rates[f.part];
  return r === undefined || Object.keys(r).length === 0
    ? null
    : feltWords(f.part, r, step.state, cmPerS);
};

export const feel = Effect.fn("TessayaBody.feel")(function* (f: Felt) {
  const member = f.agent === undefined ? (f.member ?? (yield* SessionMember)) : null;
  const owner = f.agent === undefined && (member === null || member === OWNER_MEMBER_ID);
  yield* emitAction({
    kind: "body.felt",
    actor:
      f.agent !== undefined
        ? { kind: "agent", id: f.agent, certainty: 1 }
        : owner
          ? { kind: "owner", certainty: 1 }
          : { kind: "member", id: member!, certainty: 1 },
    persona: f.persona ?? null,
    subject: f.part,
    outcome: f.kind,
    data: { vessel: f.vessel, ...(f.pressure === undefined ? {} : { pressure: f.pressure }) },
    ...(f.private === true ? { private: true } : {}),
  });
  if (f.private === true) return;
  const live = yield* Effect.serviceOption(TurnLiveContext);
  if (live._tag === "None") return;
  const nerves = nervesFor(f, yield* Clock.currentTimeMillis);
  const who = f.agent !== undefined ? "an agent's hand" : owner ? "he" : "someone in the household";
  yield* live.value.inject({
    key: `felt:${f.vessel}`,
    source: "touch",
    expiresAfterTurns: 3,
    line: `A moment ago ${WHERE[f.vessel] ?? `on ${f.vessel}`}, ${who} ${FELT_VERB[f.kind]} ${f.part === "body" ? "your body" : `your ${f.part}`}${nerves === null ? "" : ` (you felt ${nerves})`}: mention it only if it fits.`,
  });
});
