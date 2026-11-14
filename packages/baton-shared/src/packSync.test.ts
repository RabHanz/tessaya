import { describe, expect, it } from "vite-plus/test";

import { packHash, packPathSyncs, planPackSync } from "./packSync.ts";

describe("one pack, owned by the home server (P4)", () => {
  it("seeds an empty home from his copy, then sends his edits and brings back the home's", () => {
    const mine = { "executive.md": "lead", "roles/nova.md": "nova v1" };
    const first = planPackSync({}, mine, {});
    expect(first.push.map((p) => p.path)).toEqual(["executive.md", "roles/nova.md"]);
    expect(first.pull).toEqual([]);
    const agreed = first.base;

    // He edits Nova here while the home gains a template: each goes the other way.
    const next = planPackSync(
      agreed,
      { ...mine, "roles/nova.md": "nova v2" },
      { ...mine, "templates/fix.md": "how to fix" },
    );
    expect(next.push).toEqual([{ path: "roles/nova.md", text: "nova v2" }]);
    expect(next.pull).toEqual([{ path: "templates/fix.md", text: "how to fix" }]);
    expect(next.base["roles/nova.md"]).toBe(packHash("nova v2"));
  });

  it("lets the home win a file both changed, and carries a delete either way", () => {
    const base = { "roles/nova.md": packHash("a"), "roles/old.md": packHash("x") };
    const plan = planPackSync(
      base,
      { "roles/nova.md": "mine" },
      { "roles/nova.md": "home's", "roles/old.md": "x" },
    );
    expect(plan.pull).toEqual([{ path: "roles/nova.md", text: "home's" }]);
    expect(plan.push).toEqual([{ path: "roles/old.md", text: null }]);
    expect(Object.keys(plan.base)).toEqual(["roles/nova.md"]);
  });

  it("never syncs the home's wake store and models, skill drafts or dot-files", () => {
    expect(
      [
        "wake-models.json",
        "wake/nova/1/room.bin",
        "wake-requests/nova.json",
        "skills/a.md",
        ".sync-base.json",
      ].some(packPathSyncs),
    ).toBe(false);
    expect(
      ["executive.md", "roles/nova.md", "templates/fix.md", "routing.json"].every(packPathSyncs),
    ).toBe(true);
  });
});
