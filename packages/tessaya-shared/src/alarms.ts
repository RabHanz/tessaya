/**
 * Alarms and spoken wake-ups (M-108, Director 20 Nov 07:27: "wake me up around 8:45"): kept as her commitments with
 * `ref` "alarm", so they are durable on her brain and show in Coming up. These are the pure rules: when one rings, how
 * loud each ring is, and the one line she says when it is set.
 */

/** A commitment's `ref` that makes it an alarm. */
export const ALARM_REF = "alarm";
export const isAlarm = (c: { readonly ref?: string | undefined }): boolean =>
  c.ref === ALARM_REF || (c.ref?.startsWith(`${ALARM_REF}:`) ?? false);

/** Each ring a little louder (percent), a minute apart; then she stops on her own. */
export const RING_VOLUMES = [25, 40, 55, 70, 85] as const;
export const RING_GAP_MS = 60_000;
/** Snooze when he gives no length. */
export const SNOOZE_MINUTES = 9;
/** Due this long ago when her brain came back: rung late, said so. Older: missed, and kept as missed. */
export const LATE_RING_MS = 30 * 60_000;

/** The local wall clock in a zone: its date parts and minutes of the day. */
const local = (ms: number, timeZone: string) => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(ms)
      .map((p) => [p.type, p.value]),
  );
  return {
    minutes: Number(parts["hour"]) * 60 + Number(parts["minute"]),
    seconds: Number(parts["second"]),
  };
};

/**
 * The next time the clock in `timeZone` reads `hh:mm` after `now` (today, else tomorrow); null for a clock that is not
 * one ("25:00", "8.45pm").
 */
export const nextClock = (clock: string, now: number, timeZone: string): number | null => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(clock.trim());
  if (m === null) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  const here = local(now, timeZone);
  const startOfMinute = now - here.seconds * 1000 - (now % 1000);
  let ahead = hour * 60 + minute - here.minutes;
  if (ahead <= 0) ahead += 24 * 60;
  return startOfMinute + ahead * 60_000;
};

/** "8:45" or "20:45" as he likes times, in the house's zone. */
export const clockIn = (ms: number, timeZone: string, hours: "12h" | "24h" = "12h"): string =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: hours === "24h" ? "2-digit" : "numeric",
    minute: "2-digit",
    hourCycle: hours === "24h" ? "h23" : "h12",
  })
    .format(ms)
    .toLowerCase();

/** How far off, in words she can say: "in about an hour", "in 25 minutes", "in about 9 hours". */
export const inWords = (ms: number): string => {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 55) return `in ${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  return hours === 1 ? "in about an hour" : `in about ${hours} hours`;
};

/** The one line she says when it is set: the time and how far off, so a misheard time is caught at once. */
export const alarmSetLine = (input: {
  readonly at: number;
  readonly now: number;
  readonly timeZone: string;
  readonly hours?: "12h" | "24h";
  readonly say?: string | null;
}): string =>
  `${input.say == null || input.say === "" ? "Waking you" : "I'll say it"} at ${clockIn(input.at, input.timeZone, input.hours)}, ${inWords(input.at - input.now)}.`;

/** What a due alarm does now: ring (which ring, how loud), stop ringing (it rang them all), or record it missed. */
export const alarmStep = (input: {
  readonly due: number;
  readonly now: number;
  /** Rings it has made so far, and when the last one was. */
  readonly rung: number;
  readonly lastRingAt: number | null;
}):
  | { readonly kind: "wait" }
  | { readonly kind: "ring"; readonly volume: number; readonly late: boolean }
  | { readonly kind: "done" }
  | { readonly kind: "missed" } => {
  if (input.now < input.due) return { kind: "wait" };
  if (input.rung === 0 && input.now - input.due > LATE_RING_MS) return { kind: "missed" };
  if (input.rung >= RING_VOLUMES.length) return { kind: "done" };
  if (input.lastRingAt !== null && input.now - input.lastRingAt < RING_GAP_MS)
    return { kind: "wait" };
  return {
    kind: "ring",
    volume: RING_VOLUMES[input.rung]!,
    late: input.rung === 0 && input.now - input.due > 2 * 60_000,
  };
};
