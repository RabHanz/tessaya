/**
 * The one place presence signals land (B-043), fused per member (`@t3tools/tessaya-shared/presence`). In memory, newest
 * per member, source and vessel: a state, never a history. A worker sends each signal to her brain (BrainHost), so
 * hers is the one estimate and "away" means away from every vessel (B-044).
 */
import { commsCaps } from "@t3tools/tessaya-shared/comms";
import { followOn, optedIn } from "@t3tools/tessaya-shared/household";
import {
  PRESENCE_FORGET_MS,
  PRESENCE_SOURCES,
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
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import { DeviceRegistry } from "../home/DeviceRegistry.ts";
import { makeBrainLink } from "./BrainHost.ts";
import { MemberPreferences } from "./MemberPreferences.ts";

/** Plenty for a household's members and vessels; the oldest go first past it. */
const KEEP = 500;
/** The same signal again within this long stays here: a refresh that soon changes no estimate elsewhere. */
const RESEND_MS = 60_000;

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
    /** Someone arrived, moved, stepped away or was forgotten: faces react now, not on the next sweep. */
    readonly changes: Stream.Stream<void>;
  }
>()("t3/tessaya/TessayaPresence") {}

const keyOf = (s: Omit<PresenceSignal, "at">) =>
  `${s.member ?? ""}\u0000${s.source}\u0000${s.vessel ?? ""}`;
/** A signal renewed sooner than this is the same visit, not a change (a voice heard every turn). */
const SAME_VISIT_MS = 2 * 60_000;

export const make = Effect.gen(function* () {
  const brain = yield* makeBrainLink;
  const kept = new Map<string, PresenceSignal>();
  const changed = yield* PubSub.sliding<void>(1);
  const keep = (key: string, signal: PresenceSignal, now: number) => {
    kept.delete(key);
    kept.set(key, signal);
    for (const [k, s] of kept)
      if (kept.size > KEEP || now - s.at > PRESENCE_FORGET_MS) kept.delete(k);
  };
  const note = Effect.fn("TessayaPresence.note")(function* (
    signal: Omit<PresenceSignal, "at"> & { readonly at?: number },
  ) {
    const now = yield* Clock.currentTimeMillis;
    const key = keyOf(signal);
    const before = kept.get(key);
    const next: PresenceSignal = {
      member: signal.member,
      source: signal.source,
      vessel: signal.vessel,
      ...(signal.guest === true ? { guest: true } : {}),
      at: signal.at ?? now,
    };
    keep(key, next, now);
    const fresh = before === undefined || next.at - before.at >= RESEND_MS;
    // Kept here for this server's own faces; her brain's estimate is the one that decides.
    if (fresh && !(yield* brain.isBrain)) yield* brain.send("presence", { note: next });
    if (
      before === undefined ||
      next.at - before.at >= SAME_VISIT_MS ||
      PRESENCE_SOURCES[signal.source]?.weight === 0
    )
      yield* PubSub.publish(changed, undefined);
  });
  const estimate = Effect.fn("TessayaPresence.estimate")(function* (
    extra: ReadonlyArray<PresenceSignal> = [],
  ) {
    const now = yield* Clock.currentTimeMillis;
    return { ...fusePresence([...kept.values(), ...extra], now), now };
  });
  const forget = Effect.fn("TessayaPresence.forget")(function* (member: string, into?: string) {
    if (!(yield* brain.isBrain))
      yield* brain.send(
        "presence",
        into === undefined ? { forget: member } : { forget: member, into },
      );
    for (const [k, s] of kept)
      if (s.member === member) {
        kept.delete(k);
        if (into !== undefined) {
          const moved = { ...s, member: into };
          kept.set(keyOf(moved), moved);
        }
      }
    yield* PubSub.publish(changed, undefined);
  });
  return TessayaPresence.of({ note, estimate, forget, changes: Stream.fromPubSub(changed) });
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

/** What a member's own vessel says of them: the app came to the front or went away, home or away, a camera saw them. */
export type HereSignal = "foreground" | "background" | "home" | "away" | "seen";
const HERE_SOURCE = {
  foreground: "phoneApp",
  background: "phoneAppAway",
  home: "home",
  away: "away",
  seen: "camera",
} as const;

/**
 * Notes a vessel's report of its own member (the phone over its vessel publish, any client over the household op);
 * the geofence and the camera only with their `location` and `camera` on. Null when noted, else why not.
 */
export const noteHere = Effect.fn("TessayaPresence.noteHere")(function* (
  member: string,
  signal: HereSignal,
  vessel: string | null,
) {
  const presence = yield* Effect.serviceOption(TessayaPresence);
  if (Option.isNone(presence)) return "Presence isn't kept on this server.";
  // Opt-ins read this server's copy: with the members on another server they stay off, never on by mistake.
  const prefs = yield* Effect.serviceOption(MemberPreferences);
  const mine = Option.isNone(prefs) ? {} : yield* prefs.value.of(member);
  if ((signal === "home" || signal === "away") && !optedIn(mine.location))
    return "Their location is off.";
  if (signal === "seen" && !optedIn(mine.camera)) return "Their camera is off.";
  const placed = signal === "foreground" || signal === "seen";
  yield* presence.value.note({
    member,
    source: HERE_SOURCE[signal],
    vessel: placed ? vessel : null,
  });
  return null;
});

/** Who is at this vessel now, members and guests, surest first (`peopleAt`); nobody without the store. */
export const peopleHere = Effect.fn("TessayaPresence.peopleHere")(function* (
  vessel: string,
  bar?: number,
) {
  const presence = yield* Effect.serviceOption(TessayaPresence);
  return Option.isNone(presence) ? [] : peopleAt(yield* presence.value.estimate(), vessel, bar);
});
