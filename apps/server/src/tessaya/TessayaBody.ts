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
  REFERENCE_RIG,
  decodeScene,
  dryRun,
  isPrivateScene,
  sceneCues,
} from "@t3tools/tessaya-shared/bodyScene";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

import { DeviceRegistry } from "../home/DeviceRegistry.ts";
import { emitAction } from "../provenance/ActionLog.ts";
import { PersonaLayers } from "./PersonaLayers.ts";

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

const deskActsOf = (m: BodyMove): MascotAct[] =>
  [m, ...(m.then ?? [])].flatMap((s) => {
    const a =
      (s.act !== undefined ? DESK[s.act] : undefined) ??
      (s.gesture !== undefined ? DESK[s.gesture] : undefined);
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
