// @effect-diagnostics globalDate:off
/** Counts for Home from what History already holds: nothing new is collected. Days are his local days. */
import type { HistoryTurn } from "./history.ts";

export interface Insights {
  readonly wordsToday: number;
  readonly dictationsToday: number;
  /** Minutes saved today against typing at TYPING_WPM, less the time he spent speaking. */
  readonly minutesSaved: number;
  /** Words per minute over the dictations whose length is known; null until there is one. */
  readonly wpm: number | null;
  /** Days in a row, ending today or yesterday, with at least one dictation. */
  readonly streak: number;
  readonly topApps: ReadonlyArray<{ readonly app: string; readonly count: number }>;
}

/** The typing speed time saved is measured against, stated wherever the number shows. */
export const TYPING_WPM = 40;

const wordCount = (text: string): number =>
  text.trim() === "" ? 0 : text.trim().split(/\s+/).length;
const dayKey = (at: Date): string => `${at.getFullYear()}-${at.getMonth()}-${at.getDate()}`;

export const computeInsights = (
  turns: ReadonlyArray<Pick<HistoryTurn, "at" | "kind" | "app" | "raw" | "cleaned" | "seconds">>,
  now: Date,
): Insights => {
  const dictations = turns.filter((turn) => turn.kind === "dictation");
  const today = dayKey(now);
  let wordsToday = 0;
  let dictationsToday = 0;
  let spokenToday = 0;
  let unspokenWords = 0;
  let words = 0;
  let seconds = 0;
  const days = new Set<string>();
  const apps = new Map<string, number>();
  for (const turn of dictations) {
    const at = new Date(turn.at);
    const n = wordCount(turn.cleaned ?? turn.raw);
    days.add(dayKey(at));
    if (dayKey(at) === today) {
      wordsToday += n;
      dictationsToday += 1;
      if (turn.seconds !== null && turn.seconds > 0) spokenToday += turn.seconds;
      else unspokenWords += n;
    }
    if (turn.seconds !== null && turn.seconds > 0) {
      words += n;
      seconds += turn.seconds;
    }
    if (turn.app !== "") apps.set(turn.app, (apps.get(turn.app) ?? 0) + 1);
  }
  let streak = 0;
  const cursor = new Date(now);
  if (!days.has(dayKey(cursor))) cursor.setDate(cursor.getDate() - 1);
  while (days.has(dayKey(cursor))) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  const wpm = seconds >= 5 ? Math.round((words / seconds) * 60) : null;
  // A dictation with no measured length is taken at his own measured pace, or a typical 150 wpm before there is one.
  const speakingMinutes = spokenToday / 60 + unspokenWords / (wpm ?? 150);
  return {
    wordsToday,
    dictationsToday,
    minutesSaved: Math.max(0, Math.round(wordsToday / TYPING_WPM - speakingMinutes)),
    wpm,
    streak,
    topApps: [...apps.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([app, count]) => ({ app, count })),
  };
};
