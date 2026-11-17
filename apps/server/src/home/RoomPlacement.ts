/**
 * Which hub a Tessel should be on when one of his servers is slow, not dead (B-044). Each server rates its own host
 * "ok" or "degraded" with time hysteresis and shares only the rating; the server holding the device moves it to the
 * first ok hub in his order when its own goes degraded, and back once his first choice is ok again. The device has one
 * MQTT session, so the loop on the hub it is on is the only one that answers. Pure.
 */

import type { HostHealth } from "@t3tools/tessaya-contracts";

/**
 * The figures a rating reads, from the health model (TessayaHealth); PSI in percent, null where the kernel has none.
 * Stage times are not read here: the room loop already sends each turn to the quickest recogniser (recognisers.ts).
 */
export type HostSample = Pick<HostHealth, "memAvailMb" | "memPsiFull10">;

export type HostLevel = "ok" | "degraded";

export interface LevelState {
  /** Null until figures have held long enough to rate it (a server just started): not a target, and never moved off. */
  readonly level: HostLevel | null;
  /** The level the figures point at now, other than `level`, and since when (epoch ms). */
  readonly pending: { readonly to: HostLevel; readonly since: number } | null;
}

export const UNRATED: LevelState = { level: null, pending: null };

// From the memory lane's onnyx readings on 17 Nov: at PSI full 15-30% the loop's link to its own hub dropped for 1-10 s.
const BAD_PSI_FULL = 20;
const BAD_AVAIL_MB = 600;
const GOOD_PSI_FULL = 5;
const GOOD_AVAIL_MB = 1_200;
/** Bad figures held this long make a host degraded. */
export const DEGRADE_MS = 60_000;
/** Good figures held this long make it ok again, so a conversation is not moved back and forth. */
export const RECOVER_MS = 5 * 60_000;
/** No second move sooner than this after one, whatever the figures say. */
export const DWELL_MS = 3 * 60_000;

// No memory figure (not Linux): never rated, so never a target and never moved off.
const bad = (s: HostSample) =>
  s.memAvailMb !== null && ((s.memPsiFull10 ?? 0) >= BAD_PSI_FULL || s.memAvailMb < BAD_AVAIL_MB);

const good = (s: HostSample) =>
  s.memAvailMb !== null && (s.memPsiFull10 ?? 0) < GOOD_PSI_FULL && s.memAvailMb > GOOD_AVAIL_MB;

/**
 * One reading of this host. A change must hold to take, and a reading on the other side restarts the hold; figures
 * between the bands, or none, change nothing (PSI swinging 15-30% still degrades).
 */
export const rateHost = (prev: LevelState, sample: HostSample | null, now: number): LevelState => {
  const toward = sample === null ? null : bad(sample) ? "degraded" : good(sample) ? "ok" : null;
  if (toward === null) return prev;
  if (toward === prev.level)
    return prev.pending === null ? prev : { level: prev.level, pending: null };
  const since = prev.pending?.to === toward ? prev.pending.since : now;
  const hold = toward === "degraded" ? DEGRADE_MS : RECOVER_MS;
  return now - since >= hold
    ? { level: toward, pending: null }
    : { level: prev.level, pending: { to: toward, since } };
};

export interface Move {
  readonly to: string;
  readonly why: "degraded" | "recovered";
}

/**
 * Where the device on `current` should go now, or null to stay. `order` is his hub order (environment ids, first choice
 * first); `levels` every server's shared rating, missing when unknown; `movedAt` the last placement on any server.
 */
export const placeRoom = (input: {
  readonly order: ReadonlyArray<string>;
  readonly current: string;
  readonly levels: Readonly<Record<string, HostLevel | undefined>>;
  readonly movedAt: number;
  readonly now: number;
}): Move | null => {
  if (input.now - input.movedAt < DWELL_MS) return null;
  const ok = (env: string) => input.levels[env] === "ok";
  if (input.levels[input.current] === "degraded") {
    const to = input.order.find((env) => env !== input.current && ok(env));
    return to === undefined ? null : { to, why: "degraded" };
  }
  const at = input.order.indexOf(input.current);
  const to = input.order.slice(0, at < 0 ? input.order.length : at).find(ok);
  return to === undefined ? null : { to, why: "recovered" };
};
