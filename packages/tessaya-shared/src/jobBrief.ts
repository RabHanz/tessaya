/**
 * The job brief (D148): before any work the plan thread shows the job, the outcomes, the leverage
 * point, whether to build and why, the steps, the specialists, whether it can be undone, and what it
 * may do. A plan without them is not ready. Lenient about the heading style, strict about the sections.
 */
export const BRIEF_SECTIONS = [
  ["job", /\b(?:the\s+)?job\b/i],
  ["outcomes", /\bdesired outcomes?\b|\boutcomes?\b/i],
  ["leverage", /\bleverage\b/i],
  ["build", /\bbuild\b.{0,20}\bnot\b|\bdo(?:n'?t| not) build\b|\bbuild decision\b/i],
  ["steps", /\bsteps?\b|\bskeleton\b/i],
  ["specialists", /\bspecialists?\b|\bworkers?\b/i],
  ["reversible", /\breversib|\bundone\b|\bundo\b|\bcan be undone\b/i],
  ["permissions", /\bpermissions?\b|\bmay do\b|\ballowed\b/i],
] as const;

export type BriefSection = (typeof BRIEF_SECTIONS)[number][0];

/** A line that opens a section: a heading, a bold label, a numbered or bulleted label. */
const heading = (label: RegExp): RegExp =>
  new RegExp(
    String.raw`^[ \t]*(?:#{1,6}[ \t]*|\*\*[ \t]*|__[ \t]*|\d+[.)][ \t]*|[-*][ \t]+)?(?:[^\n:]{0,25}\b)?(?:${label.source})[^\n]{0,60}$`,
    "im",
  );

export const parseJobBrief = (
  text: string,
): { readonly ok: boolean; readonly missing: ReadonlyArray<BriefSection> } => {
  const missing = BRIEF_SECTIONS.filter(([, label]) => !heading(label).test(text)).map(
    ([name]) => name,
  );
  return { ok: missing.length === 0, missing };
};

export const briefNudge = (missing: ReadonlyArray<BriefSection>): string =>
  `Show the job brief before anything else. It is missing: ${missing.join(", ")}. Give each as its own short heading: the job, the outcomes, the leverage point, build or do not build (with the reason), the steps, the specialists, whether it can be undone, and what it may do.`;

/** Marks the job's record once the worker has been asked, so it is asked once. */
export const NUDGE_MARK = "Asked for the job brief:";
