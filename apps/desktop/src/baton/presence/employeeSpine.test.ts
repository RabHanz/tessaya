import { fallbackDraft, notesOf } from "@t3tools/tessaya-shared/skillDraft";
import { describe, expect, it } from "vite-plus/test";

import { EMPTY_NOW, nowControls } from "./nowRows.ts";

/** The desktop end of the employee spine; the server end is BatonEmployeeSpine.test.ts. */
describe("employee spine, desktop end", () => {
  it("shows a running job and the day's brief on the Now page", () => {
    const rows = nowControls(
      {
        ...EMPTY_NOW,
        loaded: true,
        brief: "Two jobs ran; one failed.",
        doing: ["Running: Spine job"],
      },
      0,
    );
    expect(rows.find((r) => r.id === "now.brief")).toMatchObject({
      detail: "Two jobs ran; one failed.",
    });
    expect(rows.find((r) => r.id === "now.doing:0")?.label).toBe("Running: Spine job");
  });

  it("turns the finished job's record into a skill draft he can edit", () => {
    const notes = notesOf([
      { text: "Retry 1 of 2: the worker failed." },
      { text: "Report: Spine job has run 12 min." },
    ]);
    const draft = fallbackDraft({ title: "Spine job", goal: "Fix the flaky test", notes });
    expect(draft).toContain("name: spine-job");
    expect(draft).toContain("Fix the flaky test");
  });
});
