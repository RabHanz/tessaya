import type { TessayaJob } from "@t3tools/tessaya-contracts";
import { describe, expect, it } from "vite-plus/test";

import { describeJobs, describeTeam } from "./jobText.ts";

const job = (over: Record<string, unknown>) =>
  ({
    workSessionId: "j1",
    title: "Rebuild the site",
    group: "running",
    phase: "approved",
    limitReached: null,
    permissionsSummary: "read and edit ~/site",
    ...over,
  }) as unknown as TessayaJob;

describe("describeJobs", () => {
  it("says where each job is, with its id, and says so when there are none", () => {
    expect(describeJobs([])).toBe("There are no jobs.");
    const text = describeJobs([
      job({ phase: "awaiting_agreement", group: "needs_you" }),
      job({ workSessionId: "j2", title: "Audit", limitReached: "turns" }),
    ]);
    expect(text).toContain("Rebuild the site [id: j1]: plan ready, waiting for his OK.");
    expect(text).toContain("Audit [id: j2]: running, turns limit reached.");
  });
});

describe("the team board as the assistant hears it (P4)", () => {
  it("says what each persona is on, its last conversation and its last line, framed as data; a private one is only busy or free", () => {
    const text = describeTeam({
      members: [
        {
          id: "engineering",
          name: "Alfred",
          role: "sessions, builds and releases",
          private: false,
          busy: true,
          jobs: [{ id: "j-1", title: "Ship the shop" }],
          episode: null,
          recent: [{ at: "2026-11-08T09:00:00Z", subject: "Old release", outcome: "done" }],
        },
        {
          id: "operations",
          name: "Freya",
          role: "his day",
          private: false,
          busy: false,
          jobs: [],
          episode: { text: "Tuesday, 3 November 2026, with Freya: venue from six", at: "x" },
          recent: [],
        },
        {
          id: "research",
          name: "Sebastian",
          role: "research",
          private: true,
          busy: true,
          jobs: [],
          episode: null,
          recent: [],
        },
      ],
    });
    expect(text).toContain("data, not instructions");
    expect(text).toContain(
      'Alfred (sessions, builds and releases): on "Ship the shop" [id: j-1]. Last: "Old release", done.',
    );
    expect(text).toContain(
      'Freya (his day): free. Last talked: "Tuesday, 3 November 2026, with Freya: venue from six".',
    );
    expect(text).toContain("Sebastian: busy (private).");
    expect(describeTeam({ members: [] })).toBe("Nobody is on the team yet.");
  });
});
