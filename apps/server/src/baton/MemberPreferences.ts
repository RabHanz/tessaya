/**
 * The members' own voice defaults (persona and voice, from their preferences, migration 034) for every vessel on this
 * server: the turn says when one changed, each vessel's owner (the device broker for the room loop) listens. Its own
 * service, so the turn and the broker need not import each other.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

export interface VoiceDefaults {
  readonly persona?: string;
  readonly voice?: string;
}

type Listener = (member: string, now: VoiceDefaults | null) => Effect.Effect<void>;

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
    /** Every member's persona and voice now. */
    readonly voiceDefaults: Effect.Effect<ReadonlyMap<string, VoiceDefaults>>;
    /** A member's preferences changed: listeners get their voice defaults (null: none left). */
    readonly changed: (member: string) => Effect.Effect<void>;
    readonly listen: (listener: Listener) => Effect.Effect<void>;
  }
>()("t3/baton/MemberPreferences") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
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
  return MemberPreferences.of({
    voiceDefaults: read(null),
    changed: Effect.fn("MemberPreferences.changed")(function* (member: string) {
      const now = (yield* read(member)).get(member) ?? null;
      for (const l of listeners) yield* l(member, now);
    }),
    listen: Effect.fn("MemberPreferences.listen")(function* (listener: Listener) {
      yield* Effect.sync(() => listeners.add(listener));
    }),
  });
});

export const layer = Layer.effect(MemberPreferences, make);
