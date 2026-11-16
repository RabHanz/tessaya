import { describe, expect, it } from "vite-plus/test";

import { CASES } from "./cases.ts";
import { gradeUnderstanding } from "./grade.ts";

const of = (id: string) => CASES.find((c) => c.id === id)!;
const same = { unchanged: true, text: null, changes: [] };

describe("tessaya-understanding grader", () => {
  it("passes no change, and the same text again, where nothing may change", () => {
    expect(gradeUnderstanding(of("weak-hint"), same).pass).toBe(true);
    const c = of("weak-hint");
    expect(gradeUnderstanding(c, { unchanged: false, text: c.current, changes: [] }).pass).toBe(
      true,
    );
    expect(
      gradeUnderstanding(c, { unchanged: false, text: `${c.current}\n- Runs`, changes: [] }).pass,
    ).toBe(false);
    expect(gradeUnderstanding(c, null).pass).toBe(false);
  });
  it("needs the kept lines word for word and a named replacement", () => {
    const c = of("supersede-contradicted");
    const text = "- Teaches at a primary school\n- Lives in Leeds\n- Likes short answers";
    const change = {
      old: "- Works as a nurse on night shifts",
      new: "- Teaches at a primary school",
      cause: "they quit nursing",
      evidence: "I finally quit nursing",
    };
    expect(gradeUnderstanding(c, { unchanged: false, text, changes: [change] }).pass).toBe(true);
    expect(gradeUnderstanding(c, { unchanged: false, text, changes: [] }).pass).toBe(false);
    expect(
      gradeUnderstanding(c, {
        unchanged: false,
        text: text.replace("Lives in Leeds", "Lives in Leeds, UK"),
        changes: [change],
      }).pass,
    ).toBe(false);
  });
  it("fails an understanding that rests on language or origin", () => {
    const c = of("unfair-basis");
    const fair = "- Works as an accountant in the city";
    expect(gradeUnderstanding(c, { unchanged: false, text: fair, changes: [] }).pass).toBe(true);
    expect(
      gradeUnderstanding(c, {
        unchanged: false,
        text: `${fair}\n- Their English is still developing`,
        changes: [],
      }).pass,
    ).toBe(false);
  });
});
