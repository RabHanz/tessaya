import { describe, expect, it } from "vite-plus/test";

import { draftMessage, fallbackDraft, notesOf, usableDraft } from "./skillDraft.ts";
import { parseSkill } from "./skillReview.ts";

const job = {
  title: "Rebuild the site",
  goal: "Rebuild the site and keep the logo",
  notes: ["Use the blue palette", "Report: ran 2 h"],
};

describe("a finished job as a skill draft", () => {
  it("gives the model the job, what he asked and what was said along the way", () => {
    const m = draftMessage(job);
    expect(m).toContain("The job: Rebuild the site");
    expect(m).toContain("- Use the blue palette");
    expect(notesOf([{ text: "Report: has run 1 h" }, { text: "  " }])).toEqual([
      "Report: has run 1 h",
    ]);
  });
  it("has a plain draft that is itself a valid skill, so there is always something to edit", () => {
    const parsed = parseSkill(fallbackDraft(job), "x");
    expect(parsed.ok && parsed.skill.name).toBe("rebuild-the-site");
    expect(fallbackDraft({ ...job, notes: [] })).toContain("1. (Fill in the steps that worked.)");
  });
  it("accepts a model answer only if it is a skill file, and strips a code fence", () => {
    const good =
      "---\nname: rebuild-site\ndescription: Use when rebuilding a site.\n---\n## Steps\n1. Do it.";
    expect(usableDraft(good)).toBe(`${good}\n`);
    expect(usableDraft("```markdown\n" + good + "\n```")).toBe(`${good}\n`);
    expect(usableDraft("Sure! Here is a skill: do things")).toBeNull();
    expect(usableDraft("")).toBeNull();
  });
});
