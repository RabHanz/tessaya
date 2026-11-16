/**
 * The one place presence signals land (B-043): every vessel's turn, the Tessels and the desktop note what they saw, and
 * the turn, comms and job news read one fused estimate per member (`@t3tools/tessaya-shared/presence`). In this
 * server's memory only, newest per member, source and vessel: a state, never a history, so a restart forgets it.
 */
import { commsCaps } from "@t3tools/tessaya-shared/comms";
import { followOn } from "@t3tools/tessaya-shared/household";
import {
  PRESENCE_FORGET_MS,
  fusePresence,
  peopleAt,
  routeProactive,
  type PresenceSignal,
  type ProactiveKind,
} from "@t3tools/tessaya-shared/presence";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { DeviceRegistry } from "../home/DeviceRegistry.ts";
import { MemberPreferences } from "./MemberPreferences.ts";

/** Plenty for a household's members and vessels; the oldest go first past it. */
const KEEP = 500;

export class TessayaPresence extends Context.Service<
  TessayaPresence,
  {
    /** One signal now (its `at` defaults to now). */
    readonly note: (
      signal: Omit<PresenceSignal, "at"> & { readonly at?: number },
    ) => Effect.Effect<void>;
    /** Drops one person's signals ("forget me"), or moves them onto `into` (two people found to be one). */
    readonly forget: (member: string, into?: string) => Effect.Effect<void>;
    /** Every member's estimate from the kept signals plus these read-time ones (devices connected now). */
    readonly estimate: (
      extra?: ReadonlyArray<PresenceSignal>,
    ) => Effect.Effect<ReturnType<typeof fusePresence> & { readonly now: number }>;
  }
>()("t3/tessaya/TessayaPresence") {}

const keyOf = (s: Omit<PresenceSignal, "at">) =>
  `${s.member ?? ""}\u0000${s.source}\u0000${s.vessel ?? ""}`;

export const make = Effect.sync(() => {
  const kept = new Map<string, PresenceSignal>();
  const note = Effect.fn("TessayaPresence.note")(function* (
    signal: Omit<PresenceSignal, "at"> & { readonly at?: number },
  ) {
    const now = yield* Clock.currentTimeMillis;
    const key = keyOf(signal);
    kept.delete(key);
    kept.set(key, {
      member: signal.member,
      source: signal.source,
      vessel: signal.vessel,
      ...(signal.guest === true ? { guest: true } : {}),
      at: signal.at ?? now,
    });
    for (const [k, s] of kept)
      if (kept.size > KEEP || now - s.at > PRESENCE_FORGET_MS) kept.delete(k);
  });
  const estimate = Effect.fn("TessayaPresence.estimate")(function* (
    extra: ReadonlyArray<PresenceSignal> = [],
  ) {
    const now = yield* Clock.currentTimeMillis;
    return { ...fusePresence([...kept.values(), ...extra], now), now };
  });
  const forget = (member: string, into?: string) =>
    Effect.sync(() => {
      for (const [k, s] of kept)
        if (s.member === member) {
          kept.delete(k);
          if (into !== undefined) kept.set(keyOf({ ...s, member: into }), { ...s, member: into });
        }
    });
  return TessayaPresence.of({ note, estimate, forget });
});

export const layer = Layer.effect(TessayaPresence, make);

/**
 * Where a line of hers for one member goes (B-043): the vessel they are nearest, or what `routeProactive` says for its
 * kind; null keeps it quiet (out loud nowhere). Without the store (a test), it stays on the origin as before.
 */
export const whereToSay = Effect.fn("TessayaPresence.whereToSay")(function* (
  member: string,
  origin: string | null,
  kind: ProactiveKind = "personal",
) {
  const presence = yield* Effect.serviceOption(TessayaPresence);
  if (Option.isNone(presence)) return origin;
  const registry = yield* Effect.serviceOption(DeviceRegistry);
  const devices = Option.isNone(registry) ? [] : yield* registry.value.list;
  const prefs = yield* Effect.serviceOption(MemberPreferences);
  const follow = followOn(
    Option.isNone(prefs) ? undefined : (yield* prefs.value.of(member)).follow,
  );
  const route = routeProactive({
    kind,
    member,
    origin,
    estimate: yield* presence.value.estimate(),
    speakers: new Set(
      devices.filter((d) => d.online && commsCaps(d).audioOut).map((d) => d.deviceId),
    ),
    follow,
  });
  yield* Effect.annotateCurrentSpan({ action: route.action, why: route.why });
  return route.action === "speak" ? route.vessel : null;
});

/** Who is at this vessel now, members and guests, surest first (`peopleAt`); nobody without the store. */
export const peopleHere = Effect.fn("TessayaPresence.peopleHere")(function* (
  vessel: string,
  bar?: number,
) {
  const presence = yield* Effect.serviceOption(TessayaPresence);
  return Option.isNone(presence) ? [] : peopleAt(yield* presence.value.estimate(), vessel, bar);
});
