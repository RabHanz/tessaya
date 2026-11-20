// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
/**
 * Her working mood, one row per persona: a general mood tied to no one and a relationship per person (a member, or a
 * stranger by people-graph id) with her opinion and their story, shaped by the persona's dials. Nothing that decides
 * what she may do reads this service (§7). Only her brain appraises (BrainHost); presence anywhere means he is not
 * away (B-044).
 */
import {
  DEFAULT_AFFECT_SETTINGS,
  affectDelta,
  appraiseFor,
  undoDelta,
  type AffectDelta,
  deviceOwnerOf,
  dialsOf,
  CLOSE_REASON,
  faceMemberAt,
  freshAffect,
  guiltOfDial,
  movePerson,
  personaAffectOf,
  personaRoomView,
  personaView,
  opinionContext,
  readPrompt,
  TurnRead,
  type AffectContext,
  type AffectEvent,
  type AffectView,
  type Dials,
  type PersonaAffect,
} from "@t3tools/tessaya-shared/affect";
import { OWNER_MEMBER_ID } from "@t3tools/tessaya-shared/household";
import { PRESENCE_BARS } from "@t3tools/tessaya-shared/presence";
import { DEFAULT_OS_PACK } from "@t3tools/tessaya-shared/osPack";
import * as NodePath from "node:path";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import { DeviceRegistry } from "../home/DeviceRegistry.ts";
import { makeBrainLink } from "./BrainHost.ts";
import { TessayaPresence } from "./TessayaPresence.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { readPack } from "./OperatingSystemPack.ts";
import { TessayaOneShot } from "./TessayaOneShot.ts";
import { TessayaPeople } from "./TessayaPeople.ts";
import { emitAction } from "./turnActions.ts";
import { AffectCause } from "./AffectCause.ts";
import * as Random from "effect/Random";

/** One person's row in Settings' inner state: how she feels toward them, why, her opinion and their story. */
interface InnerPerson {
  readonly member: string;
  readonly name: string;
  readonly view: AffectView;
}

export class TessayaMood extends Context.Service<
  TessayaMood,
  {
    /**
     * A persona's mood now (unset is the lead), on his clock; neutral with the setting off. With `member` (identified
     * now), their relationship over the general mood; without, the general mood alone.
     */
    readonly view: (
      persona: string | undefined,
      timeZone?: string,
      member?: string | null,
    ) => Effect.Effect<AffectView>;
    /** A room's mood: the general mood plus the people here, weighted by how sure presence is of each (MA-021). */
    readonly roomView: (
      persona: string | undefined,
      here: ReadonlyArray<{ readonly key: string; readonly weight: number }>,
      timeZone?: string,
    ) => Effect.Effect<AffectView>;
    /**
     * One typed event: the world's (an outcome, a job) to the general mood, a person's to `member`'s relationship.
     */
    readonly note: (
      persona: string | undefined,
      event: Exclude<AffectEvent, { kind: "his_turn" }>,
      member?: string | null,
    ) => Effect.Effect<void>;
    /**
     * The one cheap read of a turn (MA-021): how their words treat her, the talk's topic and how they seem, a joke or
     * milestone, and her opinion of them. With `member` null (a room), only the flow, into the general mood. True when
     * it showed something new about them (her opinion moved, or a shared moment): evidence for her understanding.
     */
    readonly hisWords: (
      persona: string | undefined,
      said: string,
      member: string | null,
      context?: {
        /** SenseVoice's label for this turn: their words agreeing ("low") confirm a care mode (MA-022's second signal). */
        readonly voice?: string | undefined;
        /** What was said just before, so the flow is read in context. */
        readonly before?: string | undefined;
      },
    ) => Effect.Effect<boolean>;
    /** One of a member's turns reached this persona: their time away resolves and their bond counts the day. */
    readonly heard: (
      persona: string | undefined,
      timeZone: string | undefined,
      member: string,
    ) => Effect.Effect<void>;
    /** A device's face at rest, from the one presence estimate: the one person there, the room, or its owner's. */
    readonly atDevice: (
      device: string,
      persona: string | undefined,
      timeZone?: string,
    ) => Effect.Effect<AffectView>;
    /** Settings' inner state: the general mood and one row per person; a member sees only their own, the owner all. */
    readonly inner: (
      persona: string | undefined,
      viewer: string | null,
      timeZone?: string,
    ) => Effect.Effect<{
      readonly general: AffectView;
      readonly people: ReadonlyArray<InnerPerson>;
      readonly dials: Dials;
    }>;
    /** Someone forgotten (no `into`) or found to be someone else: their relationship goes or moves, every persona. */
    readonly forget: (member: string, into?: string) => Effect.Effect<void>;
    /**
     * "That wasn't me" (the Director, 20 Nov): what events credited to `from` did to their relationship is taken back,
     * every persona, and given to `to` (null: someone else, nobody known). The events are one cause (`ref`), or those
     * on a vessel since a time. How many changes moved. One mechanism for turns, desk touches and a Tessel handled.
     */
    readonly reassign: (input: AffectMove) => Effect.Effect<number>;
    /** One person's relationship with a persona (her opinion, story and feeling) back to nothing. */
    readonly reset: (persona: string | undefined, member: string) => Effect.Effect<void>;
    /** Something moved a mood (a write, someone arrived or left a vessel), or a few minutes passed: faces read again. */
    readonly moves: Stream.Stream<void>;
    /** Her brain said her mood moved (a worker): its kept views go and every face here reads again now. */
    readonly refresh: Effect.Effect<void>;
    /** The faces a device showed at rest lately, newest first, each with whom it was for (M-094). */
    readonly facesOn: (device: string) => Effect.Effect<ReadonlyArray<ShownFace>>;
    /**
     * A persona's general mood each time it shows differently (its label, or its strength by a tenth): after each
     * event, and as time moves it, checked every few minutes only while someone listens.
     */
    readonly changes: (persona: string | undefined, timeZone?: string) => Stream.Stream<AffectView>;
  }
>()("t3/tessaya/TessayaMood") {}

/** One face a device showed at rest: its persona, mood and strength, and whom it was for (`AffectView.faceFor`). */
export interface ShownFace {
  readonly persona: string;
  readonly label: string;
  readonly intensity: number;
  readonly faceFor: string;
  /** A private moment is among why it shows: never named or hinted at to anyone else. */
  readonly private: boolean;
  readonly at: number;
}
/** How many of a device's last faces are kept, for "who was that face for" on the next turn. */
const FACES_KEPT = 4;
/** Which recorded changes `reassign` moves: by cause, or by vessel since a time (ms); always only `from`'s. */
export interface AffectMove {
  readonly from: string;
  readonly to: string | null;
  readonly ref?: string;
  readonly vessel?: string;
  readonly since?: number;
  /** Only what was assumed to be them (a desk touch), not what they were identified in. */
  readonly assumedOnly?: boolean;
  /** Who said it was not them (a member id), for the record. */
  readonly by?: string;
}

/** A ledger row's JSON, outside Effect code; a broken row reads as null and is skipped. */
const toJson = (v: unknown) => JSON.stringify(v);
const fromJson = <A>(raw: string): A | null => {
  try {
    return JSON.parse(raw) as A;
  } catch {
    return null;
  }
};

const LEAD = "executive";
/** How often a listener's mood is read again for what time alone changes (lonely builds over hours). */
const SWEEP = "5 minutes";

/** How often presence may refresh someone's time seen (one write a minute at most). */
const SEEN_EVERY_MS = 60_000;
const clockIn = (at: number, timeZone: string) => {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(at);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
    return {
      day: `${get("year")}-${get("month")}-${get("day")}`,
      hour: Number(get("hour")) + Number(get("minute")) / 60,
    };
  } catch {
    return { day: new Date(at).toISOString().slice(0, 10), hour: new Date(at).getUTCHours() };
  }
};

const decodeState = (json: string | null, at: number): PersonaAffect => {
  try {
    return personaAffectOf(json === null ? null : JSON.parse(json), at, OWNER_MEMBER_ID);
  } catch {
    return personaAffectOf(null, at, OWNER_MEMBER_ID);
  }
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const settings = yield* ServerSettingsService;
  const config = yield* Effect.serviceOption(ServerConfig.ServerConfig);
  const lock = yield* Semaphore.make(1);
  /** A write happened: listeners read the view again. */
  const moved = yield* PubSub.sliding<void>(1);
  const oneShot = yield* Effect.serviceOption(TessayaOneShot);
  const brain = yield* makeBrainLink;
  const people = yield* Effect.serviceOption(TessayaPeople);
  const pack = () =>
    Option.isNone(config) ? DEFAULT_OS_PACK : readPack(NodePath.dirname(config.value.dbPath));
  const personaOf = (id: string | undefined) => {
    const { personas } = pack();
    return personas.find((p) => p.id === id) ?? personas.find((p) => p.lead) ?? personas[0];
  };
  const moodSettings = settings.getSettings.pipe(
    Effect.map((s) => s.tessayaMood),
    Effect.orElseSucceed(() => DEFAULT_AFFECT_SETTINGS),
  );
  const dialsFor = (personaId: string | undefined, current: typeof DEFAULT_AFFECT_SETTINGS) => {
    const face = personaOf(personaId);
    const persona = face?.id ?? LEAD;
    return {
      persona,
      dials: dialsOf(persona, face?.guilt, current.personas?.[persona], face?.traits),
    };
  };

  // Off is also the reset: turned back on, every persona starts from its temperament, bonds included.
  const clear = sql`DELETE FROM tessaya_affect_state`.pipe(Effect.ignore);

  const read = Effect.fn("TessayaMood.read")(function* (persona: string, now: number) {
    const rows = yield* sql<{ state_json: string }>`
      SELECT state_json FROM tessaya_affect_state WHERE persona = ${persona}
    `.pipe(Effect.orElseSucceed(() => []));
    return decodeState(rows[0]?.state_json ?? null, now);
  });
  const write = (persona: string, state: PersonaAffect, reason: string, at: number) =>
    sql`
      INSERT INTO tessaya_affect_state (persona, state_json, reason, updated_at)
      VALUES (${persona}, ${JSON.stringify(state)}, ${reason}, ${new Date(at).toISOString()})
      ON CONFLICT (persona) DO UPDATE SET
        state_json = excluded.state_json, reason = excluded.reason, updated_at = excluded.updated_at
    `.pipe(
      Effect.tapError((e) => Effect.logWarning("mood: not saved", { persona, why: String(e) })),
      Effect.ignore,
    );

  const apply = Effect.fn("TessayaMood.apply")(function* (
    personaId: string | undefined,
    event: (day: string, dials: Dials) => AffectEvent,
    timeZone: string | undefined,
    member: string | null,
  ) {
    const current = yield* moodSettings;
    if (!current.enabled) return yield* clear;
    const { persona, dials } = dialsFor(personaId, current);
    const now = yield* Clock.currentTimeMillis;
    const { day } = clockIn(now, timeZone ?? "UTC");
    const resolved = event(day, dials);
    const cause = yield* AffectCause;
    // Only her brain appraises; a worker sends what it saw there (one-brain §2.1).
    if (!(yield* brain.isBrain)) {
      // never lost: queued for the brain when it can't be reached, applied there once
      yield* brain.sendOrQueue("mood", {
        p: persona,
        m: member,
        e: resolved,
        ...(cause === null ? {} : { r: cause }),
      });
      return;
    }
    yield* appraiseInto(persona, resolved, now, member, current.bondCap, dials.forgiveness, cause);
  });

  /** One event into a persona's row at its time (never before the row's own), as her brain heard it. */
  const appraiseInto = (
    persona: string,
    event: AffectEvent,
    at: number,
    member: string | null,
    bondCap: number,
    forgiveness: number,
    cause: typeof AffectCause.Service = null,
  ) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const state = yield* read(persona, at);
        const when = Math.max(at, state.general.at);
        const next = appraiseFor(state, event, when, bondCap, member, forgiveness);
        // A person's event with nobody identified moves nothing.
        if (next.reason === null) return null;
        yield* write(persona, next.state, next.reason, when);
        const theirs = member === null ? undefined : next.state.people[member];
        // What it did to them, against its cause, so "that wasn't me" can take it back.
        if (
          cause !== null &&
          member !== null &&
          theirs !== undefined &&
          theirs !== state.people[member]
        )
          yield* sql`
            INSERT INTO tessaya_affect_ledger (id, ref, vessel, persona, member, assumed, event_json, delta_json, at)
            VALUES (${`${cause.ref}#${when}-${yield* Random.nextIntBetween(0, 1e9)}`}, ${cause.ref},
              ${cause.vessel ?? null}, ${persona}, ${member}, ${cause.assumed === true ? 1 : 0},
              ${toJson(event)}, ${toJson(affectDelta(state.people[member], theirs, when))}, ${when})
          `.pipe(Effect.ignoreCause({ log: true }));
        yield* PubSub.publish(moved, undefined);
        return next.reason;
      }),
    );

  /** Someone presence places around her on any vessel, of his servers, is not away from her (B-044). */
  const seenByPresence = Effect.fn("TessayaMood.seenByPresence")(function* (
    persona: string,
    now: number,
    bondCap: number,
  ) {
    // Read per call: the presence store is a sibling of this layer, not under it.
    const presence = yield* Effect.serviceOption(TessayaPresence);
    if (Option.isNone(presence)) return;
    const state = yield* read(persona, now);
    const around = (yield* presence.value.estimate()).members.filter(
      (m) => !m.guest && m.confidence >= PRESENCE_BARS.around,
    );
    for (const m of around) {
      const seenAt = state.people[m.member]?.seenAt ?? null;
      if (seenAt !== null && now - seenAt >= SEEN_EVERY_MS)
        yield* appraiseInto(persona, { kind: "seen" }, now, m.member, bondCap, 1);
    }
  });

  const readNow = Effect.fn("TessayaMood.readNow")(function* (
    personaId: string | undefined,
    timeZone: string | undefined,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const current = yield* moodSettings;
    if (!current.enabled) yield* clear;
    const { persona, dials } = dialsFor(personaId, current);
    if (current.enabled) yield* seenByPresence(persona, now, current.bondCap);
    const ctx: AffectContext = {
      now,
      hour: clockIn(now, timeZone ?? "UTC").hour,
      guilt: guiltOfDial(dials.guiltTrips),
      settings: current,
      dials,
    };
    return { persona, state: yield* read(persona, now), ctx };
  });

  // shortcut: a worker's views of the brain's mood, kept 20 s, so a turn or a wish doesn't cost a hop each time
  const fromBrain = new Map<string, { readonly at: number; readonly view: AffectView }>();
  /**
   * One mood: only her brain holds it, so a worker (his laptop's server) shows the brain's view, not its own copy,
   * which nothing writes (a worker sends its events to the brain). None on the brain, or when the brain is not reached.
   */
  const brainView = Effect.fn("TessayaMood.brainView")(function* (ask: {
    readonly p: string | null;
    readonly m: string | null;
    readonly z: string | null;
    readonly d?: string;
  }) {
    if (yield* brain.isBrain) return Option.none<AffectView>();
    const now = yield* Clock.currentTimeMillis;
    const key = `${ask.p ?? ""}|${ask.m ?? ""}|${ask.z ?? ""}|${ask.d ?? ""}`;
    const kept = fromBrain.get(key);
    if (kept !== undefined && now - kept.at < 20_000) return Option.some(kept.view);
    const asked = yield* brain.send("moodView", ask);
    if (
      Option.isNone(asked) ||
      typeof asked.value !== "object" ||
      asked.value === null ||
      !("label" in asked.value)
    )
      return Option.none<AffectView>();
    const got = asked.value as AffectView;
    fromBrain.set(key, { at: now, view: got });
    return Option.some(got);
  });
  /** A device's face at rest and whom it is for (M-094): the brain's view on a worker, else read here. */
  const faceAt = Effect.fn("TessayaMood.faceAt")(function* (
    device: string,
    personaId: string | undefined,
    timeZone: string | undefined,
  ) {
    const theirs = yield* brainView({
      p: personaId ?? null,
      m: null,
      z: timeZone ?? null,
      d: device,
    });
    if (Option.isSome(theirs)) return theirs.value;

    const { persona, state, ctx } = yield* readNow(personaId, timeZone);
    const registry = yield* Effect.serviceOption(DeviceRegistry);
    const known = Option.isNone(registry)
      ? null
      : yield* registry.value.get(device).pipe(Effect.orElseSucceed(() => null));
    const owned = deviceOwnerOf(known, ctx.settings.devices?.[device], OWNER_MEMBER_ID);
    const presence = yield* Effect.serviceOption(TessayaPresence);
    const estimate = Option.isNone(presence)
      ? { members: [], occupied: new Map<string, number>() }
      : yield* presence.value.estimate();
    // shortcut: desktop turns note their vessel as "desktop", not the device; split when a second desktop matters.
    const vessels = known?.kind === "desktop" ? [device, "desktop"] : [device];
    const member = faceMemberAt({ ...owned, vessels, estimate });
    if (member !== null) return { ...personaView(state, persona, ctx, member), faceFor: member };
    // Several people placed here: the room's mood, weighted by how sure presence is of each.
    const at = new Set(vessels);
    const here = estimate.members.flatMap((m) =>
      m.nearest !== null && at.has(m.nearest.vessel) && m.nearest.confidence >= PRESENCE_BARS.around
        ? [{ key: m.member, weight: m.nearest.confidence }]
        : [],
    );
    return here.length > 1
      ? { ...personaRoomView(state, persona, ctx, here), faceFor: "room" }
      : { ...personaView(state, persona, ctx, null), faceFor: "general" };
  });
  // shortcut: in this server's memory; a restart forgets what the faces were for, and the next turn says nothing of it.
  const faces = new Map<string, ReadonlyArray<ShownFace>>();
  /** Each face a device shows, with whom it is for: kept for the next turn there, and on the spine when it changes. */
  const shown = Effect.fn("TessayaMood.shown")(function* (
    device: string,
    persona: string,
    view: AffectView,
  ) {
    const faceFor = view.faceFor ?? "general";
    const last = faces.get(device)?.[0];
    if (
      last !== undefined &&
      last.persona === persona &&
      last.label === view.label &&
      last.faceFor === faceFor &&
      last.private === view.why.includes(CLOSE_REASON) &&
      Math.round(last.intensity * 10) === Math.round(view.intensity * 10)
    )
      return;
    const at = yield* Clock.currentTimeMillis;
    faces.set(
      device,
      [
        {
          persona,
          label: view.label,
          intensity: view.intensity,
          faceFor,
          private: view.why.includes(CLOSE_REASON),
          at,
        },
        ...(faces.get(device) ?? []),
      ].slice(0, FACES_KEPT),
    );
    yield* emitAction({
      kind: "face.shown",
      actor: { kind: "persona", id: persona, certainty: 1 },
      subject: device,
      persona,
      outcome: view.label,
      data: { intensity: Math.round(view.intensity * 100) / 100, for: faceFor },
    });
  });
  const view: TessayaMood["Service"]["view"] = Effect.fn("TessayaMood.view")(
    function* (personaId, timeZone, member) {
      const theirs = yield* brainView({
        p: personaId ?? null,
        m: member ?? null,
        z: timeZone ?? null,
      });
      if (Option.isSome(theirs)) return theirs.value;
      const { persona, state, ctx } = yield* readNow(personaId, timeZone);
      return personaView(state, persona, ctx, member ?? null);
    },
  );
  const roomView: TessayaMood["Service"]["roomView"] = Effect.fn("TessayaMood.roomView")(
    function* (personaId, here, timeZone) {
      const { persona, state, ctx } = yield* readNow(personaId, timeZone);
      return personaRoomView(state, persona, ctx, here);
    },
  );

  /** Every persona's row, rewritten under the lock (a forget or a merge reaches them all). */
  const rewriteAll = Effect.fn("TessayaMood.rewriteAll")(function* (
    change: (p: PersonaAffect) => PersonaAffect,
    reason: string,
  ) {
    const now = yield* Clock.currentTimeMillis;
    yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const rows = yield* sql<{ persona: string; state_json: string }>`
          SELECT persona, state_json FROM tessaya_affect_state
        `.pipe(Effect.orElseSucceed(() => []));
        for (const r of rows) {
          const before = decodeState(r.state_json, now);
          const after = change(before);
          if (after !== before) yield* write(r.persona, after, reason, now);
        }
        yield* PubSub.publish(moved, undefined);
      }),
    );
  });

  // A presence change (someone arrived at or left a vessel) reaches every face at once, not on the next sweep.
  const arrivals = Stream.unwrap(
    Effect.serviceOption(TessayaPresence).pipe(
      Effect.map((p) => (Option.isNone(p) ? Stream.empty : p.value.changes)),
    ),
  );
  const moves = Stream.merge(Stream.merge(Stream.fromPubSub(moved), Stream.tick(SWEEP)), arrivals);
  // On her brain, each move is told to her other servers at once, so a face there never waits on a kept view (M-094).
  yield* Stream.merge(Stream.fromPubSub(moved), arrivals).pipe(
    Stream.debounce("200 millis"),
    Stream.runForEach(() =>
      Effect.flatMap(brain.isBrain, (here) => (here ? brain.tell("moodMoved") : Effect.void)),
    ),
    Effect.forkScoped,
  );

  const reassign = Effect.fn("TessayaMood.reassign")(function* (move: AffectMove) {
    if (!(yield* brain.isBrain)) {
      // never lost: queued for the brain like any mood write; the count is the brain's to know
      yield* brain.sendOrQueue("mood", { move });
      return 0;
    }
    if (move.ref === undefined && move.vessel === undefined && move.since === undefined) return 0;
    const now = yield* Clock.currentTimeMillis;
    const current = yield* moodSettings;
    const rows = yield* sql<{
      id: string;
      ref: string;
      persona: string;
      event_json: string;
      delta_json: string;
      at: number;
    }>`
      SELECT id, ref, persona, event_json, delta_json, at FROM tessaya_affect_ledger
      WHERE member = ${move.from} AND moved_at IS NULL
        AND (${move.ref ?? null} IS NULL OR ref = ${move.ref ?? null})
        AND (${move.vessel ?? null} IS NULL OR vessel = ${move.vessel ?? null})
        AND at >= ${move.since ?? 0}
        AND (${move.assumedOnly === true ? 1 : 0} = 0 OR assumed = 1)
      ORDER BY at DESC
    `.pipe(Effect.orElseSucceed(() => []));
    for (const r of rows) {
      const delta = fromJson<AffectDelta>(r.delta_json);
      const event = fromJson<AffectEvent>(r.event_json);
      if (delta === null || event === null) continue;
      yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const state = yield* read(r.persona, now);
          const theirs = state.people[move.from];
          if (theirs !== undefined)
            yield* write(
              r.persona,
              { ...state, people: { ...state.people, [move.from]: undoDelta(theirs, delta, now) } },
              "that was someone else",
              now,
            );
        }),
      );
      yield* sql`UPDATE tessaya_affect_ledger SET moved_to = ${move.to ?? ""}, moved_at = ${now} WHERE id = ${r.id}`.pipe(
        Effect.ignoreCause({ log: true }),
      );
      // Given to whoever it was, under the same cause, so it can move again.
      if (move.to !== null && move.to !== move.from)
        yield* appraiseInto(r.persona, event, now, move.to, current.bondCap, 1, { ref: r.ref });
    }
    if (rows.length > 0) {
      yield* PubSub.publish(moved, undefined);
      yield* emitAction({
        kind: "affect.reassigned",
        actor: {
          kind: move.by === undefined || move.by === OWNER_MEMBER_ID ? "owner" : "member",
          ...(move.by === undefined ? {} : { id: move.by }),
          certainty: 1,
        },
        subject: move.ref ?? move.vessel ?? "recent",
        outcome: move.to ?? "someone else",
        data: {
          from: move.from,
          moved: rows.length,
          ...(move.since === undefined ? {} : { since: move.since }),
        },
      });
    }
    return rows.length;
  });

  const forget = Effect.fn("TessayaMood.forget")(function* (member: string, into?: string) {
    yield* rewriteAll((p) => movePerson(p, member, into ?? null), "someone was forgotten");
  });
  // Someone the people graph forgets (or finds to be someone else) leaves her feelings with them.
  if (Option.isSome(people))
    yield* people.value.forgotten.pipe(
      Stream.runForEach(({ id, into }) => forget(id, into)),
      Effect.forkScoped({ startImmediately: true }),
    );

  return TessayaMood.of({
    view,
    roomView,
    reassign,
    note: Effect.fn("TessayaMood.note")(function* (persona, event, member) {
      yield* apply(persona, () => event, undefined, member ?? null);
    }),
    hisWords: Effect.fn("TessayaMood.hisWords")(function* (persona, said, member, context) {
      const current = yield* moodSettings;
      if (Option.isNone(oneShot) || said.trim() === "" || !current.enabled) return false;
      const { persona: id, dials } = dialsFor(persona, current);
      const now = yield* Clock.currentTimeMillis;
      const theirs = member === null ? undefined : (yield* read(id, now)).people[member];
      // Her opinion is asked only of someone identified, and only while the judgement dial is above off.
      const opinion =
        member === null || dials.judgement <= 0.05
          ? undefined
          : theirs?.impression == null
            ? null
            : opinionContext(theirs.impression);
      const household = member !== null && (yield* isMember(member));
      const judged = yield* oneShot.value
        .run({
          prompt: readPrompt(said, {
            ...(opinion === undefined ? {} : { opinion }),
            ...(household ? { household: true } : {}),
            ...(context?.before === undefined ? {} : { before: context.before }),
          }),
          outputSchema: TurnRead,
          role: "intent",
          feature: "mood",
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logDebug("mood: the turn not read", { why: String(cause) }).pipe(
              Effect.as(null),
            ),
          ),
        );
      if (judged === null) return false;
      if (judged.topic !== "none" || judged.theirs !== "none")
        yield* apply(
          persona,
          (_, d) => ({
            kind: "flow",
            topic: judged.topic,
            theirs: judged.theirs,
            regulation: d.regulation,
          }),
          undefined,
          member,
        );
      if (member === null) return false;
      const tone = judged.tone;
      if (tone !== "none") yield* apply(persona, () => ({ kind: tone }), undefined, member);
      // Their words saying they are low agree with a "sad" or "fearful" voice: the second signal a care mode needs.
      if (judged.theirs === "low" && (context?.voice === "sad" || context?.voice === "fearful"))
        yield* apply(
          persona,
          () => ({ kind: "his_voice", emotion: context.voice!, confirmed: true }),
          undefined,
          member,
        );
      if (judged.shared !== null && judged.shared.text.trim() !== "") {
        const shared = judged.shared;
        yield* apply(
          persona,
          () => ({ kind: "shared", what: shared.what, text: shared.text.trim() }),
          undefined,
          member,
        );
      }
      const op = judged.opinion;
      if (opinion === undefined || op == null || op.text.trim() === "")
        return judged.shared !== null && judged.shared.text.trim() !== "";
      yield* apply(
        persona,
        () => ({ kind: "impression", lean: op.lean, text: op.text.trim(), why: op.why.trim() }),
        undefined,
        member,
      );
      // Her opinion moving is an action with its reason, as her understanding's writes are.
      yield* emitAction({
        kind: "mood.opinion",
        actor: { kind: "persona", id: persona ?? "lead", certainty: 1 },
        subject: member ?? "room",
        persona: persona ?? null,
        outcome: String(op.lean),
        data: { why: op.why.trim().slice(0, 200) },
      });
      // A stranger's opinion is also the people graph's: the owner sees it in People, and it rides their own turns.
      if (Option.isSome(people) && !(yield* isMember(member)))
        yield* people.value
          .setImpression(member, `${op.text.trim()} (because ${op.why.trim()})`)
          .pipe(Effect.ignoreCause({ log: true }));
      return true;
    }),
    heard: Effect.fn("TessayaMood.heard")(function* (persona, timeZone, member) {
      yield* apply(persona, (day) => ({ kind: "his_turn", day }), timeZone, member);
    }),
    atDevice: Effect.fn("TessayaMood.atDevice")(function* (device, personaId, timeZone) {
      const face = yield* faceAt(device, personaId, timeZone);
      const persona = personaOf(personaId)?.id ?? LEAD;
      yield* shown(device, persona, face);
      // shortcut: a desktop's turns name their vessel "desktop" (see faceAt); one desktop per household for now.
      if (device.startsWith("desktop-")) yield* shown("desktop", persona, face);
      return face;
    }),
    refresh: Effect.gen(function* () {
      fromBrain.clear();
      yield* PubSub.publish(moved, undefined);
    }),
    facesOn: Effect.fn("TessayaMood.facesOn")((device: string) =>
      Effect.sync(() => faces.get(device) ?? []),
    ),
    inner: Effect.fn("TessayaMood.inner")(function* (personaId, viewer, timeZone) {
      // a worker's Settings show the brain's one mood, not its own copy
      if (!(yield* brain.isBrain)) {
        const asked = yield* brain.send("moodView", {
          p: personaId ?? null,
          m: null,
          z: timeZone ?? null,
          i: viewer,
        });
        if (
          Option.isSome(asked) &&
          typeof asked.value === "object" &&
          asked.value !== null &&
          "general" in asked.value
        )
          return asked.value as {
            readonly general: AffectView;
            readonly people: ReadonlyArray<InnerPerson>;
            readonly dials: Dials;
          };
      }
      const { persona, state, ctx } = yield* readNow(personaId, timeZone);
      const names = new Map(
        (yield* sql<{ id: string; name: string }>`
          SELECT id, name FROM tessaya_household_members WHERE removed_at IS NULL
          UNION ALL
          SELECT id, coalesce(name, 'someone new') FROM fabric_memory_entities
          WHERE kind = 'person' AND forgotten_json IS NULL
        `.pipe(Effect.orElseSucceed(() => []))).map((m) => [m.id, m.name]),
      );
      return {
        general: personaView(state, persona, ctx, null),
        dials: ctx.dials!,
        people: Object.keys(state.people)
          .filter((member) => viewer === OWNER_MEMBER_ID || member === viewer)
          .map((member) => ({
            member,
            name: names.get(member) ?? (member === OWNER_MEMBER_ID ? "You" : "someone new"),
            view: {
              ...personaView(state, persona, ctx, member),
              // Their row says only why about them: the general mood's reasons stay the owner's.
              why: personaView({ ...state, general: freshAffect(ctx.now) }, persona, ctx, member)
                .why,
            },
          })),
      };
    }),
    forget,
    reset: Effect.fn("TessayaMood.reset")(function* (personaId, member) {
      const persona = personaOf(personaId)?.id ?? LEAD;
      const now = yield* Clock.currentTimeMillis;
      yield* lock.withPermits(1)(
        Effect.gen(function* () {
          yield* write(
            persona,
            movePerson(yield* read(persona, now), member, null),
            "her opinion was reset",
            now,
          );
          yield* PubSub.publish(moved, undefined);
        }),
      );
      if (Option.isSome(people) && !(yield* isMember(member)))
        yield* people.value.setImpression(member, null).pipe(Effect.ignoreCause({ log: true }));
    }),
    moves,
    changes: (persona, timeZone) =>
      moves.pipe(
        Stream.mapEffect(() => view(persona, timeZone)),
        Stream.changesWith(
          (a, b) =>
            a.label === b.label && Math.round(a.intensity * 10) === Math.round(b.intensity * 10),
        ),
      ),
  });

  function isMember(id: string) {
    return sql<{ id: string }>`
      SELECT id FROM tessaya_household_members WHERE id = ${id}
    `.pipe(
      Effect.map((rows) => rows.length > 0 || id === OWNER_MEMBER_ID),
      Effect.orElseSucceed(() => true),
    );
  }
});

export const layer = Layer.effect(TessayaMood, make);
