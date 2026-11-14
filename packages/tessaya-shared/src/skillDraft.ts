/**
 * A finished job as a skill (D145 and the Skills tab): a draft SKILL.md he reads and edits, never
 * installed by itself. The model is asked to write the reusable procedure; if it cannot, a plain
 * template from the job's own record stands in. Pure.
 */
import { REPORT_MARK } from "./jobReport.ts";
import { parseSkill, slugOf } from "./skillReview.ts";

export interface DraftJob {
  readonly title: string;
  readonly goal: string;
  /** What was said to the job after it started, and the reports written about it. */
  readonly notes: ReadonlyArray<string>;
}

export const draftSystemPrompt =
  "You turn a finished job into a reusable skill file for a coding assistant. Reply with the file only: YAML front matter with name (lower case, hyphens) and description (one sentence saying when to use it), then short sections: When to use it, Steps (numbered, concrete), Checks (how to know it worked), Watch out for. Write the general procedure, not this one job's details; leave out names, paths and secrets that belong to one person. No preface, no code fence around the file.";

export const draftMessage = (job: DraftJob): string =>
  [
    `The job: ${job.title}`,
    `What he asked for: ${job.goal.slice(0, 1500)}`,
    job.notes.length === 0
      ? ""
      : `What was said and reported along the way:\n${job.notes
          .slice(-12)
          .map((n) => `- ${n.slice(0, 400)}`)
          .join("\n")}`,
  ]
    .filter((l) => l !== "")
    .join("\n\n");

/** The notes worth giving the model: his refinements and the reports, not the bookkeeping. */
export const notesOf = (
  revisions: ReadonlyArray<{ readonly text: string }>,
): ReadonlyArray<string> =>
  revisions.map((r) => r.text.replace(REPORT_MARK, "Report:")).filter((t) => t.trim() !== "");

/** A plain template when no model answers, so there is always something to edit. */
export const fallbackDraft = (job: DraftJob): string =>
  [
    "---",
    `name: ${slugOf(job.title) || "finished-job"}`,
    `description: Use when the task is like "${job.title.replace(/"/g, "'").slice(0, 80)}".`,
    "---",
    "",
    "## When to use it",
    job.goal.slice(0, 600),
    "",
    "## Steps",
    ...(job.notes.length > 0
      ? job.notes.slice(-6).map((n, i) => `${i + 1}. ${n.slice(0, 300)}`)
      : ["1. (Fill in the steps that worked.)"]),
    "",
    "## Checks",
    "- (How you know it worked.)",
    "",
    "## Watch out for",
    "- (What went wrong or took retries.)",
    "",
  ].join("\n");

/** The model's file if it is a usable skill, with a code fence taken off; otherwise null. */
export const usableDraft = (answer: string): string | null => {
  const text = answer
    .trim()
    .replace(/^```(?:markdown|md)?\n/, "")
    .replace(/\n```$/, "")
    .trim();
  return parseSkill(text, "finished-job").ok && text.startsWith("---") ? `${text}\n` : null;
};
