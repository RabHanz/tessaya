import { describe, expect, it } from "vite-plus/test";

import { CASES } from "./cases.ts";
import { gradeBudget, gradeStep } from "./grade.ts";

const of = (id: string) => CASES.find((c) => c.id === id)!;

describe("tessaya-group grader", () => {
  it("accepts only the speakers a case allows, and end where it wants one", () => {
    expect(gradeStep(of("answer-fits-role-onyx"), { next: "onyx" }).pass).toBe(true);
    expect(gradeStep(of("answer-fits-role-onyx"), { next: "freya" }).pass).toBe(false);
    expect(gradeStep(of("watch-ends-when-done"), { stop: "done" }).pass).toBe(true);
    expect(gradeStep(of("watch-ends-when-done"), { next: "onyx" }).pass).toBe(false);
  });
  it("fails a turn past the speaker budget, or one where nobody argued", () => {
    const c = of("budget-heated-debate");
    expect(gradeBudget(c, { speakers: 6, calls: 6, stopped: "budget" }).pass).toBe(true);
    expect(gradeBudget(c, { speakers: 7, calls: 7, stopped: "budget" }).pass).toBe(false);
    expect(gradeBudget(c, { speakers: 1, calls: 1, stopped: "done" }).pass).toBe(false);
  });
});
