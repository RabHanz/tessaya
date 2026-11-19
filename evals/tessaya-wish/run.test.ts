import { describe, expect, it } from "vite-plus/test";

import { CASES } from "./cases.ts";
import { gradeWish } from "./grade.ts";

const of = (id: string) => CASES.find((c) => c.id === id)!;

describe("tessaya-wish grader", () => {
  it("accepts only the wishes a case allows, and fails no answer", () => {
    expect(gradeWish(of("tired-late-rests"), { want: "rest" }).pass).toBe(true);
    expect(gradeWish(of("tired-late-rests"), { want: "play" }).pass).toBe(false);
    expect(gradeWish(of("control-happy-never-sulks"), { want: "sulk" }).pass).toBe(false);
    expect(gradeWish(of("tired-late-rests"), null).pass).toBe(false);
  });
});
