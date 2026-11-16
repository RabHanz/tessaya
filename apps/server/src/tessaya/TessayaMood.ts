// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
/**
 * Her mood, one row per persona: a general mood and a relationship per member (§7: nothing that decides acts reads it).
 * Each event made here also goes to his other servers (DeviceSync `@mood`, id-deduped, oldest first) and each appraises
 * it into its own row, so all of them end in one mood; presence anywhere (synced too) means he is not away (B-044).
 */
import {
  DEFAULT_AFFECT_SETTINGS,
  appraiseFor,
  deviceOwnerOf,
  faceMemberAt,
  freshAffect,
  guiltOf,
  HIS_TONES,
  personaAffectOf,
  personaView,
  tonePrompt,
  type AffectEvent,
  type AffectView,
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
import * as Schema from "effect/Schema";
import * as PubSub from "effect/PubSub";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import { DeviceRegistry } from "../home/DeviceRegistry.ts";
import { DeviceSync } from "../home/DeviceSync.ts";
import { TessayaPresence } from "./TessayaPresence.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { readPack } from "./OperatingSystemPack.ts";
import { TessayaOneShot } from "./TessayaOneShot.ts";

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
    /** One typed event: the world's (an outcome, a job) to the general mood, a person's to `member`'s relationship. */
    readonly note: (
      persona: string | undefined,
      event: Exclude<AffectEvent, { kind: "his_turn" }>,
      member?: string | null,
    ) => Effect.Effect<void>;
    /** How a member's words treat her (an apology, praise, warmth, rudeness), judged by the cheap model. */
    readonly hisWords: (
      persona: string | undefined,
      said: string,
      member: string | null,
    ) => Effect.Effect<void>;
    /** One of a member's turns reached this persona: their time away resolves and their bond counts the day. */
    readonly heard: (
      persona: string | undefined,
      timeZone: string | undefined,
      member: string,
    ) => Effect.Effect<void>;
    /** A device's face at rest, from the one presence estimate: the one person there, else its owner's when allowed. */
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
      readonly people: ReadonlyArray<{
        readonly member: string;
        readonly name: string;
        readonly view: AffectView;
      }>;
    }>;
    /** Something moved a mood (a write, someone at a vessel), or a few minutes passed: faces read again. */
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

const Tone = Schema.Struct({ tone: Schema.Literals([...HIS_TONES, "none"]) });
/** A mood event as it travels between his servers (`@mood`, keyed by its id). */
const MOOD_RECORD = "@mood";
const SyncedEvent = Schema.Struct({
  p: Schema.String.check(Schema.isMaxLength(60)),
  m: Schema.NullOr(Schema.String.check(Schema.isMaxLength(120))),
  // The event whole (its kind plus fields such as `ok`, `day`, `emotion`): a Struct would strip those.
  e: Schema.Record(Schema.String, Schema.Unknown),
});
const decodeSynced = Schema.decodeUnknownOption(SyncedEvent);
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
  const sync = yield* Effect.serviceOption(DeviceSync);
  let sent = 0;

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
    event: (day: string) => AffectEvent,
    timeZone: string | undefined,
    member: string | null,
  ) {
    const current = yield* moodSettings;
    if (!current.enabled) return yield* clear;
    const persona = personaOf(personaId)?.id ?? LEAD;
    const now = yield* Clock.currentTimeMillis;
    const { day } = clockIn(now, timeZone ?? "UTC");
    const resolved = event(day);
    const reason = yield* appraiseInto(persona, resolved, now, member, current.bondCap);
    // Its provenance travels with it: the id (the field), when (the stamp), which server, who, and why.
    if (reason !== null && Option.isSome(sync))
      yield* sync.value.put(
        MOOD_RECORD,
        `${sync.value.self}:${now}:${sent++}`,
        { p: persona, m: member, e: resolved, origin: sync.value.self, reason },
        "changed",
        now,
      );
  });

  /** One event into a persona's row at its time (never before the row's own), whichever server saw it. */
  const appraiseInto = (
    persona: string,
    event: AffectEvent,
    at: number,
    member: string | null,
    bondCap: number,
  ) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const state = yield* read(persona, at);
        const when = Math.max(at, state.general.at);
        const next = appraiseFor(state, event, when, bondCap, member);
        // A person's event with nobody identified moves nothing.
        if (next.reason === null) return null;
        yield* write(persona, next.state, next.reason, when);
        yield* PubSub.publish(moved, undefined);
        return next.reason;
      }),
    );

  if (Option.isSome(sync))
    yield* sync.value.onRecord(MOOD_RECORD, (_id, v, at) =>
      Effect.gen(function* () {
        const decoded = decodeSynced(v);
        const current = yield* moodSettings;
        if (Option.isNone(decoded) || !current.enabled) return;
        const { p, m, e } = decoded.value;
        if (typeof e["kind"] !== "string") return;
        yield* appraiseInto(p, e as unknown as AffectEvent, at, m, current.bondCap);
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
        yield* appraiseInto(persona, { kind: "seen" }, now, m.member, bondCap);
    }
  });

  const readNow = Effect.fn("TessayaMood.readNow")(function* (
    personaId: string | undefined,
    timeZone: string | undefined,
  ) {
    const face = personaOf(personaId);
    const persona = face?.id ?? LEAD;
    const now = yield* Clock.currentTimeMillis;
    const current = yield* moodSettings;
    if (!current.enabled) yield* clear;
    else yield* seenByPresence(persona, now, current.bondCap);
    return {
      persona,
      state: yield* read(persona, now),
      ctx: {
        now,
        hour: clockIn(now, timeZone ?? "UTC").hour,
        guilt: guiltOf(face?.guilt),
        settings: current,
      },
    };
  });

  const view: TessayaMood["Service"]["view"] = Effect.fn("TessayaMood.view")(
    function* (personaId, timeZone, member) {
      const { persona, state, ctx } = yield* readNow(personaId, timeZone);
      return personaView(state, persona, ctx, member ?? null);
    },
  );

  const moves = Stream.merge(Stream.fromPubSub(moved), Stream.tick(SWEEP));

  return TessayaMood.of({
    view,
    note: Effect.fn("TessayaMood.note")(function* (persona, event, member) {
      yield* apply(persona, () => event, undefined, member ?? null);
    }),
    hisWords: Effect.fn("TessayaMood.hisWords")(function* (persona, said, member) {
      if (
        member === null ||
        Option.isNone(oneShot) ||
        said.trim() === "" ||
        !(yield* moodSettings).enabled
      )
        return;
      const judged = yield* oneShot.value
        .run({ prompt: tonePrompt(said), outputSchema: Tone, role: "intent", feature: "mood" })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logDebug("mood: their tone not judged", { why: String(cause) }).pipe(
              Effect.as(null),
            ),
          ),
        );
      if (judged === null || judged.tone === "none") return;
      const tone = judged.tone;
      yield* apply(persona, () => ({ kind: tone }), undefined, member);
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
      const member = faceMemberAt({
        ...owned,
        // shortcut: desktop turns note their vessel as "desktop", not the device; split when a second desktop matters.
        vessels: known?.kind === "desktop" ? [device, "desktop"] : [device],
        estimate,
      });
      return personaView(state, persona, ctx, member);
    }),
    inner: Effect.fn("TessayaMood.inner")(function* (personaId, viewer, timeZone) {
      const { persona, state, ctx } = yield* readNow(personaId, timeZone);
      const names = new Map(
        (yield* sql<{ id: string; name: string }>`
          SELECT id, name FROM tessaya_household_members WHERE removed_at IS NULL
        `.pipe(Effect.orElseSucceed(() => []))).map((m) => [m.id, m.name]),
      );
      return {
        general: personaView(state, persona, ctx, null),
        people: Object.keys(state.people)
          .filter((member) => viewer === OWNER_MEMBER_ID || member === viewer)
          .map((member) => ({
            member,
            name: names.get(member) ?? (member === OWNER_MEMBER_ID ? "You" : member),
            view: {
              ...personaView(state, persona, ctx, member),
              // Their row says only why about them: the general mood's reasons stay the owner's.
              why: personaView({ ...state, general: freshAffect(ctx.now) }, persona, ctx, member)
                .why,
            },
          })),
      };
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
});

export const layer = Layer.effect(TessayaMood, make);
