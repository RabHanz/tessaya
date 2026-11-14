import { describe, expect, it } from "vite-plus/test";

import { tabOf } from "../home/tabs.ts";
import { presenceControls, presencePatch } from "./presenceRows.ts";

const settings = {
  awarenessWindow: false,
  awarenessIdle: false,
  awarenessFocus: false,
  awarenessJobs: false,
  initiativeMode: "written",
  initiativePerHour: 3,
  needsRepos: ["o/a"],
  ciRepos: [],
  needsDeadlinesFile: null,
  needsFeeds: [],
  needsExpect: ["Cockpit approvals"],
} as const;

describe("the Presence settings", () => {
  it("shows every switch off by default, none folded away, each in a Settings category", () => {
    const rows = presenceControls(settings);
    expect(rows.filter((r) => r.kind === "toggle").every((r) => r.kind === "toggle" && !r.on)).toBe(
      true,
    );
    expect(rows.some((r) => r.more === true)).toBe(false);
    // What Tessaya notices is privacy; what she offers and watches is her work for him.
    for (const r of rows) expect(["privacy", "assistant"]).toContain(tabOf(r.id));
  });
  it("turns a control into a settings patch and refuses a value it does not offer", () => {
    expect(presencePatch("pr.awWindow", true, settings)).toEqual({ awarenessWindow: true });
    expect(presencePatch("pr.initiative", "spoken", settings)).toEqual({
      initiativeMode: "spoken",
    });
    expect(presencePatch("pr.initiative", "loud", settings)).toBeNull();
    expect(presencePatch("pr.perHour", "5", settings)).toEqual({ initiativePerHour: 5 });
    expect(presencePatch("pr.perHour", "99", settings)).toBeNull();
  });

  it("adds and removes list rows, accepting a pasted URL and refusing nonsense", () => {
    expect(presencePatch("pr.needsRepos:add", "https://github.com/o/b.git", settings)).toEqual({
      needsRepos: ["o/a", "o/b"],
    });
    expect(presencePatch("pr.needsRepos:add", "o/a", settings)).toEqual({ needsRepos: ["o/a"] });
    expect(presencePatch("pr.needsRepos:add", "not a repo", settings)).toBeNull();
    expect(presencePatch("pr.needsRepos:rm", "o/a", settings)).toEqual({ needsRepos: [] });
    expect(presencePatch("pr.deadlines:add", " C:\\x\\d.json ", settings)).toEqual({
      needsDeadlinesFile: "C:\\x\\d.json",
    });
    expect(presencePatch("pr.deadlines:rm", "x", settings)).toEqual({ needsDeadlinesFile: null });
  });

  it("adds status files and expected sources, and refuses a duplicate or an empty one", () => {
    expect(presencePatch("pr.feeds:add", " C:\\x\\peers.json ", settings)).toEqual({
      needsFeeds: ["C:\\x\\peers.json"],
    });
    expect(presencePatch("pr.expect:add", "Peers' status", settings)).toEqual({
      needsExpect: ["Cockpit approvals", "Peers' status"],
    });
    expect(presencePatch("pr.expect:add", "Cockpit approvals", settings)).toBeNull();
    expect(presencePatch("pr.expect:rm", "Cockpit approvals", settings)).toEqual({
      needsExpect: [],
    });
    expect(presencePatch("pr.feeds:add", "  ", settings)).toBeNull();
  });
});
