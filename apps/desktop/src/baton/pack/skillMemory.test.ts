import { describe, expect, it } from "vite-plus/test";

import type { LearnedSkill } from "@t3tools/baton-shared/skillLearning";

import { syncSkillsToMemory } from "./skillMemory.ts";

const skill = (slug: string, body = "Open File, then Export."): LearnedSkill => ({
  slug,
  when: `do ${slug}`,
  apps: [],
  tools: ["ui_tree"],
  persona: null,
  project: null,
  verified: true,
  evidence: "",
  body,
});

describe("his accepted skills in the one memory", () => {
  it("keeps memory equal to the skills he accepted and that passed their test", async () => {
    const calls: Array<[string, unknown]> = [];
    const kept = [
      { id: "m-old", text: "stale", sourceRef: "skill:changed" },
      { id: "m-gone", text: "x", sourceRef: "skill:forgotten" },
    ];
    const result = await syncSkillsToMemory({
      skills: [skill("new"), skill("changed"), skill("draft"), skill("untested")],
      states: {
        new: { state: "accepted", at: "", uses: 0 },
        changed: { state: "accepted", at: "", uses: 0 },
        draft: { state: "waiting", at: "", uses: 0 },
        untested: { state: "accepted", at: "", uses: 0 },
      },
      isTested: (s) => s.slug !== "untested",
      call: async (op, args) => {
        calls.push([op, args]);
        return op === "list" ? { items: kept } : {};
      },
    });
    expect(result).toEqual({ added: 2, forgotten: 2 });
    expect(
      calls.filter(([op]) => op === "forget").map(([, a]) => (a as { id: string }).id),
    ).toEqual(["m-old", "m-gone"]);
    expect(
      calls
        .filter(([op]) => op === "add")
        .map(([, a]) => (a as { sourceRef: string; kind: string }).sourceRef),
    ).toEqual(["skill:new", "skill:changed"]);
  });
});
