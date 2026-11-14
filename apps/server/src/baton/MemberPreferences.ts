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
import * as SqlClient from "effect/sql/SqlClient";

import { ServerSettingsService } from "../serverSettings.ts";

export interface VoiceDefaults {
  readonly persona?: string;
  readonly voice?: string;
}

type Listener = (member: string, now: VoiceDefaults | null) => Effect.Effect<void>;
type Names = ReadonlyArray<{ readonly word: string; readonly heardAs: string | null }>;

const PREFERENCE_MAX = 120;

/** Rows to each member's persona and voice; a member with neither has none. */
export const voiceDefaultsOf = (
  rows: ReadonlyArray<{ readonly member_id: string; readonly key: string; readonly value: string }>,
): ReadonlyMap<string, VoiceDefaults> => {
  const out = new Map<string, { persona?: string; voice?: string }>();
  for (const r of rows) {
    if (r.key !== "persona" && r.key !== "voice") continue;
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
  }
>()("t3/baton/MemberPreferences") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const settings = yield* Effect.serviceOption(ServerSettingsService);
  const listeners = new Set<Listener>();
  const read = (member: string | null) =>
    (member === null
      ? sql<{ member_id: string; key: string; value: string }>`
          SELECT member_id, key, value FROM tessaya_member_preferences WHERE key IN ('persona', 'voice')`
      : sql<{ member_id: string; key: string; value: string }>`
          SELECT member_id, key, value FROM tessaya_member_preferences
          WHERE member_id = ${member} AND key IN ('persona', 'voice')`
    ).pipe(
      Effect.map(voiceDefaultsOf),
      Effect.orElseSucceed(() => new Map()),
    );

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

  return MemberPreferences.of({
    of: Effect.fn("MemberPreferences.of")(function* (member: string) {
      const rows = yield* sql<{ key: string; value: string }>`
        SELECT key, value FROM tessaya_member_preferences WHERE member_id = ${member}
      `.pipe(Effect.orElseSucceed(() => []));
      return Object.fromEntries(
        rows.filter((r) => isPreferenceKey(r.key)).map((r) => [r.key, r.value]),
      ) as Partial<Record<PreferenceKey, string>>;
    }),
    set: Effect.fn("MemberPreferences.set")(function* (
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
    }),
    teach,
    voiceDefaults: read(null),
    changed,
    listen: Effect.fn("MemberPreferences.listen")(function* (listener: Listener) {
      yield* Effect.sync(() => listeners.add(listener));
    }),
  });
});

export const layer = Layer.effect(MemberPreferences, make);
