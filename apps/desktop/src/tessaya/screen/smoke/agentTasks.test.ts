import { describe, expect, it } from "vite-plus/test";

import { report, score, TASKS, type RunResult } from "./agentTasks.ts";

const run = (task: string, n: number, over: Partial<RunResult> = {}): RunResult => ({
  task,
  run: n,
  finished: true,
  steps: 6,
  wallMs: 20_000,
  misclicks: 0,
  ...over,
});

describe("the hands' task set", () => {
  it("has six tasks", () => {
    expect(TASKS.map((t) => t.id)).toEqual([
      "notepad",
      "explorer",
      "settings",
      "browser",
      "spreadsheet",
      "dialog",
    ]);
  });
  it("scores finishing, steps, wall time and misclicks over the runs of a task", () => {
    const results = [
      run("notepad", 1),
      run("notepad", 2, { steps: 9, finished: false, misclicks: 2, wallMs: 40_000 }),
      run("notepad", 3, { steps: 6 }),
    ];
    const notepad = score(results)[0]!;
    expect(notepad).toMatchObject({
      runs: 3,
      finished: 2,
      misclicks: 2,
      meanSteps: 7,
      meanWallS: 26.7,
    });
    expect(score(results)[1]).toMatchObject({ task: "explorer", runs: 0, finished: 0 });
    expect(report("after", score(results))).toContain("notepad      2/3");
  });
});
