// @effect-diagnostics globalDate:off
/** The Insights area of the window, from what the turn log already holds. */
import { describeSpeed, type DeepInsights } from "@t3tools/tessaya-shared/insightsDeep";
import { describeProfile, type VoiceProfile } from "@t3tools/tessaya-shared/voiceProfile";

import type { HomeControl } from "../home/batonHome.ts";

const USAGE = "Your usage";
const WHERE = "Where you dictate";

const change = (now: number, before: number): string =>
  before === 0
    ? now === 0
      ? "none in either month"
      : "none the month before"
    : `${now >= before ? "up" : "down"} ${Math.abs(Math.round(((now - before) / before) * 100))}% on the month before`;

export const insightControls = (d: DeepInsights | null): ReadonlyArray<HomeControl> => {
  if (d === null) {
    return [
      {
        id: "in.none",
        section: USAGE,
        label: "Nothing to show yet",
        kind: "check",
        status: "ok",
        detail: "Insights appear once you have dictated; History is kept on this computer.",
      },
    ];
  }
  const first = new Date(`${d.calendar[0]!.date}T12:00:00`);
  // Monday first, so a column is a week.
  const lead = (first.getDay() + 6) % 7;
  const cells = [
    ...Array.from({ length: lead }, () => ({ label: "", level: -1 })),
    ...d.calendar.map((c) => ({ label: `${c.date}: ${c.words} words`, level: c.level })),
  ];
  const row = (id: string, label: string, detail: string): HomeControl => ({
    id,
    section: USAGE,
    label,
    kind: "check",
    status: "ok",
    detail,
  });
  return [
    row("in.speed", "Speed", describeSpeed(d.wpm)),
    row(
      "in.words",
      "Words dictated",
      `${d.totalWords.toLocaleString()} in all; ${d.monthWords.toLocaleString()} in the last 30 days, ${change(d.monthWords, d.previousMonthWords)}.`,
    ),
    row(
      "in.fixes",
      "Fixed by Tessaya",
      d.fixes.dictations === 0
        ? "Nothing needed fixing in the last 30 days."
        : `${d.fixes.words.toLocaleString()} words corrected across ${d.fixes.dictations} dictations in the last 30 days.`,
    ),
    row(
      "in.streak",
      "Streak",
      `${d.streak} ${d.streak === 1 ? "day" : "days"} in a row; your best is ${d.bestStreak}.`,
    ),
    { id: "in.calendar", section: USAGE, label: "The last 50 days", kind: "heat", cells },
    ...(d.byCategory.length === 0
      ? []
      : d.byCategory.map((c, i): HomeControl => ({
          id: `in.cat:${i}`,
          section: WHERE,
          label: c.label,
          kind: "check",
          status: "ok",
          detail: `${c.words.toLocaleString()} words`,
        }))),
  ];
};

const VOICE = "Your voice";

/** The Voice Profile report: how he dictates, from History alone. Nothing when there is no dictation yet. */
export const voiceProfileControls = (p: VoiceProfile | null): ReadonlyArray<HomeControl> =>
  p === null
    ? []
    : describeProfile(p).map((line, i): HomeControl => ({
        id: `in.voice:${i}`,
        section: VOICE,
        label: line.label,
        kind: "check",
        status: "ok",
        detail: line.detail,
      }));
