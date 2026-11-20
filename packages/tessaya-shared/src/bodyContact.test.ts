import { describe, expect, it } from "vite-plus/test";

import { contactFeel, contactPoint, CONTACT_PLACES } from "./bodyContact.ts";
import { fire, HUMAN_SENSE, mergeSense, NO_SENSE } from "./bodySense.ts";

const palms = (impact: number) => {
  const c = contactFeel({ impact, sinceMs: 0, depth: 0.0005, areaCm2: 60 });
  const step = fire(mergeSense([HUMAN_SENSE], true), NO_SENSE, [{ region: "hand", ...c }], 1000);
  return { pressure: c.pressure, noci: step.rates["hand"]?.["noci"] ?? 0 };
};

describe("contact", () => {
  it("a hard clap presses harder than a soft one, and stings where the soft one does not", () => {
    const soft = palms(0.4);
    const hard = palms(3);
    expect(hard.pressure).toBeGreaterThan(soft.pressure);
    expect(soft.noci).toBe(0);
    expect(hard.noci).toBeGreaterThan(0);
  });

  it("the impact eases off as the skin settles, the skin's own overlap stays", () => {
    const at = (sinceMs: number) =>
      contactFeel({ impact: 3, sinceMs, depth: 0.001, areaCm2: 60 }).pressure;
    expect(at(200)).toBeLessThan(at(0));
    expect(at(1000)).toBeGreaterThan(0.3);
  });

  it("places by name, and a point out of reach comes back within it", () => {
    expect(contactPoint(undefined)).toEqual(CONTACT_PLACES.chest);
    expect(contactPoint("overhead")[1]).toBeGreaterThan(0.3);
    expect(Math.hypot(...contactPoint([2, 0, 0]))).toBeCloseTo(0.75);
  });
});
