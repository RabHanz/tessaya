import type { PersonaDraft } from "../../packages/tessaya-shared/src/personaFile.ts";
import type { HireCase } from "./cases.ts";

/** Every way the shipped draft misses the case; empty is a pass. */
export const gradeHire = (c: HireCase, draft: PersonaDraft | null): ReadonlyArray<string> => {
  if (draft === null) return ["no draft"];
  const misses: Array<string> = [];
  const name = draft.name ?? "";
  if (c.name !== undefined && name !== c.name) misses.push(`name ${name}, not ${c.name}`);
  for (const n of c.notName ?? [])
    if (name.toLowerCase() === n.toLowerCase()) misses.push(`took the name ${n}`);
  const dial = (k: string) => (draft.traits as Record<string, number> | undefined)?.[k] ?? 0.5;
  for (const [k, v] of Object.entries(c.max ?? {}))
    if (dial(k) > v) misses.push(`${k} ${dial(k)} > ${v}`);
  for (const [k, v] of Object.entries(c.min ?? {}))
    if (dial(k) < v) misses.push(`${k} ${dial(k)} < ${v}`);
  const about = (draft.about ?? "").toLowerCase();
  for (const any of c.about ?? [])
    if (!any.some((w) => about.includes(w))) misses.push(`about lacks ${any.join("/")}`);
  for (const bad of c.notAbout ?? []) if (about.includes(bad)) misses.push(`about has "${bad}"`);
  if (c.pronouns !== undefined && draft.pronouns !== c.pronouns)
    misses.push(`pronouns ${draft.pronouns ?? "none"}, not ${c.pronouns}`);
  if ((draft.role ?? "").trim() === "") misses.push("no role");
  const greetings = draft.greetings ?? [];
  if (greetings.length === 0) misses.push("no greetings");
  for (const g of greetings) if (g.split(/\s+/).length > 25) misses.push(`long greeting: ${g}`);
  return misses;
};
