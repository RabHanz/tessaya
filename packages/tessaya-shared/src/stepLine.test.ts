import { describe, expect, it } from "vite-plus/test";

import { plainError, stepLine } from "./stepLine.ts";

describe("the line a step says and shows", () => {
  it("is the first sentence, without the filler, short enough to hear in one breath", () => {
    expect(stepLine("Okay, open the Format menu. Then pick Font and set the size.")).toBe(
      "open the Format menu.",
    );
    expect(
      stepLine(
        'Start by clicking the "Your name" box so the cursor is active in it. That tells the form where your typing should go.',
      ),
    ).toBe('Start by clicking the "Your name" box so the cursor is active in it.');
    const long =
      "Click the button at the very top right of the window next to the minimise control, which is the one that closes things.";
    const line = stepLine(long);
    expect(line.split(" ").length).toBeLessThanOrEqual(14);
    expect(line.endsWith(".")).toBe(true);
    expect(stepLine("   ")).toBe("");
  });
});

describe("a failure in plain words", () => {
  it("never shows a stack, a code or a path, and keeps a sentence meant for a person", () => {
    for (const raw of [
      "spawn claude ENOENT",
      "TypeError: Cannot read properties of undefined (reading 'x')",
      'Error: {"code":500}',
      "at Object.run (node:internal/process:12:3)",
      "",
    ]) {
      const said = plainError(raw);
      expect(said, raw).not.toMatch(/ENOENT|TypeError|node:|undefined|\{/);
      expect(said.length).toBeGreaterThan(20);
    }
    expect(
      plainError("The screen changed since I made the plan, so I didn't run it. Ask again."),
    ).toBe("The screen changed since I made the plan, so I didn't run it. Ask again.");
    expect(plainError("Claude stopped: exit 1")).toContain("Claude stopped before it answered");
    expect(plainError("request timed out")).toContain("took too long");
  });
});
