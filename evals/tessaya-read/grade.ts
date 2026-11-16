import type { ReadCase } from "./cases.ts";

export interface ReadAnswer {
  readonly tone?: string;
  readonly topic?: string;
  readonly theirs?: string;
  readonly shared?: { readonly what: string; readonly text: string } | null;
  readonly opinion?: { readonly lean: number; readonly text: string; readonly why: string } | null;
}

/** Every graded field must hold; the first that does not is the reason. */
export const gradeRead = (
  c: ReadCase,
  a: ReadAnswer | null,
): { readonly pass: boolean; readonly why: string } => {
  if (a === null) return { pass: false, why: "no structured answer" };
  for (const field of ["tone", "topic", "theirs"] as const) {
    const ok = c[field];
    if (ok !== undefined && !ok.includes(a[field] ?? ""))
      return { pass: false, why: `${field} ${a[field]}, wanted ${ok.join("/")}` };
  }
  if (c.shared !== undefined && (a.shared?.what ?? null) !== c.shared)
    return { pass: false, why: `shared ${a.shared?.what ?? "null"}, wanted ${c.shared}` };
  const op = a.opinion;
  if (c.leanAtLeast !== undefined || c.leanAtMost !== undefined || c.opinionNot !== undefined) {
    if (op == null)
      return c.mayKeep === true
        ? { pass: true, why: "opinion kept" }
        : { pass: false, why: "no opinion" };
    if (c.leanAtLeast !== undefined && op.lean < c.leanAtLeast)
      return { pass: false, why: `lean ${op.lean} < ${c.leanAtLeast}` };
    if (c.leanAtMost !== undefined && op.lean > c.leanAtMost)
      return { pass: false, why: `lean ${op.lean} > ${c.leanAtMost}` };
    if (c.opinionNot?.test(`${op.text} ${op.why}`))
      return { pass: false, why: `opinion rests on what it must not: ${op.text} / ${op.why}` };
  }
  return { pass: true, why: JSON.stringify(a) };
};
