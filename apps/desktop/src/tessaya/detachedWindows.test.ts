import { describe, expect, it, vi } from "vite-plus/test";

import { detachedWindowId, parseDetachedWindows } from "./detachedWindows.ts";

vi.mock("electron", () => ({}));

describe("detachedWindowId", () => {
  it("accepts only the application's own origin and a clean id", () => {
    const app = "t3://app/index.html";
    expect(detachedWindowId("t3://app/index.html?batonWindow=ab-1#/box/t", app)).toBe("ab-1");
    expect(detachedWindowId("t3://other/?batonWindow=ab-1", app)).toBeNull();
    expect(detachedWindowId("https://app/?batonWindow=ab-1", app)).toBeNull();
    expect(detachedWindowId("t3://app/?batonWindow=../x", app)).toBeNull();
    expect(detachedWindowId("t3://app/", app)).toBeNull();
    expect(detachedWindowId("not a url", app)).toBeNull();
  });
});

describe("parseDetachedWindows", () => {
  it("drops what it cannot trust and survives a broken file", () => {
    const good = { id: "w1", url: "t3://app/", bounds: null };
    expect(parseDetachedWindows(JSON.stringify([good, { id: "../x", url: "y" }, 3]))).toEqual([
      good,
    ]);
    expect(parseDetachedWindows("{")).toEqual([]);
  });
});
