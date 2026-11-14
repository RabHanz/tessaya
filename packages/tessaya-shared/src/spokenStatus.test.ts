import { EMPTY_SYNOPSIS, type WorkSessionSynopsis } from "@t3tools/tessaya-contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  speakFleetCompletions,
  speakFleetNeedsUser,
  speakFleetRunning,
  speakWorkSessionStatus,
  type SpokenWorkSession,
} from "./spokenStatus.ts";

const NOW = Date.parse("2026-09-18T04:10:00.000Z");
const FRESH = "2026-09-18T04:09:30.000Z";
const OLD = "2026-09-18T04:00:00.000Z";

const synopsis = (overrides: Partial<WorkSessionSynopsis>): WorkSessionSynopsis => ({
  ...EMPTY_SYNOPSIS(FRESH),
  ...overrides,
});

const workSession = (overrides: Partial<SpokenWorkSession>): SpokenWorkSession => ({
  title: "Scheduler reconnect race",
  projectLabel: "VantageOS",
  state: "working",
  providerLabel: "Claude B",
  hostLabel: "home-linux",
  synopsis: null,
  ...overrides,
});

describe("speakWorkSessionStatus", () => {
  it("answers the §20 example: what it is doing, what it found, whether you are needed", () => {
    const spoken = speakWorkSessionStatus(
      workSession({
        synopsis: synopsis({
          currentAction: "Running the reconnect integration tests",
          changedFiles: ["src/scheduler.ts", "tests/scheduler.test.ts"],
          recentFindings: [
            {
              text: "A race between commit and acknowledgement",
              observedAt: FRESH,
              source: "events",
            },
          ],
        }),
      }),
      NOW,
    );
    expect(spoken).toBe(
      "Claude B is running the reconnect integration tests on home-linux. It changed two files after finding a race between commit and acknowledgement. It does not currently need you.",
    );
  });

  it("says what is needed when the work is blocked", () => {
    expect(
      speakWorkSessionStatus(workSession({ state: "needs_approval", synopsis: null }), NOW),
    ).toBe("Claude B is waiting for approval on home-linux. It needs you to approve.");
    expect(speakWorkSessionStatus(workSession({ state: "needs_input" }), NOW)).toBe(
      "Claude B asked you a question on home-linux. It needs an answer.",
    );
  });

  it("names an exhausted account and points at the way out", () => {
    expect(speakWorkSessionStatus(workSession({ state: "limited" }), NOW)).toBe(
      "Claude B has reached its account limit on home-linux. Continue it on another account when you are ready.",
    );
  });

  it("discloses a stale synopsis instead of reading it as current", () => {
    const spoken = speakWorkSessionStatus(
      workSession({
        synopsis: synopsis({ currentAction: "Running the reconnect tests", updatedAt: OLD }),
      }),
      NOW,
    );
    expect(spoken).toContain("That is the last thing recorded, 10 minutes ago.");
  });

  it("falls back to the state's own label with nothing recorded", () => {
    expect(speakWorkSessionStatus(workSession({ synopsis: null }), NOW)).toBe(
      "Claude B is working on home-linux. It does not currently need you.",
    );
  });

  it("names the project when no account is attached", () => {
    expect(
      speakWorkSessionStatus(
        workSession({ providerLabel: null, state: "idle", hostLabel: null }),
        NOW,
      ),
    ).toBe("VantageOS is idle. It does not currently need you.");
  });
});

describe("speakFleetNeedsUser", () => {
  it("answers the §20 example: approvals, questions, then what is still working", () => {
    const spoken = speakFleetNeedsUser([
      workSession({
        title: "Restart the worker",
        projectLabel: "Production",
        providerLabel: "Production",
        state: "needs_approval",
      }),
      workSession({
        title: "VantageOS review",
        providerLabel: "Codex",
        state: "needs_input",
      }),
      workSession({ state: "working" }),
      workSession({ state: "working" }),
    ]);
    expect(spoken).toBe(
      "Production is waiting for approval on Restart the worker. Codex has a question about VantageOS review. 2 other sessions are still working.",
    );
  });

  it("says so plainly when nothing needs the user", () => {
    expect(speakFleetNeedsUser([workSession({ state: "idle" })])).toBe("Nothing needs you.");
    expect(speakFleetNeedsUser([workSession({ state: "working" })])).toBe(
      "Nothing needs you. 1 session is still working.",
    );
  });
});

describe("speakFleetCompletions", () => {
  it("names what finished, how long ago, and how its checks ended", () => {
    const spoken = speakFleetCompletions(
      [
        workSession({
          title: "Spotler search",
          state: "done_unseen",
          synopsis: synopsis({
            updatedAt: "2026-09-18T04:04:00.000Z",
            validation: [
              { label: "pnpm test", outcome: "passed", observedAt: "2026-09-18T04:04:00.000Z" },
            ],
          }),
        }),
      ],
      NOW,
    );
    expect(spoken).toBe("Spotler search finished 6 minutes ago — pnpm test passed.");
  });

  it("says nothing finished rather than inventing a completion", () => {
    expect(speakFleetCompletions([workSession({ state: "working" })], NOW)).toBe(
      "Nothing has finished since you last looked.",
    );
  });
});

describe("speakFleetRunning", () => {
  it("is a roll call, not a report", () => {
    expect(
      speakFleetRunning([
        workSession({ state: "working" }),
        workSession({ title: "Margin search", providerLabel: "Codex", state: "monitoring" }),
        workSession({ state: "idle" }),
      ]),
    ).toBe(
      "Scheduler reconnect race on Claude B at home-linux. Margin search on Codex at home-linux.",
    );
  });

  it("says nothing is running when nothing is", () => {
    expect(speakFleetRunning([workSession({ state: "idle" })])).toBe("Nothing is running.");
  });
});
