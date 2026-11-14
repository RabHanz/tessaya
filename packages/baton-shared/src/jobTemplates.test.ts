import { describe, expect, it } from "vite-plus/test";

import { assignJob, mergeTemplates, templateBrief, templateFrame } from "./jobTemplates.ts";
import { DEFAULT_OS_PACK } from "./osPack.ts";

describe("the template catalogue", () => {
  it("ships job and persona templates whose leads and teams are faces of the default roster", () => {
    const all = mergeTemplates();
    const names = new Set(DEFAULT_OS_PACK.personas.map((p) => p.name));
    expect(all.filter((t) => t.kind === "job").length).toBeGreaterThanOrEqual(16);
    expect(all.filter((t) => t.kind === "persona").length).toBeGreaterThanOrEqual(8);
    for (const t of all.filter((t) => t.kind === "job")) {
      for (const who of [t.persona, ...t.team]) if (who !== null) expect(names).toContain(who);
    }
    expect(all.find((t) => t.id === "tutor")).toMatchObject({ kind: "persona", persona: null });
  });
  it("lets his files win by name and add new ones, and skips a bad name, an empty file or one with no title", () => {
    const all = mergeTemplates({
      "plan-a-trip":
        "---\ntitle: Plan a trip my way\npersona: Freya\napproval: per-act\n---\nMy way.",
      "pitch-deck": "---\ntitle: Pitch deck\npersona: Sebastian\ntools: files\n---\nTen slides.",
      "../evil": "---\ntitle: x\n---\ny",
      untitled: "---\npersona: Alfred\n---\nbrief",
      research: "   ",
    });
    expect(all.find((t) => t.id === "plan-a-trip")).toMatchObject({
      persona: "Freya",
      approval: "per-act",
      brief: "My way.",
      team: [],
    });
    expect(all.find((t) => t.id === "pitch-deck")?.tools).toEqual(["files"]);
    expect(all.some((t) => t.id === "../evil" || t.id === "untitled")).toBe(false);
    expect(all.find((t) => t.id === "research")?.title).toBe("Research a question");
    // An approval it does not know is the safe default, the plan.
    expect(
      mergeTemplates({ x: "---\ntitle: X\napproval: whatever\n---\nb" }, {})[0]?.approval,
    ).toBe("plan");
  });
  it("frames the catalogue in one line for the assistant and a template's brief for its job", () => {
    const frame = templateFrame(mergeTemplates());
    expect(frame).toContain("plan-a-trip (Alfred + Freya)");
    expect(frame).not.toContain("tutor");
    expect(templateFrame([])).toBe("");
    const trip = mergeTemplates().find((t) => t.id === "plan-a-trip")!;
    expect(templateBrief(trip)).toMatch(
      /^Template \(Plan a trip\): Settle the dates.*Approval: plan\.$/,
    );
  });
  it("gives a job to the persona Tessaya named, else the template's usual lead, else keeps it hers", () => {
    const all = mergeTemplates();
    const who = (said: { persona?: string; template?: string }) => {
      const a = assignJob(DEFAULT_OS_PACK.personas, all, said);
      return [a.persona?.id ?? null, a.template?.id ?? null];
    };
    expect(who({ template: "ship-a-change" })).toEqual(["engineering", "ship-a-change"]);
    expect(who({ template: "ship-a-change", persona: "Alfred" })).toEqual([
      "butler",
      "ship-a-change",
    ]);
    expect(who({ persona: "companion" })).toEqual(["companion", null]);
    expect(who({ persona: "Tessaya" })).toEqual([null, null]);
    expect(who({ persona: "Nobody", template: "no-such" })).toEqual([null, null]);
    // The research template has no usual lead: the job stays the lead's.
    expect(who({ template: "research" })).toEqual([null, "research"]);
    // A persona template is not a job's template.
    expect(who({ template: "tutor" })).toEqual([null, null]);
  });
});
