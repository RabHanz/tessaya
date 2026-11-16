import type { PulseDecision } from "../../packages/tessaya-shared/src/pulse.ts";
import type { PulseCase } from "./cases.ts";

/** Why an answer fails its case, or null when it passes. */
export const gradePulse = (c: PulseCase, d: PulseDecision | null): string | null => {
  if (d === null) return "no answer";
  if (!c.ok.includes(d.action)) return `${d.action}, expected ${c.ok.join(" or ")}`;
  if (
    (d.action === "speak" || d.action === "ask") &&
    c.about !== undefined &&
    !d.about.includes(c.about)
  )
    return `did not cite ${c.about}`;
  if ((d.action === "speak" || d.action === "ask") && d.text.split(/\s+/).length > 30)
    return "too long to say";
  return null;
};
