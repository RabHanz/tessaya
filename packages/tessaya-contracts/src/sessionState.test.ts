import { describe, expect, it } from "vite-plus/test";

import {
  deriveBatonSessionState,
  deriveWorkSessionState,
  hasUnseenCompletion,
  type BatonSessionStateInput,
} from "./sessionState.ts";

const base: BatonSessionStateInput = {
  environmentOnline: true,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  sessionStatus: null,
  sessionLastError: null,
  backgroundLiveness: null,
  latestTurnState: null,
  latestTurnCompletedAt: null,
  lastVisitedAt: null,
  providerQuotaExhausted: false,
};

const derive = (overrides: Partial<BatonSessionStateInput>) =>
  deriveBatonSessionState({ ...base, ...overrides });

describe("deriveBatonSessionState", () => {
  it("reports offline before anything else, because a cached state from a gone environment misleads", () => {
    expect(
      derive({
        environmentOnline: false,
        sessionStatus: "running",
        hasPendingApprovals: true,
      }),
    ).toBe("offline");
  });

  it("puts a pending approval above a running session", () => {
    // A session waiting for approval is not making progress, whatever its
    // process is doing.
    expect(derive({ hasPendingApprovals: true, sessionStatus: "running" })).toBe("needs_approval");
  });

  it("puts a pending question above a running session", () => {
    expect(derive({ hasPendingUserInput: true, sessionStatus: "running" })).toBe("needs_input");
  });

  it("prefers an approval to a question when both are pending", () => {
    expect(derive({ hasPendingApprovals: true, hasPendingUserInput: true })).toBe("needs_approval");
  });

  it("reports failure from either the session or the turn", () => {
    expect(derive({ sessionStatus: "error" })).toBe("failed");
    expect(derive({ sessionLastError: "provider exited" })).toBe("failed");
    expect(derive({ latestTurnState: "error" })).toBe("failed");
  });

  it("a failure outranks lingering background liveness", () => {
    expect(derive({ sessionStatus: "error", backgroundLiveness: "working" })).toBe("failed");
  });

  it("reports an exhausted account as limited, not idle", () => {
    // "idle" would hide the reason the work stopped, and the reason is the
    // thing that tells the user a handoff is available.
    expect(derive({ providerQuotaExhausted: true })).toBe("limited");
  });

  it("does not call a busy provider limited, even with an exhausted window", () => {
    // Quota is reported per account; a window at 100% while a turn is running
    // means another thread consumed it, not that this one stopped.
    expect(derive({ providerQuotaExhausted: true, sessionStatus: "running" })).toBe("working");
    expect(derive({ providerQuotaExhausted: true, backgroundLiveness: "monitoring" })).toBe(
      "monitoring",
    );
  });

  it("maps session and background status onto working, starting and monitoring", () => {
    expect(derive({ sessionStatus: "starting" })).toBe("starting");
    expect(derive({ sessionStatus: "running" })).toBe("working");
    expect(derive({ backgroundLiveness: "working" })).toBe("working");
    expect(derive({ backgroundLiveness: "monitoring" })).toBe("monitoring");
    expect(derive({ latestTurnState: "running" })).toBe("working");
  });

  it("reports an unseen completion, and stops once the user has looked", () => {
    const completed = "2026-09-18T04:00:00.000Z";
    expect(derive({ latestTurnState: "completed", latestTurnCompletedAt: completed })).toBe(
      "done_unseen",
    );
    expect(
      derive({
        latestTurnState: "completed",
        latestTurnCompletedAt: completed,
        lastVisitedAt: "2026-09-18T04:00:01.000Z",
      }),
    ).toBe("idle");
  });

  it("falls through to idle when nothing is happening", () => {
    expect(derive({ sessionStatus: "stopped" })).toBe("idle");
    expect(derive({ sessionStatus: "ready" })).toBe("idle");
  });
});

describe("hasUnseenCompletion", () => {
  it("treats an unparseable visit time as never visited", () => {
    expect(
      hasUnseenCompletion({
        latestTurnCompletedAt: "2026-09-18T04:00:00.000Z",
        lastVisitedAt: "not a date",
      }),
    ).toBe(true);
  });

  it("is false with no completion at all", () => {
    expect(hasUnseenCompletion({ latestTurnCompletedAt: null, lastVisitedAt: null })).toBe(false);
  });
});

describe("deriveWorkSessionState", () => {
  it("is idle with no live thread, because work between providers is normal", () => {
    expect(deriveWorkSessionState([])).toBe("idle");
  });

  it("takes the most demanding state among its threads", () => {
    // An implementation session working while a review session waits for
    // approval is work that needs the user.
    expect(deriveWorkSessionState(["working", "needs_approval"])).toBe("needs_approval");
    expect(deriveWorkSessionState(["idle", "working"])).toBe("working");
    expect(deriveWorkSessionState(["done_unseen", "idle"])).toBe("done_unseen");
    expect(deriveWorkSessionState(["failed", "working"])).toBe("failed");
  });
});
