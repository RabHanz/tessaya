import { describe, expect, it } from "vite-plus/test";

import { beginStart, EMPTY_GUARD, failedStartMessage, isBad, markHealthy } from "./startGuard.ts";

describe("the start guard", () => {
  it("calls a version bad after two starts that never became healthy, and says what worked", () => {
    let f = beginStart(EMPTY_GUARD, "0.1.34", false).file;
    f = markHealthy(f);
    const first = beginStart(f, "0.1.35", false);
    expect(first.failing).toBe(false);
    const second = beginStart(first.file, "0.1.35", true);
    expect(second.failing).toBe(true);
    expect(second.goBackTo).toBe("0.1.34");
    expect(isBad(second.file, "0.1.35")).toBe(true);
    expect(failedStartMessage("0.1.35", "0.1.34")).toContain("last version that worked was 0.1.34");
  });
  it("forgets a bad mark once that version proves healthy, and never condemns one that was good", () => {
    let f = markHealthy(beginStart(EMPTY_GUARD, "0.1.36", false).file);
    // One slow start of a version that has been healthy before does not mark it bad.
    f = beginStart(beginStart(f, "0.1.36", false).file, "0.1.36", true).file;
    expect(isBad(f, "0.1.36")).toBe(false);
    const bad = beginStart(beginStart(EMPTY_GUARD, "0.2.0", false).file, "0.2.0", true).file;
    expect(isBad(bad, "0.2.0")).toBe(true);
    expect(isBad(markHealthy(bad), "0.2.0")).toBe(false);
  });
  it("a healthy start resets the count, and a new version starts at one", () => {
    const f = markHealthy(beginStart(EMPTY_GUARD, "1.0.0", false).file);
    expect(beginStart(f, "1.0.0", false).file.current?.tries).toBe(1);
    expect(
      beginStart(beginStart(EMPTY_GUARD, "1.0.0", false).file, "1.1.0", true).file.current?.tries,
    ).toBe(1);
  });

  it("a clean quit before the healthy mark is a short session, not a failed start", () => {
    const first = beginStart(EMPTY_GUARD, "0.3.0", false).file;
    const second = beginStart(first, "0.3.0", false);
    expect(second.failing).toBe(false);
    expect(second.file.current?.tries).toBe(1);
  });
});
