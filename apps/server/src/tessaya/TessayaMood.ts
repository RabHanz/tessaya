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
  appraiseFor,
  deviceOwnerOf,
  dialsOf,
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
    /** One person's relationship with a persona (her opinion, story and feeling) back to nothing. */
    readonly reset: (persona: string | undefined, member: string) => Effect.Effect<void>;
    /** Something moved a mood (a write, someone arrived or left a vessel), or a few minutes passed: faces read again. */
    readonly moves: Stream.Stream<void>;
    /**
     * A persona's general mood each time it shows differently (its label, or its strength by a tenth): after each
     * event, and as time moves it, checked every few minutes only while someone listens.
     */
    readonly changes: (persona: string | undefined, timeZone?: string) => Stream.Stream<AffectView>;
  }
>()("t3/tessaya/TessayaMood") {}

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
    return { persona, dials: dialsOf(persona, face?.guilt, current.personas?.[persona]) };
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
    // Only her brain appraises; a worker sends what it saw there (one-brain §2.1).
    if (!(yield* brain.isBrain)) {
      yield* brain.send("mood", { p: persona, m: member, e: resolved });
      return;
    }
    yield* appraiseInto(persona, resolved, now, member, current.bondCap, dials.forgiveness);
  });

  /** One event into a persona's row at its time (never before the row's own), as her brain heard it. */
  const appraiseInto = (
    persona: string,
    event: AffectEvent,
    at: number,
    member: string | null,
    bondCap: number,
    forgiveness: number,
  ) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const state = yield* read(persona, at);
        const when = Math.max(at, state.general.at);
        const next = appraiseFor(state, event, when, bondCap, member, forgiveness);
        // A person's event with nobody identified moves nothing.
        if (next.reason === null) return null;
        yield* write(persona, next.state, next.reason, when);
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

  const view: TessayaMood["Service"]["view"] = Effect.fn("TessayaMood.view")(
    function* (personaId, timeZone, member) {
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
  const moves = Stream.merge(
    Stream.merge(Stream.fromPubSub(moved), Stream.tick(SWEEP)),
    Stream.unwrap(
      Effect.serviceOption(TessayaPresence).pipe(
        Effect.map((p) => (Option.isNone(p) ? Stream.empty : p.value.changes)),
      ),
    ),
  );

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
      const judged = yield* oneShot.value
        .run({
          prompt: readPrompt(said, {
            ...(opinion === undefined ? {} : { opinion }),
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
      if (member !== null) return personaView(state, persona, ctx, member);
      // Several people placed here: the room's mood, weighted by how sure presence is of each.
      const at = new Set(vessels);
      const here = estimate.members.flatMap((m) =>
        m.nearest !== null &&
        at.has(m.nearest.vessel) &&
        m.nearest.confidence >= PRESENCE_BARS.around
          ? [{ key: m.member, weight: m.nearest.confidence }]
          : [],
      );
      return here.length > 1
        ? personaRoomView(state, persona, ctx, here)
        : personaView(state, persona, ctx, null);
    }),
    inner: Effect.fn("TessayaMood.inner")(function* (personaId, viewer, timeZone) {
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
