import { describe, expect, it } from "vite-plus/test";

import { createAwareness } from "./awarenessState.ts";

const make = (window: boolean, label: string | null) => {
  let calls = 0;
  const a = createAwareness({
    switches: () => ({ window, idle: false, focus: false, jobs: false }),
    foreground: async () => (calls++, label),
    idleSeconds: () => null,
    focusSession: () => null,
    runningJobs: () => [],
    doing: () => [],
    now: () => 1000,
  });
  return { a, calls: () => calls };
};

describe("the awareness state", () => {
  it("never looks at the foreground window while its switch is off", async () => {
    const { a, calls } = make(false, "code.exe: x");
    expect(await a.describe()).toBe("");
    expect(calls()).toBe(0);
  });
  it("redacts a private title before it is kept", async () => {
    const { a } = make(true, "chrome.exe: Barclays - Sign in");
    const text = await a.describe();
    expect(text).toContain("a private window");
    expect(text).not.toContain("Barclays");
  });
});
