// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
/**
 * Her working mood, one row per persona (EMOTION-SYSTEM phase 1; SPINE-UNIFY §10 CS6). The turn and the brain send
 * typed events from the owner's turns; every vessel reads the same label, so her face and tone agree on each of them.
 * Nothing that decides what she may do reads this service (§7).
 */
import {
  DEFAULT_AFFECT_SETTINGS,
  affectView,
  appraise,
  freshAffect,
  guiltOf,
  type AffectEvent,
  type AffectState,
  type AffectView,
} from "@t3tools/tessaya-shared/affect";
import { DEFAULT_OS_PACK } from "@t3tools/tessaya-shared/osPack";
import * as NodePath from "node:path";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { readPack } from "../baton/OperatingSystemPack.ts";

export class TessayaMood extends Context.Service<
  TessayaMood,
  {
    /** A persona's mood now (unset is the lead), on his clock; neutral with the setting off. */
    readonly view: (persona: string | undefined, timeZone?: string) => Effect.Effect<AffectView>;
    /** One typed event from an owner's turn; the outcome, praise or a correction. */
    readonly note: (
      persona: string | undefined,
      event: Exclude<AffectEvent, { kind: "his_turn" }>,
    ) => Effect.Effect<void>;
    /** One of his turns reached this persona: time away resolves and the bond counts the day. */
    readonly heard: (persona: string | undefined, timeZone?: string) => Effect.Effect<void>;
  }
>()("t3/tessaya/TessayaMood") {}

const LEAD = "executive";

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

const decodeState = (json: string, at: number): AffectState => {
  try {
    const s = JSON.parse(json) as Partial<AffectState>;
    return { ...freshAffect(at), ...s };
  } catch {
    return freshAffect(at);
  }
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const settings = yield* ServerSettingsService;
  const config = yield* Effect.serviceOption(ServerConfig.ServerConfig);
  const lock = yield* Semaphore.make(1);

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

  // Off is also the reset: turned back on, every persona starts from its temperament, bond included.
  const clear = sql`DELETE FROM tessaya_affect_state`.pipe(Effect.ignore);

  const read = Effect.fn("TessayaMood.read")(function* (persona: string, now: number) {
    const rows = yield* sql<{ state_json: string }>`
      SELECT state_json FROM tessaya_affect_state WHERE persona = ${persona}
    `.pipe(Effect.orElseSucceed(() => []));
    return rows[0] === undefined ? freshAffect(now) : decodeState(rows[0].state_json, now);
  });
  const write = (persona: string, state: AffectState, reason: string) =>
    sql`
      INSERT INTO tessaya_affect_state (persona, state_json, reason, updated_at)
      VALUES (${persona}, ${JSON.stringify(state)}, ${reason}, ${new Date(state.at).toISOString()})
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
  ) {
    const current = yield* moodSettings;
    if (!current.enabled) return yield* clear;
    const persona = personaOf(personaId)?.id ?? LEAD;
    const now = yield* Clock.currentTimeMillis;
    const { day } = clockIn(now, timeZone ?? "UTC");
    yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const next = appraise(yield* read(persona, now), event(day), now, current.bondCap);
        yield* write(persona, next.state, next.reason);
      }),
    );
  });

  const view: TessayaMood["Service"]["view"] = Effect.fn("TessayaMood.view")(
    function* (personaId, timeZone) {
      const face = personaOf(personaId);
      const persona = face?.id ?? LEAD;
      const now = yield* Clock.currentTimeMillis;
      const current = yield* moodSettings;
      if (!current.enabled) yield* clear;
      return affectView(yield* read(persona, now), persona, {
        now,
        hour: clockIn(now, timeZone ?? "UTC").hour,
        guilt: guiltOf(face?.guilt),
        settings: current,
      });
    },
  );

  return TessayaMood.of({
    view,
    note: Effect.fn("TessayaMood.note")(function* (persona, event) {
      yield* apply(persona, () => event, undefined);
    }),
    heard: Effect.fn("TessayaMood.heard")(function* (persona, timeZone) {
      yield* apply(persona, (day) => ({ kind: "his_turn", day }), timeZone);
    }),
  });
});

export const layer = Layer.effect(TessayaMood, make);
