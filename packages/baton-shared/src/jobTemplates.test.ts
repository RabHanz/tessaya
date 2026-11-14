import { describe, expect, it } from "vite-plus/test";

import { mergeTemplates, templateBrief, templateFrame, templateLead } from "./jobTemplates.ts";
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
    const ship = all.find((t) => t.id === "ship-a-change")!;
    expect(templateLead(ship, DEFAULT_OS_PACK.personas)).toBe("engineering");
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
});
