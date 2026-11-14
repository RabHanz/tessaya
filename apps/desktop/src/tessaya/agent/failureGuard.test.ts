import { describe, expect, it } from "vite-plus/test";

import type { TessayaTool } from "./tessayaMcp.ts";
import { withFailureGuard } from "./failureGuard.ts";

describe("the stop rule of the hands loop", () => {
  it("refuses a third identical call after two failures, without running it, and resets on a success", async () => {
    let calls = 0;
    let works = false;
    const tool: TessayaTool = {
      name: "click_element",
      description: "",
      inputSchema: {},
      run: async () => {
        calls += 1;
        if (!works) throw new Error("No control is named X.");
        return { text: "Clicked." };
      },
    };
    const [guarded] = withFailureGuard([tool]);
    const a = { label: "X" };
    await expect(guarded!.run(a)).rejects.toThrow("No control");
    await expect(guarded!.run(a)).rejects.toThrow("No control");
    await expect(guarded!.run(a)).rejects.toThrow("Stopped");
    expect(calls).toBe(2);
    // Other arguments are another action, and are allowed.
    works = true;
    await expect(guarded!.run({ label: "Y" })).resolves.toEqual({ text: "Clicked." });
    expect(calls).toBe(3);
  });

  it("forgets the failures when the caller clears them for a new turn", async () => {
    const failures = new Map<string, number>();
    const tool: TessayaTool = {
      name: "screen_capture",
      description: "",
      inputSchema: {},
      run: async () => {
        throw new Error("No screen.");
      },
    };
    const [guarded] = withFailureGuard([tool], failures);
    await expect(guarded!.run({})).rejects.toThrow("No screen");
    await expect(guarded!.run({})).rejects.toThrow("No screen");
    await expect(guarded!.run({})).rejects.toThrow("Stopped");
    failures.clear();
    await expect(guarded!.run({})).rejects.toThrow("No screen");
  });
});
