import { describe, expect, it } from "vite-plus/test";

import { createProbes } from "./probes.ts";

describe("the probes", () => {
  it("reports what is reachable, and remembers it for a minute", async () => {
    let lookups = 0;
    let t = 0;
    const probe = createProbes({
      lookup: async () => (lookups++, {}),
      runVersion: async () => true,
      now: () => t,
    });
    expect(await probe("claude")).toMatchObject({ network: true, claude: true });
    t = 30_000;
    await probe("claude");
    expect(lookups).toBe(1);
    t = 61_000;
    await probe("claude");
    expect(lookups).toBe(2);
  });
  it("calls a failed lookup or a missing binary unavailable, not unknown", async () => {
    const probe = createProbes({
      lookup: async () => {
        throw new Error("offline");
      },
      runVersion: async () => false,
    });
    expect(await probe("claude")).toMatchObject({ network: false, claude: false });
  });
});
