/** `tessaya_activity` in words: relative times, so no clock or zone is read aloud wrong. */
import type { TessayaActivityListResult } from "@t3tools/tessaya-contracts";

const ago = (at: number, now: number) => {
  const min = Math.max(0, Math.round((now - at) / 60_000));
  return min < 1 ? "just now" : min < 90 ? `${min} min ago` : `${Math.round(min / 60)} h ago`;
};

export const activityText = (
  mode: "recent" | "findings",
  list: TessayaActivityListResult,
  now: number,
): string => {
  if (mode === "findings") {
    if (list.findings.length === 0) return "Nothing odd in the log for that window.";
    return list.findings
      .map(
        (f) =>
          `${f.title} (${f.count}×, last ${ago(f.lastAt, now)}; trace from ${f.eventIds.at(-1)})`,
      )
      .join("\n");
  }
  if (list.events.length === 0) return "Nothing in the log for that window.";
  const lines = list.events.map((e) =>
    e.kind === "private"
      ? `${ago(e.at, now)}: a private action [${e.id}]`
      : `${ago(e.at, now)}: ${e.actor.id ?? e.actor.kind} ${e.kind}${e.subject === "" ? "" : ` ${e.subject}`}${
          e.outcome === "ok" ? "" : ` (${e.outcome})`
        }${e.cause.length === 0 ? "" : " ← caused"} [${e.id}]`,
  );
  const odd =
    list.findings.length === 0
      ? ""
      : `\n${list.findings.length} likely issue(s): ask for findings.`;
  return lines.join("\n") + odd;
};
