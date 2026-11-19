/**
 * The body playground's sandbox buses (M-089): each open playground stage has one, and a move aimed at "playground"
 * goes onto it as cues, never through her body's route or body focus, so a test run never reaches her desk or takes
 * her from a conversation. The page long-polls its bus and reports its body state back. Everyday moves only.
 */
import {
  BODY_CAPABILITIES,
  decodeBodyMove,
  isPrivateMove,
  moveCues,
  rateGate,
  STREAM_RATE,
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
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { emitAction } from "../provenance/ActionLog.ts";
import type { BodyCaller, BodyMoveAnswer } from "./TessayaBody.ts";

const encodeJson = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const json = (v: unknown) => encodeJson(v).pipe(Effect.orElseSucceed(() => '{"closed":true}'));

export const BUS_ID = /^[a-z0-9][a-z0-9-]{3,39}$/;
const MAX_BUSES = 32;
const MAX_CUES = 64;
/** A bus nobody has polled for this long is gone; the page opens a new one when it comes back. */
const IDLE_MS = 10 * 60_000;
const MAX_WAIT_MS = 25_000;
/** A reported body state larger than this is dropped, not stored. */
const MAX_STATE_BYTES = 64_000;

interface Bus {
  readonly owner: string;
  seq: number;
  cues: Array<{ readonly seq: number; readonly cue: BodyCue }>;
  state: unknown;
  seenAt: number;
  wake: Deferred.Deferred<void>;
  /** Pages holding a push socket on it: never pruned for idling while one is open. */
  watchers: number;
}

// shortcut: per process and in memory; a restart closes every bus and its pages open new ones on their next poll
const buses = new Map<string, Bus>();
const rates = new Map<string, RateState>();

export const resetPlaygroundForTest = () => {
  buses.clear();
  rates.clear();
};

/** The bus a caller means: the one named, else the playground most recently open. */
const busFor = (id: string | undefined): readonly [string, Bus] | null => {
  if (id !== undefined) {
    const b = buses.get(id);
    return b === undefined ? null : [id, b];
  }
  let best: readonly [string, Bus] | null = null;
  for (const e of buses) if (best === null || e[1].seenAt > best[1].seenAt) best = e;
  return best;
};

const prune = (now: number) => {
  for (const [id, b] of buses) if (b.watchers === 0 && now - b.seenAt > IDLE_MS) buses.delete(id);
  while (buses.size >= MAX_BUSES) {
    const oldest = [...buses].reduce((a, b) =>
      b[1].watchers < a[1].watchers ||
      (b[1].watchers === a[1].watchers && b[1].seenAt < a[1].seenAt)
        ? b
        : a,
    );
    buses.delete(oldest[0]);
  }
};

/**
 * One poll from a playground page: opens its bus on the first, then answers with the cues after `after`, waiting up
 * to `waitMs` for one. Another session's bus answers closed.
 */
export const pollBus = Effect.fn("BodyPlayground.poll")(function* (input: {
  readonly bus: string;
  readonly owner: string;
  readonly after: number;
  readonly waitMs: number;
}) {
  if (!BUS_ID.test(input.bus)) return { closed: true, seq: 0, cues: [] };
  const now = yield* Clock.currentTimeMillis;
  let bus = buses.get(input.bus);
  if (bus === undefined) {
    prune(now);
    bus = {
      owner: input.owner,
      seq: 0,
      cues: [],
      state: null,
      seenAt: now,
      wake: Deferred.makeUnsafe<void>(),
      watchers: 0,
    };
    buses.set(input.bus, bus);
  }
  if (bus.owner !== input.owner) return { closed: true, seq: 0, cues: [] };
  bus.seenAt = now;
  // a page ahead of its bus (the server restarted) starts over from the bus's first cue
  const after = input.after > bus.seq ? 0 : input.after;
  const ready = () => bus.cues.filter((c) => c.seq > after);
  if (ready().length === 0 && input.waitMs > 0)
    yield* Deferred.await(bus.wake).pipe(Effect.timeoutOption(Math.min(MAX_WAIT_MS, input.waitMs)));
  bus.seenAt = yield* Clock.currentTimeMillis;
  return { closed: false, seq: bus.seq, cues: ready().map((c) => c.cue) };
});

/**
 * A page's bus as a push: each batch of cues written the moment it is published, nothing at all in between (no timer,
 * no poll), until the socket closes. Answers closed for another session's bus.
 */
export const watchBus = Effect.fn("BodyPlayground.watch")(function* <E>(
  input: { readonly bus: string; readonly owner: string },
  write: (text: string) => Effect.Effect<void, E>,
) {
  const first = yield* pollBus({ ...input, after: 0, waitMs: 0 });
  yield* write(yield* json(first));
  const bus = buses.get(input.bus);
  if (first.closed || bus === undefined) return;
  bus.watchers++;
  let after = first.seq;
  return yield* Effect.gen(function* () {
    while (true) {
      // published while the last write was going out: no wait, or those cues would sit until the next
      if (bus.seq === after) yield* Deferred.await(bus.wake);
      bus.seenAt = yield* Clock.currentTimeMillis;
      yield* write(
        yield* json({
          closed: false,
          seq: bus.seq,
          cues: bus.cues.filter((c) => c.seq > after).map((c) => c.cue),
        }),
      );
      after = bus.seq;
    }
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        bus.watchers--;
      }),
    ),
  );
});

/** What the page's body last reported of itself (bodyControl BodyState), for tessaya_body_state on the playground. */
export const reportBus = (input: {
  readonly bus: string;
  readonly owner: string;
  readonly state: unknown;
}): boolean => {
  const bus = buses.get(input.bus);
  if (bus === undefined || bus.owner !== input.owner) return false;
  if (JSON.stringify(input.state ?? null).length > MAX_STATE_BYTES) return false;
  bus.state = input.state;
  return true;
};

const publish = (bus: Bus, cues: ReadonlyArray<BodyCue>) => {
  for (const cue of cues) bus.cues.push({ seq: ++bus.seq, cue });
  if (bus.cues.length > MAX_CUES) bus.cues = bus.cues.slice(-MAX_CUES);
  const woken = bus.wake;
  bus.wake = Deferred.makeUnsafe<void>();
  Deferred.doneUnsafe(woken, Effect.void);
};

/** Which body a body tool call aims at; the tools' `target` and `playground` fields. */
export interface Aim {
  readonly target?: "playground" | "her";
  readonly playground?: string;
}
/** Outside agents test on the playground unless they ask for her; her own turns and his agents move her. */
export const onPlayground = (aim: Aim, caller: BodyCaller): boolean =>
  (aim.target ?? (caller.kind === "outside" ? "playground" : "her")) === "playground";

const NO_PLAYGROUND = "No playground is open. Open /tessaya/playground in a browser first.";
const EVERYDAY_ONLY = "The playground shows everyday moves only.";

const gate = Effect.fn("BodyPlayground.gate")(function* (caller: BodyCaller, stream: boolean) {
  const now = yield* Clock.currentTimeMillis;
  const key = stream ? `${caller.id}:stream` : caller.id;
  const g = rateGate(rates.get(key), now, stream ? STREAM_RATE : undefined);
  rates.set(key, g.state);
  return g;
});

const record = (kind: string, caller: BodyCaller, bus: string, ok: boolean, data: object) =>
  emitAction({
    kind,
    actor: { kind: caller.kind === "persona" ? "persona" : "agent", id: caller.id, certainty: 1 },
    subject: bus,
    outcome: ok ? "ok" : "refused",
    data: { target: "playground", ...data },
  });

/** A move on a playground's body: the same language, limits and record as on hers, on its bus only. */
export const movePlayground = Effect.fn("BodyPlayground.move")(function* (
  raw: unknown,
  caller: BodyCaller,
  busId?: string,
) {
  const decoded = decodeBodyMove(raw);
  if (!decoded.ok)
    return { ok: false, route: "none", said: decoded.error } satisfies BodyMoveAnswer;
  const move = decoded.move;
  if (isPrivateMove(move))
    return { ok: false, route: "none", said: EVERYDAY_ONLY } satisfies BodyMoveAnswer;
  const found = busFor(busId);
  if (found === null)
    return { ok: false, route: "none", said: NO_PLAYGROUND } satisfies BodyMoveAnswer;
  const stream = move.stream === true;
  const g = yield* gate(caller, stream);
  if (!g.ok)
    return {
      ok: false,
      route: "none",
      said: `Too many moves at once; try again in ${g.retryMs} ms.`,
      retryMs: g.retryMs,
    } satisfies BodyMoveAnswer;
  const [id, bus] = found;
  publish(bus, moveCues(move, `p${(yield* Clock.currentTimeMillis).toString(36)}`));
  if (!stream)
    yield* record("body.move", caller, id, true, { steps: 1 + (move.then?.length ?? 0) });
  return {
    ok: true,
    route: "playground",
    said: `On the playground ${id}.`,
  } satisfies BodyMoveAnswer;
});

/** A scene on a playground's body; a dry run never needs one open. */
export const scenePlayground = Effect.fn("BodyPlayground.scene")(function* (
  raw: unknown,
  caller: BodyCaller,
  dry: boolean,
  busId?: string,
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
  if (isPrivateScene(scene)) return { ok: false, said: EVERYDAY_ONLY, route: "none" as const };
  const found = busFor(busId);
  if (found === null) return { ok: false, said: NO_PLAYGROUND, route: "none" as const };
  const g = yield* gate(caller, false);
  if (!g.ok) return { ok: false, said: `Too many moves at once; try again in ${g.retryMs} ms.` };
  const [id, bus] = found;
  publish(bus, sceneCues(scene));
  yield* record("body.scene", caller, id, true, { scene: scene.id, beats: scene.beats.length });
  return {
    ok: true,
    said: `Playing ${scene.id} on the playground ${id}.`,
    route: "playground" as const,
    notes: decoded.notes,
  };
});

/** A playground body as its page last felt it, and what any body can be asked to do. */
export const statePlayground = (busId?: string) => {
  const found = busFor(busId);
  return {
    open: found !== null,
    ...(found === null ? {} : { playground: found[0] }),
    body: found?.[1].state ?? null,
    capabilities: BODY_CAPABILITIES,
  };
};
