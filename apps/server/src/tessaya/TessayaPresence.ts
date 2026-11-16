/**
 * The one place presence signals land (B-043), fused per member (`@t3tools/tessaya-shared/presence`). In memory, newest
 * per member, source and vessel: a state, never a history. Each signal also goes to his other servers (DeviceSync
 * `@presence`), so every server's estimate is the same and "away" means away from every vessel (B-044).
 */
import { commsCaps } from "@t3tools/tessaya-shared/comms";
import { followOn } from "@t3tools/tessaya-shared/household";
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
import { DeviceSync } from "../home/DeviceSync.ts";
import { MemberPreferences } from "./MemberPreferences.ts";

/** Plenty for a household's members and vessels; the oldest go first past it. */
const KEEP = 500;
const PRESENCE_RECORD = "@presence";
/** The same signal again within this long stays here: a refresh that soon changes no estimate elsewhere. */
const RESEND_MS = 60_000;

const decodeSignal = (v: unknown): PresenceSignal | null => {
  if (typeof v !== "object" || v === null) return null;
  const s = v as Record<string, unknown>;
  return (s["member"] === null || typeof s["member"] === "string") &&
    typeof s["source"] === "string" &&
    (s["vessel"] === null || typeof s["vessel"] === "string") &&
    typeof s["at"] === "number"
    ? {
        member: s["member"] as string | null,
        source: s["source"],
        vessel: s["vessel"] as string | null,
        ...(s["guest"] === true ? { guest: true } : {}),
        at: s["at"],
      }
    : null;
};

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
  const sync = yield* Effect.serviceOption(DeviceSync);
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
    if (Option.isSome(sync) && (before === undefined || next.at - before.at >= RESEND_MS))
      yield* sync.value.put(PRESENCE_RECORD, key, next, "changed", next.at);
    if (
      before === undefined ||
      next.at - before.at >= SAME_VISIT_MS ||
      PRESENCE_SOURCES[signal.source]?.weight === 0
    )
      yield* PubSub.publish(changed, undefined);
  });
  if (Option.isSome(sync))
    yield* sync.value.onRecord(PRESENCE_RECORD, (key, v) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const signal = decodeSignal(v);
        // null: forgotten on another server.
        if (signal === null) return void kept.delete(key);
        if ((kept.get(key)?.at ?? 0) < signal.at) keep(key, signal, now);
      }),
    );
  const estimate = Effect.fn("TessayaPresence.estimate")(function* (
    extra: ReadonlyArray<PresenceSignal> = [],
  ) {
    const now = yield* Clock.currentTimeMillis;
    return { ...fusePresence([...kept.values(), ...extra], now), now };
  });
  // Forgetting reaches his other servers: each forgotten key goes as null, a moved one as its new key.
  const forget = Effect.fn("TessayaPresence.forget")(function* (member: string, into?: string) {
    for (const [k, s] of kept)
      if (s.member === member) {
        kept.delete(k);
        if (Option.isSome(sync)) yield* sync.value.put(PRESENCE_RECORD, k, null, "changed");
        if (into !== undefined) {
          const moved = { ...s, member: into };
          kept.set(keyOf(moved), moved);
          if (Option.isSome(sync))
            yield* sync.value.put(PRESENCE_RECORD, keyOf(moved), moved, "changed", moved.at);
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

/** Who is at this vessel now, members and guests, surest first (`peopleAt`); nobody without the store. */
export const peopleHere = Effect.fn("TessayaPresence.peopleHere")(function* (
  vessel: string,
  bar?: number,
) {
  const presence = yield* Effect.serviceOption(TessayaPresence);
  return Option.isNone(presence) ? [] : peopleAt(yield* presence.value.estimate(), vessel, bar);
});
