// @effect-diagnostics nodeBuiltinImport:off
/**
 * Alarms and spoken wake-ups (M-108, Director 20 Nov 07:27 on Tumble: "wake me up around 8:45"). Each is one of her
 * commitments with `ref` "alarm", so it is durable on her brain and in Coming up; her brain alone rings them. A ring is
 * her own voice on the Tessel nearest him (presence), soft first and louder a minute apart, until he stops or snoozes
 * it (`tessaya_alarm`) or she has rung them all. Due while her brain was down: rung late and said so, or kept as missed.
 */
import * as NodeCrypto from "node:crypto";

import type { TessayaCommitment } from "@t3tools/tessaya-contracts";
import {
  ALARM_REF,
  alarmSetLine,
  alarmStep,
  clockIn,
  isAlarm,
  nextClock,
  SNOOZE_MINUTES,
} from "@t3tools/tessaya-shared/alarms";
import { OWNER_MEMBER_ID } from "@t3tools/tessaya-shared/household";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";

import { HomeAssistantService } from "../home/HomeAssistantService.ts";
import { HomeDevices } from "../home/HomeDevices.ts";
import { isBrain } from "./BrainHost.ts";
import { houseZone } from "./houseZone.ts";
import { TessayaCommitmentService } from "./TessayaCommitmentService.ts";
import { TessayaPresence } from "./TessayaPresence.ts";
import { emitAction } from "./turnActions.ts";

const TICK = "5 seconds";
const BY = { who: "Tessaya's alarm", surface: "assistant" } as const;

export class TessayaAlarms extends Context.Service<
  TessayaAlarms,
  {
    /** One alarm at `clock` ("08:45", the house's time) or in `inMinutes`; what to say, or none for a wake-up. */
    readonly set: (input: {
      readonly clock?: string;
      readonly inMinutes?: number;
      readonly say?: string | null;
    }) => Effect.Effect<{ readonly id: string | null; readonly line: string }>;
    /** Stops the ringing one (else the next one due), and says which. */
    readonly stop: Effect.Effect<{ readonly line: string }>;
    /** Rings the ringing one again in `minutes` (9 when he gives none). */
    readonly snooze: (minutes?: number) => Effect.Effect<{ readonly line: string }>;
    readonly list: Effect.Effect<ReadonlyArray<TessayaCommitment>>;
    /** One look at what is due: ring, stop ringing, or record a missed one. Her brain runs it every few seconds. */
    readonly tick: Effect.Effect<void>;
  }
>()("t3/tessaya/TessayaAlarms") {}

export const make = Effect.gen(function* () {
  const commitments = yield* TessayaCommitmentService;
  // The house, devices and presence as this layer was built with them: a tool call's own context has none of them.
  const built = yield* Effect.context<never>();
  const here = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.provideContext(effect, built);
  // Rings so far per alarm, in this process: a restart starts its ringing over, softly.
  const rings = new Map<string, { rung: number; lastRingAt: number | null; device: string }>();

  const open = Effect.map(commitments.list, (all) =>
    all.filter((c) => isAlarm(c) && c.status === "open" && c.due !== null),
  );
  const save = (c: TessayaCommitment) => commitments.upsert([c]).pipe(Effect.ignore);
  const close = Effect.fn("TessayaAlarms.close")(function* (
    c: TessayaCommitment,
    status: "done" | "dropped",
  ) {
    const now = yield* Clock.currentTimeMillis;
    rings.delete(c.id);
    yield* save({ ...c, status, updatedAt: now, closedAt: now });
  });

  /** The Tessel nearest him now (presence), else the first one set up. */
  const nearestTessel = Effect.gen(function* () {
    const home = yield* Effect.serviceOption(HomeAssistantService);
    const ids = Option.isNone(home)
      ? []
      : (yield* home.value.devices).flatMap((d) => (d.deviceId === null ? [] : [d.deviceId]));
    const presence = yield* Effect.serviceOption(TessayaPresence);
    const him = Option.isNone(presence)
      ? undefined
      : (yield* presence.value.estimate()).members.find((m) => m.member === OWNER_MEMBER_ID);
    const near = him?.nearest?.vessel;
    return near !== undefined && ids.includes(near) ? near : (ids[0] ?? null);
  });

  const ring = Effect.fn("TessayaAlarms.ring")(function* (
    c: TessayaCommitment,
    volume: number,
    late: boolean,
    now: number,
  ) {
    const devices = yield* Effect.serviceOption(HomeDevices);
    const held = rings.get(c.id);
    const device = held?.device ?? (yield* nearestTessel);
    if (device === null || Option.isNone(devices)) return;
    const zone = yield* houseZone();
    const clock = clockIn(now, zone);
    const said =
      c.text !== ALARM_TEXT
        ? c.text
        : late
          ? `It's ${clock}. Your alarm was for ${clockIn(c.due!, zone)}; sorry I'm late. Time to get up.`
          : `Good morning. It's ${clock}. Time to get up.`;
    // shortcut: her volume stays where the last ring left it; restore his own level once a ring knows it.
    yield* devices.value.command(device, { op: "volume", to: volume }, BY).pipe(Effect.ignore);
    yield* devices.value.command(device, { op: "say", text: said }, BY).pipe(Effect.ignore);
    rings.set(c.id, { rung: (held?.rung ?? 0) + 1, lastRingAt: now, device });
    yield* emitAction({
      kind: "alarm.ring",
      actor: { kind: "rule", id: "alarm", certainty: 1 },
      subject: device,
      outcome: late ? "late" : "rang",
      data: { alarm: c.id, ring: (held?.rung ?? 0) + 1, volume },
    });
  });

  const tick = Effect.gen(function* () {
    if (!(yield* isBrain)) return;
    const now = yield* Clock.currentTimeMillis;
    for (const c of yield* open) {
      const held = rings.get(c.id);
      const step = alarmStep({
        due: c.due!,
        now,
        rung: held?.rung ?? 0,
        lastRingAt: held?.lastRingAt ?? null,
      });
      if (step.kind === "ring") yield* ring(c, step.volume, step.late, now);
      else if (step.kind === "done") yield* close(c, "done");
      else if (step.kind === "missed") {
        yield* close(c, "dropped");
        yield* emitAction({
          kind: "alarm.missed",
          actor: { kind: "rule", id: "alarm", certainty: 1 },
          subject: c.id,
          outcome: "missed",
          data: { due: c.due },
        });
      }
    }
  }).pipe(Effect.ignoreCause({ log: true }));

  /** The one ringing now, else the next one due. */
  const current = Effect.map(
    open,
    (all) =>
      all.toSorted(
        (a, b) => (rings.has(b.id) ? 1 : 0) - (rings.has(a.id) ? 1 : 0) || a.due! - b.due!,
      )[0],
  );

  const setIn = Effect.fn("TessayaAlarms.set")(function* (input: {
    readonly clock?: string;
    readonly inMinutes?: number;
    readonly say?: string | null;
  }) {
    const now = yield* Clock.currentTimeMillis;
    const zone = yield* houseZone();
    const at =
      input.clock !== undefined
        ? nextClock(input.clock, now, zone)
        : input.inMinutes !== undefined && input.inMinutes > 0 && input.inMinutes <= 24 * 60
          ? now + Math.round(input.inMinutes) * 60_000
          : null;
    if (at === null)
      return { id: null, line: "Give me a time like 08:45, or how many minutes from now." };
    const id = `alarm-${NodeCrypto.randomBytes(6).toString("hex")}`;
    const say = input.say?.trim() || null;
    yield* commitments
      .upsert([
        {
          id,
          text: say ?? ALARM_TEXT,
          owner: "tessaya",
          due: at,
          status: "open",
          source: "assistant",
          createdAt: now,
          ref: ALARM_REF,
        },
      ])
      .pipe(Effect.ignore);
    return { id, line: alarmSetLine({ at, now, timeZone: zone, say }) };
  });
  const snoozeIn = Effect.fn("TessayaAlarms.snooze")(function* (minutes?: number) {
    const c = yield* current;
    if (c === undefined) return { line: "There's no alarm to snooze." };
    const now = yield* Clock.currentTimeMillis;
    const length = Math.max(1, Math.min(60, Math.round(minutes ?? SNOOZE_MINUTES)));
    rings.delete(c.id);
    yield* save({
      ...c,
      due: now + length * 60_000,
      updatedAt: now,
      ref: `${ALARM_REF}:snoozed`,
    });
    return { line: `Snoozed for ${length} minutes.` };
  });
  return TessayaAlarms.of({
    set: Effect.fn("TessayaAlarms.setHere")((input) => here(setIn(input))),
    stop: here(
      Effect.gen(function* () {
        const c = yield* current;
        if (c === undefined) return { line: "There's no alarm set." };
        yield* close(c, "done");
        const zone = yield* houseZone();
        return { line: `Stopped your ${clockIn(c.due!, zone)} alarm.` };
      }),
    ),
    snooze: Effect.fn("TessayaAlarms.snoozeHere")((minutes) => here(snoozeIn(minutes))),
    list: open,
    tick: here(tick),
  });
});

/** The text an alarm with nothing of his own to say is kept under (Coming up shows it). */
export const ALARM_TEXT = "Wake-up alarm";

export const layer = Layer.effect(TessayaAlarms, make).pipe(
  Layer.tap((context) =>
    Context.get(context, TessayaAlarms).tick.pipe(
      Effect.repeat(Schedule.spaced(TICK)),
      Effect.forkScoped,
    ),
  ),
);
