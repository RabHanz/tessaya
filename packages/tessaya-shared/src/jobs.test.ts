import type { BatonJob } from "@t3tools/tessaya-contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  jobGroup,
  jobGroupFor,
  permissionsWiden,
  reduceJob,
  workerFirstMessage,
  workerMayExecute,
  type JobLifecycle,
  jobChanges,
  jobLimits,
  jobMoment,
  jobNotice,
  limitReached,
  outboundDecision,
  permissionsSummary,
  pickWorkerAccount,
  withGrant,
  withRevoked,
} from "./jobs.ts";

const perms = {
  folders: ["~/dev/site"],
  projects: ["Spotler"],
  tools: ["read", "edit", "shell"] as const,
};

describe("the groups of a job", () => {
  it("puts it where the state says, and done once settled", () => {
    expect(jobGroup("working", false)).toBe("running");
    expect(jobGroup("idle", false)).toBe("running");
    expect(jobGroup("needs_input", false)).toBe("needs_you");
    expect(jobGroup("needs_approval", false)).toBe("needs_you");
    expect(jobGroup("failed", false)).toBe("failed");
    expect(jobGroup("done_unseen", false)).toBe("done");
    expect(jobGroup("idle", true)).toBe("done");
  });
});

describe("the group of a job that has not started", () => {
  it("waits for his OK in the group that needs him, and a plan being written is running", () => {
    expect(jobGroupFor("idle", false, "awaiting_agreement")).toBe("needs_you");
    expect(jobGroupFor("working", false, "drafting_plan")).toBe("running");
    expect(jobGroupFor("failed", false, "drafting_plan")).toBe("failed");
    expect(jobGroupFor("working", false, "approved")).toBe("running");
  });
});

describe("the permissions, in words", () => {
  it("says where, what, how long and what it may send", () => {
    const text = permissionsSummary({ ...perms, tools: [...perms.tools] }, jobLimits(), []);
    expect(text).toBe(
      "Works in the Spotler project and ~/dev/site. May read files, change files and run commands; no web. Stops after 2 hours or 40 turns. Asks you before it sends anything public.",
    );
  });
  it("names a standing permission, and drops it once revoked", () => {
    const granted = withGrant([], "email", "2026-11-02T10:00:00Z");
    expect(
      permissionsSummary({ ...perms, tools: ["read"] }, jobLimits({ dollars: 5 }), granted),
    ).toContain("May send email without asking");
    const revoked = withRevoked(granted, "email", "2026-11-02T11:00:00Z");
    expect(permissionsSummary({ ...perms, tools: ["read"] }, jobLimits(), revoked)).toContain(
      "Asks you before",
    );
    expect(revoked[0]).toMatchObject({ channel: "email", revokedAt: "2026-11-02T11:00:00Z" });
  });
});

describe("caps and public messages", () => {
  it("stops at two hours or forty turns, and at dollars only when a dollar cap was set", () => {
    const limits = jobLimits();
    expect(limitReached(limits, { minutes: 119, turns: 39 })).toBeNull();
    expect(limitReached(limits, { minutes: 120, turns: 1 })).toBe("time");
    expect(limitReached(limits, { minutes: 5, turns: 40 })).toBe("turns");
    expect(limitReached(limits, { minutes: 5, turns: 5, dollars: 900 })).toBeNull();
    expect(limitReached(jobLimits({ dollars: 5 }), { minutes: 5, turns: 5, dollars: 5 })).toBe(
      "spend",
    );
  });
  it("asks every time for a public message unless this job holds a live grant for that channel", () => {
    const grants = withGrant([], "chat", "2026-11-02T10:00:00Z");
    expect(outboundDecision(grants, "chat")).toBe("standing");
    expect(outboundDecision(grants, "email")).toBe("ask");
    expect(outboundDecision(withRevoked(grants, "chat", "2026-11-02T10:05:00Z"), "chat")).toBe(
      "ask",
    );
    expect(withGrant(grants, "chat", "later")).toBe(grants);
  });
});

describe("the worker's account", () => {
  it("is the one with the most headroom, treating an unreported window as available", () => {
    const pick = pickWorkerAccount([
      { key: "robin", usable: true, windows: [{ usedPercent: 35 }, { usedPercent: 61 }] },
      { key: "optima", usable: true, windows: [{ usedPercent: 40 }] },
      { key: "sablebox", usable: true, windows: [{ usedPercent: 99 }] },
      { key: "old", usable: false, windows: [] },
    ]);
    expect(pick).toBe("optima");
    expect(
      pickWorkerAccount([{ key: "a", usable: true, windows: [{ usedPercent: 100 }] }]),
    ).toBeNull();
    expect(pickWorkerAccount([{ key: "a", usable: true, windows: [] }])).toBe("a");
  });
});

const rev = (text: string, by: "him" | "baton" = "him") => ({
  by,
  at: "2026-11-02T10:00:00Z",
  via: "voice" as const,
  text,
});
const fresh = (grants: JobLifecycle["grants"] = []): JobLifecycle => ({
  phase: "drafting_plan",
  revisions: [],
  grants,
});

describe("a job from his words to work", () => {
  it("runs no work turn before he agrees: planning and waiting both hold", () => {
    expect(workerMayExecute(fresh())).toBe(false);
    const waiting = reduceJob(fresh(), { type: "plan_ready" });
    expect(waiting.phase).toBe("awaiting_agreement");
    expect(workerMayExecute(waiting)).toBe(false);
    // "Go ahead" before the plan exists starts nothing.
    expect(reduceJob(fresh(), { type: "agreed" }).phase).toBe("drafting_plan");
    expect(workerMayExecute(reduceJob(waiting, { type: "agreed" }))).toBe(true);
  });
  it("keeps what he says as part of the job's context, and plans again", () => {
    const waiting = reduceJob(fresh(), { type: "plan_ready" });
    const refined = reduceJob(waiting, {
      type: "refined",
      revision: rev("Also keep the old logo"),
      widens: false,
    });
    expect(refined.revisions.map((r) => r.text)).toEqual(["Also keep the old logo"]);
    expect(refined.phase).toBe("drafting_plan");
    expect(refined.phase).not.toBe("approved");
  });
  it("lets a standing permission skip the wait, only for the job that holds it", () => {
    const withStart = withGrant([], "start", "2026-11-02T09:00:00Z");
    expect(reduceJob(fresh(withStart), { type: "plan_ready" }).phase).toBe("approved");
    expect(reduceJob(fresh(), { type: "plan_ready" }).phase).toBe("awaiting_agreement");
    const revoked = withRevoked(withStart, "start", "2026-11-02T09:30:00Z");
    expect(reduceJob(fresh(revoked), { type: "plan_ready" }).phase).toBe("awaiting_agreement");
  });
  it("asks again when an edit after the start gives the job more, even with a standing permission", () => {
    const running: JobLifecycle = {
      phase: "approved",
      revisions: [],
      grants: withGrant([], "start", "t"),
    };
    const narrow = reduceJob(running, {
      type: "refined",
      revision: rev("use the blue theme"),
      widens: false,
    });
    expect(narrow.phase).toBe("approved");
    expect(narrow.revisions).toHaveLength(1);
    const wide = reduceJob(running, {
      type: "refined",
      revision: rev("you may also use the web"),
      widens: true,
    });
    expect(wide.phase).toBe("awaiting_agreement");
  });
  it("sees what widens: a new tool, folder, project or a longer leash", () => {
    const base = {
      permissions: perms.tools
        ? { folders: ["~/a"], projects: ["A"], tools: ["read" as const] }
        : perms,
      limits: jobLimits(),
    };
    expect(permissionsWiden(base, base)).toBe(false);
    expect(
      permissionsWiden(base, {
        ...base,
        permissions: { ...base.permissions, tools: ["read", "web"] },
      }),
    ).toBe(true);
    expect(
      permissionsWiden(base, {
        ...base,
        permissions: { ...base.permissions, folders: ["~/a", "~/b"] },
      }),
    ).toBe(true);
    expect(permissionsWiden(base, { ...base, limits: jobLimits({ workerTurns: 80 }) })).toBe(true);
    expect(permissionsWiden(base, { ...base, limits: jobLimits({ workerTurns: 10 }) })).toBe(false);
  });
  it("opens the worker's thread with his words exactly, then the permissions, then 'plan first'", () => {
    const text = workerFirstMessage({
      verbatim: "Rebuild the site, but keep Spotler's old logo.",
      permissionsSummary: "Works in the Site project.",
    });
    expect(text.startsWith("He asked: Rebuild the site, but keep Spotler's old logo.")).toBe(true);
    expect(text).toContain("What you may do: Works in the Site project.");
    expect(text).toContain("Do not start the work.");
  });
});

describe("a job's changes for the Record", () => {
  const job = (id: string, phase: string, group: string, limit: string | null = null) =>
    ({
      workSessionId: id,
      title: `Job ${id}`,
      phase,
      group,
      limitReached: limit,
    }) as unknown as BatonJob;
  it("names each change once, and says nothing about a job it is seeing for the first time", () => {
    const seen = new Map([
      ["a", "writing its plan"],
      ["b", "running"],
    ]);
    const changes = jobChanges(
      [
        job("a", "awaiting_agreement", "needs_you"),
        job("b", "approved", "failed", "turns"),
        job("c", "approved", "running"),
      ],
      seen,
    );
    expect(changes.map((c) => `${c.job.workSessionId}:${c.outcome}`)).toEqual([
      "a:plan waits for his OK",
      "b:stopped at its turns limit",
    ]);
    expect(seen.get("c")).toBe("running");
    expect(jobChanges([job("a", "awaiting_agreement", "needs_you")], seen)).toEqual([]);
  });

  it("says aloud only a ready plan, an end, or a need for him", () => {
    expect(
      [
        "plan waits for his OK",
        "done",
        "failed",
        "stopped at its turns limit",
        "running",
        "writing its plan",
      ].map((outcome) => jobNotice("Fix login", outcome)),
    ).toEqual([
      "The plan for Fix login is ready in its thread.",
      "Fix login is done.",
      "Fix login failed.",
      "Fix login stopped at its turns limit.",
      null,
      null,
    ]);
  });
  it("names the same moments for her own words, with the limit as an exact fact", () => {
    expect(
      [
        "plan waits for his OK",
        "done",
        "failed",
        "needs him",
        "stopped at its turns limit",
        "running",
      ].map((outcome) => jobMoment(outcome)),
    ).toEqual([
      { event: "job.plan", facts: {} },
      { event: "job.done", facts: {} },
      { event: "job.failed", facts: {} },
      { event: "job.needs", facts: {} },
      { event: "job.stopped", facts: { limit: "turns" } },
      null,
    ]);
  });
});
