import { describe, expect, it } from "vite-plus/test";

import { cloneUses, undoUses } from "./LabBenches.logic";

describe("Use it for", () => {
  const personas = [
    { id: "tessaya", cloneVoice: null },
    { id: "freya", cloneVoice: "kitchen" },
    { id: "alfred", cloneVoice: "studio" },
  ];

  it("gives the clone to every ticked persona not already on it, and remembers what each had", () => {
    expect(cloneUses(personas, "studio", new Set(["tessaya", "freya", "alfred"]))).toEqual([
      { persona: "tessaya", before: null, after: "studio" },
      { persona: "freya", before: "kitchen", after: "studio" },
    ]);
  });

  it("undoes exactly what it did, back to each persona's own voice", () => {
    const done = cloneUses(personas, "studio", new Set(["tessaya", "freya"]));
    expect(undoUses(done)).toEqual([
      { persona: "tessaya", before: "studio", after: null },
      { persona: "freya", before: "studio", after: "kitchen" },
    ]);
  });
});
