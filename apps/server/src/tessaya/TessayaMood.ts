// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
/**
 * Her working mood, one row per persona (EMOTION-SYSTEM phase 1; SPINE-UNIFY §10 CS6): a general mood tied to no one,
 * and a relationship per household member, moved only by that member's identified turns (Director, 16 Nov). Every
 * vessel reads the same label for whoever is identified there, so her face and tone agree. Nothing that decides what
 * she may do reads this service (§7).
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
    yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const next = appraiseFor(
          yield* read(persona, now),
          event(day),
          now,
          current.bondCap,
          member,
        );
        // A person's event with nobody identified moves nothing.
        if (next.reason === null) return;
        yield* write(persona, next.state, next.reason, now);
        yield* PubSub.publish(moved, undefined);
      }),
    );
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
