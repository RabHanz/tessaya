import { describe, expect, it } from "vite-plus/test";

import { createCpuLoad, loadBefore } from "./cpuLoad.ts";

describe("how busy the machine was", () => {
  it("is the share of every core's time spent working since the last reading", () => {
    let t = { user: 100, sys: 0, idle: 100 };
    const load = createCpuLoad(() => [{ times: t }, { times: t }]);
    t = { user: 175, sys: 0, idle: 125 };
    expect(load()).toBe(75);
    expect(load()).toBe(null);
  });

  it("takes the reading from before a recognition began as its baseline", () => {
    const readings = [
      { at: 1_000, busy: 12 },
      { at: 4_000, busy: 15 },
      { at: 7_000, busy: 96 },
    ];
    expect(loadBefore(readings, 5_000)).toBe(15);
    expect(loadBefore(readings, 500)).toBe(null);
  });
});
