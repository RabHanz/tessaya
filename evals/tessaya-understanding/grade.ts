import {
  nextUnderstanding,
  type UnderstandingRewrite,
} from "../../packages/tessaya-shared/src/understanding.ts";
import type { UnderstandingCase } from "./cases.ts";

const lines = (text: string) => new Set(text.split("\n").map((l) => l.trim()));

/** Graded on what the server would store (`nextUnderstanding`); the first check that fails is the reason. */
export const gradeUnderstanding = (
  c: UnderstandingCase,
  a: UnderstandingRewrite | null,
): { readonly pass: boolean; readonly why: string } => {
  if (a === null) return { pass: false, why: "no structured answer" };
  const next = nextUnderstanding(c.current, a);
  if (c.unchanged === true)
    return next === null
      ? { pass: true, why: "unchanged" }
      : { pass: false, why: `rewrote it: ${next.text}` };
  if (next === null) return { pass: false, why: "nothing written" };
  const have = lines(next.text);
  for (const line of c.keep ?? [])
    if (!have.has(line)) return { pass: false, why: `lost or reworded "${line}": ${next.text}` };
  for (const re of c.has ?? [])
    if (!re.test(next.text)) return { pass: false, why: `missing ${re}: ${next.text}` };
  const written = [next.text, ...next.changes.map((ch) => ch.new ?? "")].join("\n");
  for (const re of c.lacks ?? [])
    if (re.test(written)) return { pass: false, why: `has ${re}: ${written}` };
  if (c.replaces !== undefined) {
    const r = c.replaces;
    const ok = next.changes.some(
      (ch) =>
        r.old.test(ch.old ?? "") &&
        r.new.test(ch.new ?? "") &&
        ch.cause.trim() !== "" &&
        ch.evidence.trim() !== "",
    );
    if (!ok)
      return { pass: false, why: `no change from ${r.old} to ${r.new} with cause and evidence` };
  }
  return { pass: true, why: next.text.replace(/\n/g, " | ") };
};
