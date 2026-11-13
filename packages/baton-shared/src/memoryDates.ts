/**
 * What his memories say is coming up (Memory v2 step 8): a birthday or anniversary each year, a dated plan, a weekday
 * he named lately, and anything kept only until a date. Read by "what needs me", the brief and the room's
 * "what's coming up", so memory feeds what she notices. Pure; dates in his zone.
 * @module baton-shared/memoryDates
 */
import type { MemoryItem } from "./memory.ts";
import type { NeedItem } from "./needsMe.ts";

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const ORDINALS: Readonly<Record<string, number>> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
  eleventh: 11,
  twelfth: 12,
  thirteenth: 13,
  fourteenth: 14,
  fifteenth: 15,
  sixteenth: 16,
  seventeenth: 17,
  eighteenth: 18,
  nineteenth: 19,
  twentieth: 20,
  "twenty-first": 21,
  "twenty-second": 22,
  "twenty-third": 23,
  "twenty-fourth": 24,
  "twenty-fifth": 25,
  "twenty-sixth": 26,
  "twenty-seventh": 27,
  "twenty-eighth": 28,
  "twenty-ninth": 29,
  thirtieth: 30,
  "thirty-first": 31,
};
const DAY = 86_400_000;

/** A calendar day in his zone, as the epoch ms of its start (UTC midnight of that date, compared only to its kind). */
const dayOf = (ms: number, zone: string): { y: number; m: number; d: number } => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .format(ms)
    .split("-")
    .map(Number);
  return { y: parts[0]!, m: parts[1]! - 1, d: parts[2]! };
};
const dateMs = (y: number, m: number, d: number) => Date.UTC(y, m, d);

/** "the ninth of April", "9th April", "April 9", "9 April" → month and day. */
const monthDay = (text: string): { m: number; d: number } | null => {
  const t = text.toLowerCase();
  const month = `(${MONTHS.join("|")})`;
  const day = `(\\d{1,2})(?:st|nd|rd|th)?|(${Object.keys(ORDINALS).join("|")})`;
  const a = new RegExp(`\\b(?:the )?(?:${day}) (?:of )?${month}\\b`).exec(t);
  if (a !== null)
    return { m: MONTHS.indexOf(a[3]!), d: a[1] !== undefined ? Number(a[1]) : ORDINALS[a[2]!]! };
  const b = new RegExp(`\\b${month} (?:the )?(?:${day})\\b`).exec(t);
  if (b !== null)
    return { m: MONTHS.indexOf(b[1]!), d: b[2] !== undefined ? Number(b[2]) : ORDINALS[b[3]!]! };
  return null;
};

export interface ComingUp {
  readonly item: MemoryItem;
  /** The start of the day it falls on (UTC midnight of that date in his zone). */
  readonly on: number;
  /** Whole days from today in his zone: 0 today, 1 tomorrow. */
  readonly inDays: number;
  /** "every year" (a birthday), "once" (a dated plan or a weekday he named), "until" (kept only until then). */
  readonly kind: "every year" | "once" | "until";
}

/**
 * What falls within `days` of today, soonest first: each year for birthdays and anniversaries, a dated plan once, a
 * weekday named in an item from the last week (the next one after it was said), and a time-bound item's end.
 */
export const comingUp = (
  items: ReadonlyArray<MemoryItem>,
  now: number,
  zone: string,
  days = 7,
): ReadonlyArray<ComingUp> => {
  const today = dayOf(now, zone);
  const start = dateMs(today.y, today.m, today.d);
  const within = (on: number) => on >= start && on <= start + days * DAY;
  const out: Array<ComingUp> = [];
  for (const item of items) {
    if (item.supersededBy !== null || item.proposed) continue;
    const text = item.text;
    const md = monthDay(text);
    let found: { on: number; kind: ComingUp["kind"] } | null = null;
    if (md !== null) {
      const year = /\b(20\d\d)\b/.exec(text);
      if (year !== null) found = { on: dateMs(Number(year[1]), md.m, md.d), kind: "once" };
      else if (/\b(birthday|anniversary|born)\b/i.test(text)) {
        const thisYear = dateMs(today.y, md.m, md.d);
        found = {
          on: thisYear >= start ? thisYear : dateMs(today.y + 1, md.m, md.d),
          kind: "every year",
        };
      } else {
        const said = dayOf(Date.parse(item.updatedAt), zone);
        const that = dateMs(said.y, md.m, md.d);
        found = {
          on: that >= dateMs(said.y, said.m, said.d) ? that : dateMs(said.y + 1, md.m, md.d),
          kind: "once",
        };
      }
    } else {
      const wd =
        /\b(?:on|this|next|by) (sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i.exec(
          text,
        );
      const saidAt = Date.parse(item.updatedAt);
      // A weekday means the next one after it was said, so only lately said ones are still ahead.
      if (
        wd !== null &&
        now - saidAt <= 7 * DAY &&
        !/\b(every|each|always|usually)\b/i.test(text)
      ) {
        const said = dayOf(saidAt, zone);
        const saidDay = dateMs(said.y, said.m, said.d);
        // 1 January 1970 was a Thursday (4).
        const dow = (Math.floor(saidDay / DAY) + 4) % 7;
        const want = WEEKDAYS.indexOf(wd[1]!.toLowerCase());
        const ahead = (want - dow + 7) % 7 || 7;
        found = { on: saidDay + ahead * DAY, kind: "once" };
      }
    }
    if (found === null && item.expiresAt !== null && item.kind !== "episode") {
      const end = dayOf(Date.parse(item.expiresAt), zone);
      found = { on: dateMs(end.y, end.m, end.d), kind: "until" };
    }
    if (found !== null && within(found.on))
      out.push({
        item,
        on: found.on,
        inDays: Math.round((found.on - start) / DAY),
        kind: found.kind,
      });
  }
  return out.toSorted((a, b) => a.on - b.on);
};

/** "today", "tomorrow", "in 3 days". */
export const whenSaid = (inDays: number): string =>
  inDays === 0 ? "today" : inDays === 1 ? "tomorrow" : `in ${inDays} days`;

/** Coming-up memories as "what needs me" items, so the ranking, the brief and the initiative policy weigh them. */
export const needsFromMemory = (
  items: ReadonlyArray<MemoryItem>,
  now: number,
  zone: string,
): ReadonlyArray<NeedItem> =>
  comingUp(items, now, zone).map((c) => ({
    id: `memory:${c.item.id}:${c.on}`,
    source: "memory" as const,
    title: c.item.text,
    why:
      c.kind === "until"
        ? `it holds only until ${whenSaid(c.inDays)}`
        : `it's ${whenSaid(c.inDays)}`,
    // A birthday or a plan matters more than a note that runs out.
    weight: c.kind === "until" ? 20 : 40,
    dueAt: c.on,
    ref: c.item.id,
  }));
