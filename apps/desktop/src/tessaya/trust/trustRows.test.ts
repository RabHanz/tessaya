// @effect-diagnostics globalDate:off
import { describe, expect, it } from "vite-plus/test";

import {
  describeTrust,
  lastUsed,
  parseTrustLogs,
  trustAction,
  trustControls,
  type TrustData,
} from "./trustRows.ts";

const NOW = Date.parse("2026-11-03T12:00:00Z");
const turns = [
  { at: "2026-11-03T11:00:00Z", kind: "action", tool: "screen_capture", outcome: "allowed" },
  {
    at: "2026-11-03T11:30:00Z",
    kind: "action",
    tool: "weave_send",
    action: "to build",
    outcome: "allowed",
  },
  { at: "2026-11-03T11:40:00Z", kind: "turn", transcript: "never shown" },
  {
    at: "2026-11-03T10:00:00Z",
    kind: "action",
    tool: "mcp__claude-in-chrome__navigate",
    outcome: "refused",
  },
  {
    at: "2026-11-03T09:30:00Z",
    kind: "action",
    by: "remote-hands",
    tool: "ui_tree",
    outcome: "allowed",
  },
]
  .map((l) => JSON.stringify(l))
  .join("\n");
const play = JSON.stringify({
  at: "2026-11-03T07:00:00Z",
  kind: "playbook",
  playbook: "ci_look",
  text: "ci on x: started",
});
const social = JSON.stringify({
  at: "2026-11-03T09:00:00Z",
  host: "x.com",
  tool: "click",
  action: "post",
  outcome: "asked",
});
const vault = JSON.stringify({
  at: "2026-11-03T08:00:00Z",
  name: "github",
  purpose: "login",
  target: "github.com",
  outcome: "used",
});

const data = (over: Partial<TrustData> = {}): TrustData => ({
  screenAlways: true,
  chrome: false,
  social: true,
  act: false,
  remote: true,
  vault: "unlocked",
  grants: [{ jobId: "j1", title: "Site", channel: "retry", since: "2026-11-01T00:00:00Z" }],
  standing: [
    {
      kind: "built_in",
      id: "ci_look",
      title: "When a build fails",
      what: "Looks.",
      owner: "Tessaya",
      on: false,
      count: 0,
    },
    {
      kind: "rule",
      id: "r-1",
      title: "when build finishes, have Codex review it",
      what: "",
      owner: "Tessaya",
      on: true,
      count: 2,
    },
    {
      kind: "schedule",
      id: "job-9",
      title: "Nightly report",
      what: "",
      owner: "Tessaya",
      on: null,
      count: 4,
    },
  ],
  entries: parseTrustLogs({ turns: `${turns}\n${play}`, social: `${social}\ngarbage{`, vault }),
  filter: "all",
  ...over,
});

describe("trust page", () => {
  it("merges the logs newest first and keeps only action lines from the turn log", () => {
    const entries = parseTrustLogs({ turns, social, vault });
    expect(entries.map((e) => e.kind)).toEqual([
      "weave",
      "action",
      "action",
      "action",
      "social",
      "vault",
    ]);
    expect(JSON.stringify(entries)).not.toContain("never shown");
  });

  it("knows when each permission was last used, ignoring refused calls", () => {
    const used = lastUsed(parseTrustLogs({ turns, social, vault }));
    expect(used.screen).toBe("2026-11-03T11:00:00Z");
    expect(used.chrome).toBeUndefined();
    expect(used.weave).toBe("2026-11-03T11:30:00Z");
    expect(used.vault).toBe("2026-11-03T08:00:00Z");
    expect(used.remote).toBe("2026-11-03T09:30:00Z");
  });

  it("offers a revoke only for what is on, and one per standing grant", () => {
    const ids = trustControls(data(), NOW).map((c) => `${c.kind}:${c.id}`);
    expect(ids).toContain("action:trust.revoke:screen");
    expect(ids).toContain("action:trust.revoke:social");
    expect(ids).toContain("action:trust.revoke:vault");
    expect(ids).toContain("action:trust.revoke:remote");
    expect(ids).toContain("action:trust.revoke:grant:j1:retry");
    expect(ids).toContain("check:trust.off:chrome");
    expect(ids).not.toContain("action:trust.revoke:chrome");
  });

  it("lists built-in jobs, his rules and schedules as one kind of standing job, each with its owner and count", () => {
    const rows = trustControls(data(), NOW);
    const builtIn = rows.find((c) => c.id === "trust.standing:ci_look");
    expect(builtIn?.kind === "toggle" && builtIn.on).toBe(false);
    expect(rows.find((c) => c.id === "trust.rule:r-1")?.hint).toContain(
      "Tessaya's standing job. Ran 2 times.",
    );
    expect(rows.find((c) => c.id === "trust.schedule:job-9")?.kind).toBe("action");
    expect(trustAction("trust.standing:ci_look", true)).toEqual({
      kind: "standing",
      id: "ci_look",
      on: true,
    });
    expect(trustAction("trust.rule:r-1", false)).toEqual({ kind: "rule", id: "r-1", on: false });
    expect(trustAction("trust.schedule:job-9", null)).toEqual({
      kind: "unschedule",
      jobId: "job-9",
    });
  });

  it("shows a timed job's missed-run policy on its own row, and reads a change to it", () => {
    const brief = {
      kind: "built_in" as const,
      id: "morning_brief",
      title: "Every morning, build my brief",
      what: "Writes the brief.",
      owner: "Tessaya",
      on: true,
      count: 3,
      missed: "skip" as const,
    };
    const rows = trustControls(data({ standing: [brief] }), NOW);
    const missed = rows.find((c) => c.id === "trust.missed:morning_brief");
    expect(missed?.kind === "choice" && missed.value).toBe("skip");
    // An event job has no hour to miss: no such row.
    expect(trustControls(data(), NOW).some((c) => c.id.startsWith("trust.missed:"))).toBe(false);
    expect(trustAction("trust.missed:morning_brief", "once")).toEqual({
      kind: "missed",
      id: "morning_brief",
      missed: "once",
    });
    expect(trustAction("trust.missed:morning_brief", "later")).toBeNull();
  });

  it("lists his own job with a switch, its words to edit and a way to remove it; a proposal says whose it is", () => {
    const mine = {
      kind: "user" as const,
      id: "user:2",
      title: "Morning CI check",
      what: "Every day at 08:00: check CI and tell me what broke",
      owner: "Tessaya",
      on: false,
      count: 0,
      instruction: "check CI and tell me what broke",
      proposed: true,
      missed: "once" as const,
    };
    const rows = trustControls(data({ standing: [mine] }), NOW);
    const ids = rows.map((r) => r.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "trust.userjob:user:2",
        "trust.userjobtext:user:2",
        "trust.userjobdel:user:2",
        "trust.missed:user:2",
      ]),
    );
    expect(rows.find((r) => r.id === "trust.userjob:user:2")?.label).toContain("proposed");
    expect(trustAction("trust.userjob:user:2", true)).toEqual({
      kind: "userJob",
      id: "user:2",
      on: true,
    });
    expect(trustAction("trust.userjobtext:user:2:save", " check CI on tessaya ")).toEqual({
      kind: "userJobText",
      id: "user:2",
      text: "check CI on tessaya",
    });
    expect(trustAction("trust.userjobtext:user:2:save", "  ")).toBeNull();
    expect(trustAction("trust.userjobdel:user:2", null)).toEqual({
      kind: "userJobDelete",
      id: "user:2",
    });
    // trust_show names every one of his, with its id and whether it is off or proposed.
    const spoken = describeTrust(
      data({ standing: [mine, { ...mine, id: "user:3", proposed: false, on: false }] }),
      NOW,
    );
    expect(spoken).toContain("id user:2, proposed");
    expect(spoken).toContain("id user:3, off");
    // An approved job in a device's words says so, so he knows they are run as data.
    const approved = trustControls(
      data({ standing: [{ ...mine, proposed: false, on: true, from: "device" as const }] }),
      NOW,
    ).find((r) => r.id === "trust.userjob:user:2");
    expect(approved?.hint).toContain("words a device wrote");
  });

  it("offers quiet unless changed for an event job, and reads the switch", () => {
    const ciLook = {
      kind: "built_in" as const,
      id: "ci_look",
      title: "When a build fails",
      what: "Looks.",
      owner: "Tessaya",
      on: true,
      count: 1,
      quiet: true,
    };
    const row = trustControls(data({ standing: [ciLook] }), NOW).find(
      (c) => c.id === "trust.quiet:ci_look",
    );
    expect(row?.kind === "toggle" && row.on).toBe(true);
    expect(trustAction("trust.quiet:ci_look", false)).toEqual({
      kind: "quiet",
      id: "ci_look",
      on: false,
    });
  });

  it("filters the log", () => {
    const logRows = (filter: TrustData["filter"]) =>
      trustControls(data({ filter }), NOW).filter((c) => c.id.startsWith("trust.log:"));
    expect(logRows("all")).toHaveLength(7);
    expect(logRows("playbook")).toHaveLength(1);
    expect(logRows("vault")).toHaveLength(1);
    expect(logRows("weave")).toHaveLength(1);
  });

  it("reads clicks", () => {
    expect(trustAction("trust.revoke:chrome", true)).toEqual({ kind: "revoke", what: "chrome" });
    expect(trustAction("trust.revoke:remote", null)).toEqual({ kind: "revoke", what: "remote" });
    expect(trustAction("trust.revoke:grant:job-1:pr_comment", null)).toEqual({
      kind: "grant",
      jobId: "job-1",
      channel: "pr_comment",
    });
    expect(trustAction("trust.filter", "social")).toEqual({ kind: "filter", filter: "social" });
    expect(trustAction("trust.filter", "nope")).toBeNull();
  });
});

describe("trust by voice", () => {
  it("describes the permissions and today's activity in plain words", async () => {
    const { describeToday, describeTrust, permissionFromWords } = await import("./trustRows.ts");
    const said = describeTrust(data(), NOW);
    expect(said).toContain("Your Chrome: off.");
    expect(said).toContain("Looking at your screen without asking: on (last used");
    expect(said).toContain(
      "Standing jobs: when build finishes, have Codex review it (Tessaya, ran 2); Nightly report (Tessaya, 4 turns).",
    );
    expect(describeToday([], new Date(NOW))).toContain("Nothing yet today");
    expect(describeToday(data().entries, new Date("2026-11-03T12:00:00Z"))).toContain("Today:");
    expect(permissionFromWords("turn off Chrome")).toBe("chrome");
    expect(permissionFromWords("turn off remote hands")).toBe("remote");
    expect(said).toContain("Remote hands: on");
    expect(permissionFromWords("the weather")).toBeNull();
  });
});
