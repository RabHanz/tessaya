// @effect-diagnostics globalDate:off
/**
 * Insights (Wispr parity), from the local turn log only: words per minute against his own past,
 * what Tessaya fixed, total words with the month's change, usage by kind of app, and a streak
 * calendar. Nothing is compared with other people, because there are no other people's numbers;
 * the one outside reference is a rough typing speed, labelled as such.
 */
import { categoryForApp, CATEGORY_LABELS, type StyleCategory } from "./writingStyle.ts";

export interface InsightTurn {
  readonly at: string;
  readonly kind: "dictation" | "spoken";
  readonly app: string;
  readonly raw: string;
  readonly cleaned: string | null;
  readonly seconds: number | null;
}

export const TYPING_REFERENCE_WPM = 40;
const DAY = 86_400_000;

export const wordsIn = (text: string): number =>
  text.trim() === "" ? 0 : text.trim().split(/\s+/).length;

const tokens = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}' ]+/gu, " ")
    .split(/\s+/)
    .filter((t) => t !== "");

/** Words Tessaya changed: how many heard words are not in the written text, or the reverse, whichever is more. */
export const countFixes = (raw: string, cleaned: string): number => {
  const bag = new Map<string, number>();
  for (const t of tokens(raw)) bag.set(t, (bag.get(t) ?? 0) + 1);
  let added = 0;
  for (const t of tokens(cleaned)) {
    const n = bag.get(t) ?? 0;
    if (n > 0) bag.set(t, n - 1);
    else added += 1;
  }
  let removed = 0;
  for (const n of bag.values()) removed += n;
  return Math.max(added, removed);
};

const localDay = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export interface DeepInsights {
  readonly wpm: {
    readonly recent: number | null;
    readonly before: number | null;
    readonly typingReference: number;
  };
  readonly fixes: { readonly words: number; readonly dictations: number };
  readonly totalWords: number;
  readonly monthWords: number;
  readonly previousMonthWords: number;
  readonly byCategory: ReadonlyArray<{ readonly label: string; readonly words: number }>;
  readonly calendar: ReadonlyArray<{
    readonly date: string;
    readonly words: number;
    readonly level: 0 | 1 | 2 | 3 | 4;
  }>;
  readonly streak: number;
  readonly bestStreak: number;
}

const speed = (turns: ReadonlyArray<InsightTurn>): number | null => {
  let words = 0;
  let seconds = 0;
  for (const t of turns) {
    if (t.seconds !== null && t.seconds > 0) {
      words += wordsIn(t.cleaned ?? t.raw);
      seconds += t.seconds;
    }
  }
  return seconds >= 20 ? Math.round((words / seconds) * 60) : null;
};

export const computeDeepInsights = (
  all: ReadonlyArray<InsightTurn>,
  now: number,
  calendarDays = 50,
): DeepInsights => {
  const dictations = all.filter((t) => t.kind === "dictation");
  const ago = (t: InsightTurn) => (now - Date.parse(t.at)) / DAY;
  const words = (t: InsightTurn) => wordsIn(t.cleaned ?? t.raw);

  const month = dictations.filter((t) => ago(t) <= 30);
  const previous = dictations.filter((t) => ago(t) > 30 && ago(t) <= 60);
  let fixWords = 0;
  let fixed = 0;
  for (const t of month) {
    if (t.cleaned === null || t.cleaned.trim() === t.raw.trim()) continue;
    const n = countFixes(t.raw, t.cleaned);
    if (n > 0) {
      fixWords += n;
      fixed += 1;
    }
  }

  const byCat = new Map<StyleCategory, number>();
  for (const t of dictations) {
    const c = categoryForApp({ exe: t.app, title: "" });
    byCat.set(c, (byCat.get(c) ?? 0) + words(t));
  }

  const perDay = new Map<string, number>();
  for (const t of dictations) {
    const key = localDay(Date.parse(t.at));
    perDay.set(key, (perDay.get(key) ?? 0) + words(t));
  }
  const peak = Math.max(1, ...perDay.values());
  const calendar = Array.from({ length: calendarDays }, (_, i) => {
    const date = localDay(now - (calendarDays - 1 - i) * DAY);
    const w = perDay.get(date) ?? 0;
    const level = (w === 0 ? 0 : Math.min(4, 1 + Math.floor((w / peak) * 3.999))) as
      | 0
      | 1
      | 2
      | 3
      | 4;
    return { date, words: w, level };
  });
  let streak = 0;
  for (let i = calendar.length - 1; i >= 0; i -= 1) {
    if (calendar[i]!.words > 0) streak += 1;
    else if (i === calendar.length - 1) continue; // today may not have started yet
    else break;
  }
  let best = 0;
  let run = 0;
  for (const d of [...perDay.keys()].toSorted()) {
    const prev = new Date(Date.parse(`${d}T12:00:00`) - DAY);
    run = perDay.has(localDay(prev.getTime())) ? run + 1 : 1;
    best = Math.max(best, run);
  }

  return {
    wpm: {
      recent: speed(dictations.filter((t) => ago(t) <= 14)),
      before: speed(dictations.filter((t) => ago(t) > 14 && ago(t) <= 60)),
      typingReference: TYPING_REFERENCE_WPM,
    },
    fixes: { words: fixWords, dictations: fixed },
    totalWords: dictations.reduce((n, t) => n + words(t), 0),
    monthWords: month.reduce((n, t) => n + words(t), 0),
    previousMonthWords: previous.reduce((n, t) => n + words(t), 0),
    byCategory: [...byCat.entries()]
      .map(([c, w]) => ({ label: CATEGORY_LABELS[c], words: w }))
      .filter((x) => x.words > 0)
      .toSorted((a, b) => b.words - a.words),
    calendar,
    streak,
    bestStreak: best,
  };
};

/** One honest sentence about speed: against his own past and the typing reference, never a percentile. */
export const describeSpeed = (w: DeepInsights["wpm"]): string => {
  if (w.recent === null) return "Not enough dictation with a known length yet.";
  const vsTyping = `About ${(w.recent / w.typingReference).toFixed(1)} times a typical typing speed of around ${w.typingReference} words a minute (a rough reference, not a ranking).`;
  if (w.before === null) return `${w.recent} words a minute over the last two weeks. ${vsTyping}`;
  const d = w.recent - w.before;
  const trend =
    Math.abs(d) < 3
      ? "about the same as before"
      : d > 0
        ? `${d} faster than before`
        : `${-d} slower than before`;
  return `${w.recent} words a minute over the last two weeks, ${trend} (${w.before}). ${vsTyping}`;
};
