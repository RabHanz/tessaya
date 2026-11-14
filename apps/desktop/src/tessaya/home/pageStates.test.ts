import { describe, expect, it } from "vite-plus/test";

import { BAD, STATES, sweepPages } from "./pageStates.ts";

describe("every page in every state", () => {
  it("covers loading, empty, error, offline, a missing permission and half-filled data", () => {
    expect(Object.keys(STATES)).toEqual(
      expect.arrayContaining([
        "loading",
        "empty",
        "error",
        "offline",
        "permission missing",
        "half-filled",
      ]),
    );
  });

  it("knows what a person should never see", () => {
    for (const bad of [
      "undefined",
      "NaN items",
      "[object Object]",
      "null",
      "TypeError: x",
      "at f (a.js:1:2)",
    ]) {
      expect(BAD.test(bad)).toBe(true);
    }
    expect(BAD.test("Nothing needs you")).toBe(false);
  });

  it("draws every tab and dialog from every state without undefined, NaN, an object or a raw error", async () => {
    expect(await sweepPages()).toEqual([]);
  });
});
