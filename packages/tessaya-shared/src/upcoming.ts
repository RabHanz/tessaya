// @effect-diagnostics globalDate:off
/**
 * Coming up, the pure part every surface shares: which items show, in what order, how each one's countdown reads, and
 * when a label next changes, so no list repaints every second while nothing is about to happen.
 */
import type { UpcomingItem } from "@t3tools/tessaya-contracts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** A timed item just past its time stays this long as "running now", until its source says it ran. */
export const RUNNING_GRACE_MS = 2 * MINUTE;
export const UPCOMING_DAYS = 7;

/**
 * Timed items within `days`, soonest first, then the ones that wait on a condition. A date with no time of day stays
 * until its day is over; a timed item stays a moment past its time.
 */
export const orderUpcoming = (
  items: ReadonlyArray<UpcomingItem>,
  now: number,
  days = UPCOMING_DAYS,
): ReadonlyArray<UpcomingItem> => {
  const until = now + days * DAY;
  const timed = items.filter(
    (i) =>
      i.at !== null &&
      i.at <= until &&
      (i.allDay === true ? i.at + DAY > now : i.at >= now - RUNNING_GRACE_MS),
  );
  const waiting = items.filter((i) => i.at === null);
  return [
    ...timed.toSorted((a, b) => a.at! - b.at! || a.title.localeCompare(b.title)),
    ...waiting.toSorted(
      (a, b) => a.source.localeCompare(b.source) || a.title.localeCompare(b.title),
    ),
  ];
};

/** "in 45 s", "in 18 min", "in 2 h 5 min", "in 3 days", "today", "running now"; "waiting" for a condition. */
export const countdownText = (item: UpcomingItem, now: number): string => {
  if (item.at === null) return "waiting";
  if (item.paused) return "paused";
  const left = item.at - now;
  if (item.allDay === true) {
    const days = Math.floor((item.at - startOfDay(now)) / DAY);
    return days <= 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`;
  }
  if (left <= 0) return "running now";
  if (left < MINUTE) return `in ${Math.ceil(left / 1000)} s`;
  const minutes = Math.round(left / MINUTE);
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest === 0 ? `in ${hours} h` : `in ${hours} h ${rest} min`;
  const days = Math.round(hours / 24);
  return `in ${days} day${days === 1 ? "" : "s"}`;
};

/** How long until a label changes: each second only while something live is in its last minute, else on the minute. */
export const nextTickMs = (items: ReadonlyArray<UpcomingItem>, now: number): number =>
  items.some(
    (i) => i.at !== null && !i.paused && i.allDay !== true && i.at > now && i.at - now <= MINUTE,
  )
    ? 1000
    : MINUTE - (now % MINUTE);

export type UpcomingGroup = "soon" | "today" | "week" | "waiting";
export const UPCOMING_GROUP_LABEL: Record<UpcomingGroup, string> = {
  soon: "Within the hour",
  today: "Later today",
  week: "Next 7 days",
  waiting: "Waiting on something",
};

const startOfDay = (ms: number) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** The heading an item sits under, by the viewer's own day. */
export const upcomingGroup = (item: UpcomingItem, now: number): UpcomingGroup => {
  if (item.at === null) return "waiting";
  if (item.allDay !== true && item.at - now < HOUR) return "soon";
  return startOfDay(item.at) === startOfDay(now) ? "today" : "week";
};

/**
 * The next time a clock time ("22:40" or "22:40:00", as Home Assistant's time trigger holds it) comes round, given the
 * same zone's clock now in seconds since midnight. A time equal to now is a day away.
 */
export const nextDailyAt = (at: string, clockNowSeconds: number, now: number): number | null => {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(at.trim());
  if (m === null) return null;
  const target = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] ?? 0);
  if (target >= 86_400) return null;
  const wait = (target - clockNowSeconds + 86_400) % 86_400 || 86_400;
  return now - (now % 1000) + wait * 1000;
};

export const UPCOMING_SOURCE_LABEL: Record<UpcomingItem["source"], string> = {
  house: "House",
  reminder: "Reminder",
  task: "Scheduled task",
  standing: "Standing job",
  rule: "Rule",
  move: "Waiting change",
  date: "Date",
};

/** The time under a countdown, on the viewer's own clock: "Thu 22:40", or the date alone for a date. */
export const upcomingClock = (item: UpcomingItem): string | null =>
  item.at === null
    ? null
    : new Date(item.at).toLocaleString(
        [],
        item.allDay === true
          ? { weekday: "short", day: "numeric", month: "short" }
          : { weekday: "short", hour: "2-digit", minute: "2-digit" },
      );
