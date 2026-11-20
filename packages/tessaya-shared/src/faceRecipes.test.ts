import { describe, expect, it } from "vite-plus/test";

import { BODY_FACES } from "./bodyCues.ts";
import { FACE_RECIPES, OPENING, recipeWeights } from "./faceRecipes.ts";

const opening = (r: Readonly<Record<string, number>>) =>
  OPENING.reduce((n, k) => n + (r[k] ?? 0), 0);

describe("her face as a mix of a VRoid model's own parts", () => {
  it("has a mix for every mood her body shows", () => {
    expect(Object.keys(BODY_FACES).filter((m) => !Object.hasOwn(FACE_RECIPES, m))).toEqual([]);
    expect(recipeWeights("no-such-mood", 1)).toBeNull();
  });

  it("is as strong as her mood, and never gapes, least of all while she talks", () => {
    const mild = recipeWeights("happy", 0.1)!;
    const strong = recipeWeights("happy", 1)!;
    expect(strong["BRW_Joy"]).toBeCloseTo(0.7);
    expect(mild["BRW_Joy"]!).toBeLessThan(0.5 * strong["BRW_Joy"]!);
    for (const m of Object.keys(FACE_RECIPES)) {
      expect(opening(recipeWeights(m, 1)!)).toBeLessThanOrEqual(0.7 + 1e-9);
      expect(opening(recipeWeights(m, 1, true)!)).toBeLessThanOrEqual(0.21 + 1e-9);
    }
  });
});
