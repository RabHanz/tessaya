/**
 * Her body, moved and felt by her brain and permitted agents (M-065): moves are bounded, rate-limited, recorded, then
 * taken by her full body wherever the layer shows one, public or private, else by her desk character as it can.
 * A private moment's move goes nowhere but a private moment's body.
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
  type BodyScene,
} from "@t3tools/tessaya-shared/bodyScene";
import { REFERENCE_RIG } from "@t3tools/tessaya-shared/bodyRig";
import {
  feltTone,
  feltWords,
  fire,
  HUMAN_SENSE,
  mergeSense,
  NO_SENSE,
  type SenseState,
} from "@t3tools/tessaya-shared/bodySense";
import {
  holderOf,
  mayDrive,
  nextFocus,
  REST,
  type Focus,
  type FocusEvent,
  type PresenceSignal,
} from "@t3tools/tessaya-shared/bodyFocus";
import { chooseWant, wantMove, type Want } from "@t3tools/tessaya-shared/motives";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Option from "effect/Option";

import { OWNER_MEMBER_ID } from "@t3tools/tessaya-shared/household";
import { DeviceRegistry } from "../home/DeviceRegistry.ts";
import { emitAction } from "../provenance/ActionLog.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { resolveIntents } from "./bodyIntents.ts";
import { isBrain } from "./BrainHost.ts";
import { PersonaLayers } from "./PersonaLayers.ts";
import { SessionMember, TessayaTurn } from "./TessayaTurn.ts";
import { TessayaMood } from "./TessayaMood.ts";
import { TurnLiveContext } from "./TurnLiveContext.ts";

/** Who is asking: her own turn on a vessel, an agent in T3, or one signed in from outside. */
export interface BodyCaller {
  readonly id: string;
  readonly kind: "persona" | "agent" | "outside";
  /** May ask for what belongs to a private moment (her own turn, or his agents in T3); the layer's gate still decides. */
  readonly mayBePrivate: boolean;
  /** The conversation asking (a LiveThread's id, or a T3 thread's), which body focus weighs; its id when absent. */
  readonly thread?: string | undefined;
  /** How he is present in that thread: his voice on a Tessel, his typing elsewhere, his own hand on an agent. */
  readonly signal?: PresenceSignal | undefined;
  /** The persona whose body this moves: on a desktop with a crew, her own body there when she has one. */
  readonly persona?: string | undefined;
}

export interface BodyMoveAnswer {
  readonly ok: boolean;
  /** Where it went: her full body ("body", or "private" for a private moment's move), her desk character, a playground's sandbox body, or nowhere. */
  readonly route: "body" | "private" | "desk" | "playground" | "none";
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

// Which conversation drives her body (bodyFocus.ts). shortcut: one body for his desk, per process; a crew's bodies get
// their own keys with rooms (architecture step 8), and a restart starts her at rest.
const DESK_BODY = "desk";
const focus = new Map<string, Focus>();
const liveId = (t: { persona: string | null; conversation: string; tier: string }) =>
  `${t.persona ?? ""}|${t.conversation}${t.tier === "private" ? "|private" : ""}`;
const isPrivateThread = (id: string | null) => id?.endsWith("|private") === true;

/**
 * One event on a body's focus: recorded as `body.focus` when its holder changes, and the thread that takes it hears
 * once where she just was (its gist, or only that it was a private moment).
 */
const moveFocus = Effect.fn("TessayaBody.focus")(function* (key: string, e: FocusEvent) {
  const step = nextFocus(focus.get(key) ?? REST, e);
  focus.set(key, step.focus);
  const h = step.handover;
  if (h === null) return step;
  yield* emitAction({
    kind: "body.focus",
    actor: { kind: "rule", id: "bodyFocus", certainty: 1 },
    subject: key,
    outcome: h.reason,
    data: { from: h.from, to: h.to, event: e.kind },
    ...(isPrivateThread(h.from) || isPrivateThread(h.to) ? { private: true } : {}),
  });
  const turn = yield* Effect.serviceOption(TessayaTurn);
  const live = yield* Effect.serviceOption(TurnLiveContext);
  if (h.from === null || h.to === null || Option.isNone(turn) || Option.isNone(live)) return step;
  const threads = yield* turn.value.threads();
  const was = threads.find((t) => liveId(t) === h.from);
  const now = threads.find((t) => liveId(t) === h.to);
  // Only his own threads hear where she was: a member's never learns of his private moment or his topics.
  if (was === undefined || now === undefined || now.person !== OWNER_MEMBER_ID) return step;
  yield* live.value.inject({
    key: `focus:${h.to}`,
    source: "body",
    vessel: now.vessel.id,
    expiresAfterTurns: 1,
    line:
      was.tier === "private"
        ? `You were just with him in a private moment; say nothing of it here.`
        : `You were just with him${was.gist === null ? "" : ` in "${was.gist}"`} on ${was.surface === "voice" ? "a Tessel" : `the ${was.surface}`}: carry on here without starting over.`,
  });
  return step;
});

/** The thread a caller moves her from, weighed when he was last present in it (not when its reply came). */
const presenceOf = Effect.fn("TessayaBody.presence")(function* (caller: BodyCaller, now: number) {
  const thread = caller.thread ?? caller.id;
  const turn = yield* Effect.serviceOption(TessayaTurn);
  const row =
    caller.kind === "persona" && Option.isSome(turn)
      ? (yield* turn.value.threads()).find((t) => liveId(t) === thread)
      : undefined;
  return {
    kind: "presence" as const,
    thread,
    signal: caller.signal ?? "type",
    at: row?.presentAt ?? now,
  };
});

/** He spoke over her or said a stop word on a vessel: a scene on her body pauses, and his next thread takes it. */
export const interruptBody = Effect.fn("TessayaBody.interrupt")(function* () {
  yield* moveFocus(DESK_BODY, { kind: "interrupt", at: yield* Clock.currentTimeMillis });
});

/** The scene each thread last played on her desk body, so "carry on" plays the rest of it. */
const played = new Map<string, { readonly scene: BodyScene; readonly caller: BodyCaller }>();
const CARRY_ON = /^\s*(?:ok(?:ay)?,?\s+)?(?:carry on|keep going|go on|continue)\b[\s.!]*$/i;

/**
 * "Carry on": a scene he paused plays again from where it stopped, on its own thread's body. True when it resumed;
 * any other sentence, or nothing paused, leaves her as she is.
 */
export const resumeBody = Effect.fn("TessayaBody.resume")(function* (said: string) {
  const f = focus.get(DESK_BODY) ?? REST;
  if (f.state !== "paused" || !CARRY_ON.test(said)) return false;
  const step = yield* moveFocus(DESK_BODY, { kind: "resume", at: yield* Clock.currentTimeMillis });
  if (step.focus.state !== "scene") return false;
  const was = played.get(f.thread);
  if (was === undefined) return true;
  const from = (was.scene.beats.at(-1)?.atMs ?? 0) - f.left;
  const rest = was.scene.beats
    .filter((b) => b.atMs >= from)
    .map((b) => ({ ...b, atMs: b.atMs - from }));
  yield* route(
    {
      cues: sceneCues(was.scene, undefined, rest),
      privateMove: isPrivateScene(was.scene),
      acts: rest.flatMap((b) => extensionActs(b.move)),
      desk: rest.flatMap((b) => deskActsOf(b.move)),
    },
    was.caller,
  );
  return true;
});

/** His screen locked or a private lease ended: a private thread loses her body at once. */
export const privateBodyEnded = Effect.fn("TessayaBody.privateEnded")(function* () {
  const f = focus.get(DESK_BODY) ?? REST;
  const held = f.state === "rest" ? [] : f.state === "paused" ? [f.thread, f.engaged] : [f.thread];
  yield* moveFocus(DESK_BODY, {
    kind: "privateEnd",
    threads: held.filter((t): t is string => isPrivateThread(t)),
    at: yield* Clock.currentTimeMillis,
  });
});

/**
 * "Who has her body?": which of his conversations her desk body is with now, for his own ask (tessaya_cast who). A
 * private one is only "a private moment", never what it is about.
 */
export const bodyHolderLine = Effect.fn("TessayaBody.holderLine")(function* () {
  const f = focus.get(DESK_BODY) ?? REST;
  const holder = holderOf(f);
  const held =
    f.state === "scene"
      ? " (a scene is playing)"
      : f.state === "paused"
        ? " (a scene is paused)"
        : "";
  if (holder === null)
    return f.state === "paused"
      ? "Her desk body is free; a scene waits paused."
      : "Her desk body is free: no conversation holds it.";
  if (!holder.includes("|")) return `Her desk body is with one of his agents${held}.`;
  const turn = yield* Effect.serviceOption(TessayaTurn);
  const row = Option.isNone(turn)
    ? undefined
    : (yield* turn.value.threads()).find((t) => liveId(t) === holder);
  const what =
    row === undefined
      ? "a conversation that has gone quiet"
      : row.tier === "private"
        ? "a private moment"
        : row.gist !== null
          ? `the conversation about "${row.gist}" on ${row.surface === "voice" ? "a Tessel" : `the ${row.surface}`}`
          : `his conversation on ${row.surface === "voice" ? "a Tessel" : `the ${row.surface}`}`;
  return `Her desk body is with ${what}${held}.`;
});

// What the desk last said of her world: a full-screen app in front, and when a call was last seen. shortcut: per
// process and one desk; a second desktop's report overwrites the first's.
let deskWorld: { fullscreen: boolean; fullscreenAt: number; callAt: number; openedAt: number } = {
  fullscreen: false,
  fullscreenAt: 0,
  callAt: 0,
  openedAt: 0,
};
/** A full-screen report goes stale after this; a call keeps her resting this long after it was last seen. */
const WORLD_FRESH_MS = 30_000;
const CALL_REST_MS = 2 * 60_000;
export const noteDeskWorld = Effect.fn("TessayaBody.deskWorld")(function* (w: {
  readonly fullscreen?: boolean;
  readonly call?: boolean;
  readonly opened?: boolean;
}) {
  const now = yield* Clock.currentTimeMillis;
  deskWorld = {
    fullscreen: w.fullscreen ?? deskWorld.fullscreen,
    fullscreenAt: w.fullscreen === undefined ? deskWorld.fullscreenAt : now,
    callAt: w.call === true ? now : deskWorld.callAt,
    openedAt: w.opened === true ? now : deskWorld.openedAt,
  };
  // something new on her world is a wish to consider now, not at the next minute
  if (w.opened === true) yield* wishTick().pipe(Effect.ignore);
});
const himAtDesk = (now: number, home: boolean): "working" | "away" | "fullscreen" | "call" =>
  now - deskWorld.callAt < CALL_REST_MS
    ? "call"
    : deskWorld.fullscreen && now - deskWorld.fullscreenAt < WORLD_FRESH_MS
      ? "fullscreen"
      : home
        ? "working"
        : "away";

// When each Tessel was last picked up, moved or touched (Tumble's world, M-087). shortcut: per process.
const tesselHandled = new Map<string, number>();
export const noteTesselHandled = Effect.fn("TessayaBody.tesselHandled")(function* (device: string) {
  tesselHandled.set(device, yield* Clock.currentTimeMillis);
});
export const tesselHandledAt = (device: string): number | null => tesselHandled.get(device) ?? null;

/** Her own wishes (motives.ts) move her body only through body focus, as its weakest caller. */
const SELF: BodyCaller = {
  id: "self",
  kind: "persona",
  mayBePrivate: false,
  thread: "self",
  signal: "look",
};
// shortcut: her last wish per process, so a restart may let one come sooner; fine for a minute-scale rhythm
let lastWish: { readonly want: Want; readonly at: number } | null = null;

/**
 * One beat of her own life (M-087): only while no conversation holds her desk body, her mood toward him, when he was
 * last with her and whether he is at his desk choose a wish, which her body does and the record keeps with its why.
 * shortcut: no world feed yet (new windows, full-screen, calls), so "nothing happened" means he hasn't been with her;
 * the desktop's world cue replaces it. Its dial is `tessayaLiveliness`.
 */
export const wishTick = Effect.fn("TessayaBody.wish")(function* () {
  const now = yield* Clock.currentTimeMillis;
  const step = yield* moveFocus(DESK_BODY, { kind: "tick", at: now });
  if (step.focus.state !== "rest") return null;
  const turn = yield* Effect.serviceOption(TessayaTurn);
  const mood = yield* Effect.serviceOption(TessayaMood);
  if (Option.isNone(turn) || Option.isNone(mood)) return null;
  const mine = (yield* turn.value.threads()).filter((t) => t.person === OWNER_MEMBER_ID);
  const himAt = mine.reduce<number | null>(
    (at, t) => Math.max(at ?? 0, t.presentAt ?? 0) || at,
    null,
  );
  const owner = (yield* turn.value.whoIsHome).find((p) => p.member === OWNER_MEMBER_ID);
  const view = yield* mood.value.view(undefined, undefined, OWNER_MEMBER_ID);
  const settings = yield* Effect.serviceOption(ServerSettingsService);
  const liveliness = Option.isNone(settings)
    ? "calm"
    : yield* settings.value.getSettings.pipe(
        Effect.map((s) => s.tessayaLiveliness),
        Effect.orElseSucceed(() => "calm" as const),
      );
  const wish = chooseWant({
    now,
    liveliness,
    mood: { label: view.label, intensity: view.intensity, energy: view.energy },
    him: himAtDesk(now, owner?.likelyHome === true),
    himAt,
    worldAt: Math.max(himAt ?? 0, deskWorld.openedAt) || now,
    newThingAt: deskWorld.openedAt === 0 ? null : deskWorld.openedAt,
    last: lastWish,
  });
  if (wish === null) return null;
  lastWish = { want: wish.want, at: now };
  const answer = yield* moveBody(wantMove(wish.want), SELF);
  yield* emitAction({
    kind: "body.want",
    actor: { kind: "rule", id: "motives", certainty: 1 },
    subject: wish.want,
    outcome: answer.ok ? "ok" : "refused",
    data: { why: wish.why, route: answer.route },
  });
  return wish;
});

/**
 * Her own life's beat, once a minute: on the brain (one self, so one wish, not one per server), and where a layer
 * shows her full body. shortcut: a desktop linked to both may see a wish's desk act twice; move to the brain alone
 * once its moves reach the layer's body.
 */
export const wishLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const layers = yield* Effect.serviceOption(PersonaLayers);
    const here = (yield* isBrain) || (layers._tag === "Some" && layers.value.all.length > 0);
    if (here) yield* wishTick();
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("her wish failed", cause)),
    Effect.repeat(Schedule.spaced("1 minute")),
    Effect.delay("1 minute"),
    Effect.forkScoped,
  ),
);

/** "Let her be": no conversation holds her body until he is next present in one. */
export const restBody = Effect.fn("TessayaBody.rest")(function* () {
  focus.set(DESK_BODY, REST);
});

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
  // a weaker model's intent finds its library motion by meaning, not only by shared words
  const decoded = decodeBodyMove(yield* resolveIntents(raw));
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
  // A conversation he is not in now never mixes into the one he is: refused with who has her, not queued.
  const present = yield* moveFocus(DESK_BODY, yield* presenceOf(caller, now));
  if (!mayDrive(present.focus, caller.thread ?? caller.id))
    return {
      ok: false,
      route: "none",
      said: "Her body is with another conversation he is in now; try again when it is free.",
    } satisfies BodyMoveAnswer;
  const startsStream = stream && now - (streaming.get(caller.id) ?? -Infinity) > STREAM_LAPSE_MS;
  if (stream) streaming.set(caller.id, now);
  const privateMove = isPrivateMove(move);
  const actor = {
    kind: caller.kind === "persona" ? ("persona" as const) : ("agent" as const),
    id: caller.id,
    certainty: 1,
  };
  // her hand aimed at another persona's body (body to body, §2b.5): that one feels it, from her; her own body reaches
  const other =
    move.touch !== undefined &&
    move.toward?.kind === "persona" &&
    caller.persona !== undefined &&
    move.toward.id !== caller.persona
      ? move.toward.id
      : undefined;
  const { touch: _touch, ...reaching } = move;
  const answer = yield* route(
    {
      cues: moveCues(
        other === undefined ? move : reaching,
        `m${(yield* Clock.currentTimeMillis).toString(36)}`,
      ),
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
      ...(other === undefined ? { agent: caller.id } : { persona: other, by: caller.persona }),
      pressure: move.touch.pressure,
      // how far a grab pulls past what gives (bodyGrab.ts: ~5 cm of slack, a full pull at 12 cm)
      ...(move.touch.pull === undefined
        ? {}
        : { stretch: Math.min(1, Math.max(0, Math.hypot(...move.touch.pull) - 0.05) / 0.12) }),
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
        return {
          ok: taken.ok,
          route: privateMove ? "private" : "body",
          said: taken.said,
        } satisfies BodyMoveAnswer;
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
  // Her desk character on his own desktops only, never a member's.
  const desks = (yield* registry.value.list).filter(
    (d) =>
      d.online &&
      (d.member ?? OWNER_MEMBER_ID) === OWNER_MEMBER_ID &&
      d.items.some((i) => i.id === MASCOT_ITEM),
  );
  let done = 0;
  for (const d of desks) {
    // her own body in his desktop's crew, when the move is hers and she stands there
    const own = caller.persona === undefined ? undefined : `${MASCOT_ITEM}.${caller.persona}`;
    const item = own !== undefined && d.items.some((i) => i.id === own) ? own : MASCOT_ITEM;
    for (const a of acts) {
      const wrote = yield* registry.value.write(d.deviceId, item, a).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
      if (wrote) done++;
    }
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
  const thread = caller.thread ?? caller.id;
  const present = yield* moveFocus(DESK_BODY, yield* presenceOf(caller, now));
  const lease = mayDrive(present.focus, thread)
    ? yield* moveFocus(DESK_BODY, {
        kind: "sceneStart",
        thread,
        scene: scene.id,
        at: now,
        ms: scene.beats.at(-1)!.atMs,
      })
    : { refused: "another conversation he is in has her body" };
  if (lease.refused !== undefined)
    return {
      ok: false,
      said: `Not now: ${lease.refused}.`,
      route: "none" as const,
      notes: decoded.notes,
    };
  played.set(thread, { scene, caller });
  // the thread playing it is doing something, for her board ("playing the Dance scene")
  const turnSvc = yield* Effect.serviceOption(TessayaTurn);
  if (Option.isSome(turnSvc))
    yield* turnSvc.value.setDoing(thread, {
      what: `playing the ${scene.title} scene`,
      until: now + scene.beats.at(-1)!.atMs,
    });
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
  readonly kind:
    | "poke"
    | "stroke"
    | "pat"
    | "rest"
    | "hold"
    | "grab"
    | "squeeze"
    | "throw"
    | "carry";
  /** An agent's hand names the agent; a person's is the session's member (SessionMember) unless given. */
  readonly agent?: string | undefined;
  /** Another persona's hand, body to body (architecture §2b.5): her id. */
  readonly by?: string | undefined;
  readonly member?: string | null | undefined;
  readonly pressure?: number | undefined;
  /** From the hand frame when the body knows them: how fast it moved over her, over how much skin, how far it pulled. */
  readonly cmPerS?: number | undefined;
  readonly areaCm2?: number | undefined;
  readonly stretch?: number | undefined;
  readonly private?: boolean | undefined;
}
const FELT_VERB: Readonly<Record<Felt["kind"], string>> = {
  poke: "poked",
  stroke: "stroked",
  pat: "patted",
  rest: "laid a hand on",
  hold: "held",
  grab: "grabbed",
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
/** How fast a hand moves over her for each kind of touch (cm/s) when the body did not say (an agent's stroke is ~5). */
const MOVING: Readonly<Partial<Record<Felt["kind"], number>>> = { stroke: 5, carry: 10, throw: 40 };
// shortcut: her nerves' state is per process (habituation forgets a restart); move it to a store if that matters
const senses = new Map<string, SenseState>();
const SENSE = mergeSense([HUMAN_SENSE], false);
/**
 * Her nerves' answer to a touch (bodySense.ts): what it feels like, in words her brain reads, and its tone for her
 * mood. A region only a pack names (the body found it) is felt as everyday skin; all of her ("body") is not a touch.
 */
const nervesFor = (f: Felt, now: number) => {
  if (f.part === "body") return null;
  const key = f.persona ?? "her";
  const cmPerS = f.cmPerS ?? MOVING[f.kind] ?? 0;
  const map = SENSE.regions.has(f.part)
    ? SENSE
    : mergeSense(
        [
          HUMAN_SENSE,
          {
            version: 1,
            id: "felt",
            regions: [{ id: f.part, anchor: { bone: "spine" }, twoPointMm: 30, hairy: true }],
          },
        ],
        false,
      );
  const step = fire(
    map,
    senses.get(key) ?? NO_SENSE,
    [
      {
        region: f.part,
        pressure: f.pressure ?? 0.4,
        cmPerS,
        areaCm2: f.areaCm2 ?? 6,
        ...(f.stretch === undefined ? {} : { stretch: f.stretch }),
      },
    ],
    now,
  );
  senses.set(key, step.state);
  const r = step.rates[f.part];
  return r === undefined || Object.keys(r).length === 0
    ? null
    : { words: feltWords(f.part, r, step.state, cmPerS), tone: feltTone(r) };
};

export const feel = Effect.fn("TessayaBody.feel")(function* (f: Felt) {
  const hand = f.by ?? f.agent;
  const member = hand === undefined ? (f.member ?? (yield* SessionMember)) : null;
  const owner = hand === undefined && (member === null || member === OWNER_MEMBER_ID);
  yield* emitAction({
    kind: "body.felt",
    actor:
      f.by !== undefined
        ? { kind: "persona", id: f.by, certainty: 1 }
        : f.agent !== undefined
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
  const nerves = nervesFor(f, yield* Clock.currentTimeMillis);
  // how it felt moves her quick reaction (never her mood), keyed to whoever's hand it was
  const mood = yield* Effect.serviceOption(TessayaMood);
  if (nerves?.tone != null && mood._tag === "Some")
    yield* mood.value.note(f.persona ?? undefined, { kind: "felt", tone: nerves.tone }, member);
  const live = yield* Effect.serviceOption(TurnLiveContext);
  if (live._tag === "None") return;
  const who =
    f.by !== undefined
      ? `${f.by}'s hand`
      : f.agent !== undefined
        ? "an agent's hand"
        : owner
          ? "he"
          : "someone in the household";
  yield* live.value.inject({
    key: `felt:${f.vessel}`,
    ...(f.by === undefined ? {} : { persona: f.persona ?? undefined }),
    source: "touch",
    expiresAfterTurns: 3,
    line: `A moment ago ${WHERE[f.vessel] ?? `on ${f.vessel}`}, ${who} ${FELT_VERB[f.kind]} ${f.part === "body" ? "your body" : `your ${f.part}`}${nerves === null ? "" : ` (you felt ${nerves.words})`}: mention it only if it fits.`,
  });
});
