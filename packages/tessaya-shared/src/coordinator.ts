/**
 * The coordinator (D148): a job with several parts hands each to its own worker, watches them, and
 * reports once. Pure: which parts are settled, and the one summary, from the cards and the watch.
 */
import type { BatonJob, WatchFinding } from "@t3tools/tessaya-contracts";

/** Marks the parent's record so the summary is written once. */
export const SUMMARY_MARK = "Summary of the parts:";

export const MAX_PARTS = 8;

/** Marks a part that was never started because a part it waited on failed. */
export const BLOCKED_MARK = "Not started:";

/** Every part has finished one way or the other; none is still running or waiting for him. */
export const partsSettled = (parts: ReadonlyArray<BatonJob>): boolean =>
  parts.length > 0 && parts.every((p) => p.group === "done" || p.group === "failed");

export const partsSummary = (input: {
  readonly parentTitle: string;
  readonly parts: ReadonlyArray<BatonJob>;
  readonly findings: ReadonlyArray<WatchFinding>;
  /** Parts never started because one they waited on failed. */
  readonly blocked?: ReadonlyArray<{ readonly title: string; readonly why: string }>;
}): string => {
  const said = new Map(input.findings.map((f) => [f.workSessionId as string, f.lastDid]));
  const line = (p: BatonJob) => {
    const last = said.get(p.workSessionId);
    return `- ${p.title}: ${p.group === "done" ? "done" : "failed"}${last === undefined || last === "" ? "" : `. Last: ${last}`}`;
  };
  const blocked = input.blocked ?? [];
  const total = input.parts.length + blocked.length;
  const failed = input.parts.filter((p) => p.group === "failed").length + blocked.length;
  return [
    `${SUMMARY_MARK} ${input.parentTitle}`,
    ...input.parts.map(line),
    ...blocked.map((b) => `- ${b.title}: not started. ${b.why}`),
    failed === 0
      ? "All parts finished. Write the report against the outcomes, with the evidence."
      : `${failed} of ${total} failed or did not start. Say what is missing, what it blocks, and what to do next.`,
  ].join("\n");
};
