// @effect-diagnostics globalJsonInEffect:off
/**
 * The members' own preferences (HOUSEHOLD-DESIGN §4, migration 034): one place reads and writes them, for a turn's
 * tool, the Household page and every vessel. A spelled name is kept as spelled and taught to her voice; each change
 * goes to the listeners (the device broker sends persona and voice to the room loop). Its own service, so the turn,
 * the household and the broker need not import each other.
 */
import { isPreferenceKey, type PreferenceKey } from "@t3tools/tessaya-shared/household";
import { foldSpelling, spellBack } from "@t3tools/tessaya-shared/spelling";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { ServerSettingsService } from "../serverSettings.ts";
import { makeBrainLink } from "./BrainHost.ts";

export interface VoiceDefaults {
  readonly persona?: string;
  readonly voice?: string;
  /** Listen mode's silence and end words, which the room loop applies itself. */
  readonly listenWait?: string;
  readonly listenEnds?: string;
}

const VOICE_KEYS: ReadonlySet<string> = new Set(["persona", "voice", "listenWait", "listenEnds"]);

type Listener = (member: string, now: VoiceDefaults | null) => Effect.Effect<void>;
type Names = ReadonlyArray<{ readonly word: string; readonly heardAs: string | null }>;

const PREFERENCE_MAX = 120;

/** Rows to each member's persona and voice; a member with neither has none. */
export const voiceDefaultsOf = (
  rows: ReadonlyArray<{ readonly member_id: string; readonly key: string; readonly value: string }>,
): ReadonlyMap<string, VoiceDefaults> => {
  const out = new Map<string, Record<string, string>>();
  for (const r of rows) {
    if (!VOICE_KEYS.has(r.key)) continue;
    out.set(r.member_id, { ...out.get(r.member_id), [r.key]: r.value });
  }
  return out;
};

export class MemberPreferences extends Context.Service<
  MemberPreferences,
  {
    /** One member's preferences. */
    readonly of: (member: string) => Effect.Effect<Partial<Record<PreferenceKey, string>>>;
    /**
     * Sets (or with null or "" clears) one of a member's preferences; the caller has checked who may. A spelled name
     * is folded and taught to her voice; `line` says it back ("Kept. Zayd, Z-A-Y-D.").
     */
    readonly set: (
      member: string,
      key: PreferenceKey,
      value: string | null,
    ) => Effect.Effect<{ readonly value: string | null; readonly line: string }>;
    /** Spelled names heard said differently ("Zayd" sounds like "Zaid"): her voice's pronunciations. */
    readonly teach: (names: Names) => Effect.Effect<void>;
    /** Every member's persona and voice now. */
    readonly voiceDefaults: Effect.Effect<ReadonlyMap<string, VoiceDefaults>>;
    /** A member's preferences changed: listeners get their voice defaults (null: none left). */
    readonly changed: (member: string) => Effect.Effect<void>;
    readonly listen: (listener: Listener) => Effect.Effect<void>;
    /** On her brain: a worker's read or change (BrainReceive "preferences"). */
    readonly atBrain: (act: PreferencesAct) => Effect.Effect<unknown>;
  }
>()("t3/tessaya/MemberPreferences") {}

const PreferenceRow = Schema.Struct({
  member_id: Schema.String,
  key: Schema.String,
  value: Schema.String,
  updated_at: Schema.String,
});
type PreferenceRow = typeof PreferenceRow.Type;
/** A worker's act on the members' preferences, applied on her brain, where they live (21 Nov: workers kept none). */
export const PreferencesAct = Schema.Union([
  Schema.Struct({ a: Schema.Literal("rows"), member: Schema.NullOr(Schema.String) }),
  Schema.Struct({
    a: Schema.Literal("set"),
    member: Schema.String,
    key: Schema.String,
    value: Schema.NullOr(Schema.String),
  }),
  // a worker's own rows from before the one home: the newer of each pair stands, nothing dropped
  Schema.Struct({ a: Schema.Literal("merge"), rows: Schema.Array(PreferenceRow) }),
]);
export type PreferencesAct = typeof PreferencesAct.Type;
const decodeRows = Schema.decodeUnknownOption(Schema.Array(PreferenceRow));
const decodeSet = Schema.decodeUnknownOption(
  Schema.Struct({ value: Schema.NullOr(Schema.String), line: Schema.String }),
);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const settings = yield* Effect.serviceOption(ServerSettingsService);
  const listeners = new Set<Listener>();
  const brain = yield* makeBrainLink;
  const rowsHere = (member: string | null) =>
    (member === null
      ? sql<PreferenceRow>`SELECT member_id, key, value, updated_at FROM tessaya_member_preferences`
      : sql<PreferenceRow>`
          SELECT member_id, key, value, updated_at FROM tessaya_member_preferences WHERE member_id = ${member}`
    ).pipe(Effect.orElseSucceed((): ReadonlyArray<PreferenceRow> => []));
  /** A worker's own rows, from before the one home: sent up once (or queued in order), then gone from here. */
  const moveUp = Effect.gen(function* () {
    const kept = yield* rowsHere(null);
    if (kept.length === 0) return;
    yield* brain.sendOrQueue("preferences", { a: "merge", rows: kept } satisfies PreferencesAct);
    yield* sql`DELETE FROM tessaya_member_preferences`.pipe(Effect.ignore);
  });
  /** The rows from her brain, where they live; None: a worker that can't reach it. */
  const rowsNow = Effect.fn("MemberPreferences.rows")(function* (member: string | null) {
    if (yield* brain.isBrain) return Option.some(yield* rowsHere(member));
    yield* moveUp;
    const answer = yield* brain.send("preferences", { a: "rows", member } satisfies PreferencesAct);
    return Option.flatMap(answer, decodeRows);
  });
  /** A worker that can't reach the brain has none, never an old copy. */
  const rows = (member: string | null) =>
    Effect.map(
      rowsNow(member),
      Option.getOrElse((): ReadonlyArray<PreferenceRow> => []),
    );
  const read = (member: string | null) => Effect.map(rows(member), voiceDefaultsOf);

  const changed = Effect.fn("MemberPreferences.changed")(function* (member: string) {
    const now = (yield* read(member)).get(member) ?? null;
    for (const l of listeners) yield* l(member, now);
  });

  const teach = Effect.fn("MemberPreferences.teach")(function* (names: Names) {
    const heard = names.filter((n) => n.heardAs !== null);
    if (heard.length === 0 || Option.isNone(settings)) return;
    yield* settings.value.getSettings.pipe(
      Effect.flatMap((current) =>
        settings.value.updateSettings({
          voicePronounce: {
            ...current.voicePronounce,
            ...Object.fromEntries(heard.map((n) => [n.word, n.heardAs!])),
          },
        }),
      ),
      Effect.ignore,
    );
  });

  const setHere = Effect.fn("MemberPreferences.setHere")(function* (
    member: string,
    key: PreferenceKey,
    value: string | null,
  ) {
    const folded = foldSpelling(value?.trim() ?? "");
    const clean = folded.text.replace(/\s+/g, " ").slice(0, PREFERENCE_MAX);
    yield* teach(folded.names);
    if (clean === "")
      yield* sql`DELETE FROM tessaya_member_preferences WHERE member_id = ${member} AND key = ${key}`.pipe(
        Effect.orDie,
      );
    else
      yield* sql`
        INSERT INTO tessaya_member_preferences (member_id, key, value, updated_at)
        VALUES (${member}, ${key}, ${clean}, ${DateTime.formatIso(yield* DateTime.now)})
        ON CONFLICT (member_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `.pipe(Effect.orDie);
    yield* changed(member);
    return {
      value: clean === "" ? null : clean,
      line: clean === "" ? "Cleared." : `Kept.${spellBack(folded.names)}`,
    };
  });

  // A worker's vessels hear a change made on the brain within a minute (the broker sends the room loops their voice);
  // while the brain is away nothing is told, so they keep what they have.
  let told: ReadonlyMap<string, VoiceDefaults> = new Map();
  yield* Effect.gen(function* () {
    if (yield* brain.isBrain) return;
    const fetched = yield* rowsNow(null);
    if (Option.isNone(fetched)) return;
    const now = voiceDefaultsOf(fetched.value);
    const before = told;
    told = now;
    for (const member of new Set([...before.keys(), ...now.keys()])) {
      const v = now.get(member) ?? null;
      if (JSON.stringify(v) === JSON.stringify(before.get(member) ?? null)) continue;
      for (const l of listeners) yield* l(member, v);
    }
  }).pipe(
    Effect.ignoreCause({ log: true }),
    Effect.repeat(Schedule.spaced("1 minute")),
    Effect.forkScoped,
  );

  /** A change made on a worker lands on her brain (queued in order while it is away); the worker keeps no copy. */
  const set = Effect.fn("MemberPreferences.set")(function* (
    member: string,
    key: PreferenceKey,
    value: string | null,
  ) {
    if (yield* brain.isBrain) return yield* setHere(member, key, value);
    const answer = yield* brain.sendOrQueue("preferences", {
      a: "set",
      member,
      key,
      value,
    } satisfies PreferencesAct);
    yield* changed(member);
    return Option.getOrElse(Option.flatMap(answer, decodeSet), () => ({
      value: value?.trim() || null,
      line: "Kept; it reaches her brain when she is back.",
    }));
  });

  return MemberPreferences.of({
    of: Effect.fn("MemberPreferences.of")(function* (member: string) {
      return Object.fromEntries(
        (yield* rows(member)).filter((r) => isPreferenceKey(r.key)).map((r) => [r.key, r.value]),
      ) as Partial<Record<PreferenceKey, string>>;
    }),
    set,
    teach,
    voiceDefaults: read(null),
    changed,
    listen: Effect.fn("MemberPreferences.listen")(function* (listener: Listener) {
      yield* Effect.sync(() => listeners.add(listener));
    }),
    atBrain: Effect.fn("MemberPreferences.atBrain")(function* (act: PreferencesAct) {
      if (act.a === "rows") return yield* rowsHere(act.member);
      if (act.a === "set")
        return isPreferenceKey(act.key) ? yield* setHere(act.member, act.key, act.value) : null;
      for (const r of act.rows.filter((r) => isPreferenceKey(r.key)))
        yield* sql`
          INSERT INTO tessaya_member_preferences (member_id, key, value, updated_at)
          VALUES (${r.member_id}, ${r.key}, ${r.value}, ${r.updated_at})
          ON CONFLICT (member_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
          WHERE excluded.updated_at > tessaya_member_preferences.updated_at
        `.pipe(Effect.orDie);
      for (const member of new Set(act.rows.map((r) => r.member_id))) yield* changed(member);
      return null;
    }),
  });
});

export const layer = Layer.effect(MemberPreferences, make);
