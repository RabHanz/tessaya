import { EMPTY_SYNOPSIS, SYNOPSIS_MAX_CHANGED_FILES } from "@t3tools/tessaya-contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applySynopsisSignal,
  applySynopsisSignals,
  isValidationLabel,
  synopsisSignalForActivity,
} from "./synopsis.ts";

const T0 = "2026-09-18T04:00:00.000Z";
const T1 = "2026-09-18T04:01:00.000Z";
const T2 = "2026-09-18T04:02:00.000Z";
const empty = EMPTY_SYNOPSIS(T0);

describe("applySynopsisSignal", () => {
  it("takes the first sentence of a prompt as the current action", () => {
    const next = applySynopsisSignal(empty, {
      kind: "turn-started",
      at: T1,
      prompt: "Find the reconnect race. Then write a failing test for it.",
    });
    expect(next.currentAction).toBe("Find the reconnect race.");
    expect(next.updatedAt).toBe(T1);
    expect(next.updatedBy).toBe("turn-started");
  });

  it("clears the current action when the turn ends", () => {
    // Leaving "Running tests" on screen after the turn stopped is the stale
    // label §11 warns about.
    const running = applySynopsisSignal(empty, { kind: "tool-started", at: T1, label: "vitest" });
    const done = applySynopsisSignal(running, { kind: "turn-completed", at: T2 });
    expect(done.currentAction).toBeNull();
    expect(done.needsUser).toBe(false);
  });

  it("does not move the clock for a signal that carried nothing", () => {
    const next = applySynopsisSignal(empty, { kind: "tool-started", at: T1, label: "   " });
    expect(next).toBe(empty);
    expect(next.updatedAt).toBe(T0);
  });

  it("records changed files most recent first, without duplicates", () => {
    const next = applySynopsisSignals(empty, [
      { kind: "files-changed", at: T1, paths: ["src/scheduler.ts", "tests/scheduler.test.ts"] },
      { kind: "files-changed", at: T2, paths: ["src/scheduler.ts"] },
    ]);
    expect(next.changedFiles).toEqual(["src/scheduler.ts", "tests/scheduler.test.ts"]);
  });

  it("bounds the changed-file list, because a synopsis is a glance", () => {
    const paths = Array.from({ length: SYNOPSIS_MAX_CHANGED_FILES + 5 }, (_, i) => `src/f${i}.ts`);
    const next = applySynopsisSignal(empty, { kind: "files-changed", at: T1, paths });
    expect(next.changedFiles).toHaveLength(SYNOPSIS_MAX_CHANGED_FILES);
  });

  it("tracks a validation from running to its outcome, under one label", () => {
    const started = applySynopsisSignal(empty, {
      kind: "validation-started",
      at: T1,
      label: "reconnect integration test",
    });
    expect(started.validation).toEqual([
      { label: "reconnect integration test", outcome: "running", observedAt: T1 },
    ]);
    const finished = applySynopsisSignal(started, {
      kind: "validation-finished",
      at: T2,
      label: "reconnect integration test",
      passed: true,
    });
    expect(finished.validation).toEqual([
      { label: "reconnect integration test", outcome: "passed", observedAt: T2 },
    ]);
  });

  it("raises and clears needsUser on approvals and questions", () => {
    const asked = applySynopsisSignal(empty, {
      kind: "approval-requested",
      at: T1,
      label: "write src/scheduler.ts",
    });
    expect(asked.needsUser).toBe(true);
    expect(asked.currentAction).toBe("Waiting for approval: write src/scheduler.ts");
    expect(applySynopsisSignal(asked, { kind: "approval-resolved", at: T2 }).needsUser).toBe(false);

    const question = applySynopsisSignal(empty, {
      kind: "question-asked",
      at: T1,
      label: "Which branch should this target?",
    });
    expect(question.needsUser).toBe(true);
    expect(applySynopsisSignal(question, { kind: "question-answered", at: T2 }).needsUser).toBe(
      false,
    );
  });

  it("records a failure as a finding and asks for the user", () => {
    const failed = applySynopsisSignal(empty, {
      kind: "turn-failed",
      at: T1,
      reason: "provider exited with code 1",
    });
    expect(failed.needsUser).toBe(true);
    expect(failed.currentAction).toBeNull();
    expect(failed.recentFindings[0]?.text).toBe("provider exited with code 1");
  });

  it("puts an opened pull request in next, not in findings", () => {
    const next = applySynopsisSignal(empty, {
      kind: "pull-request-opened",
      at: T1,
      label: "owner/repo#42",
    });
    expect(next.next).toEqual(["Review owner/repo#42"]);
    expect(next.recentFindings).toHaveLength(0);
  });

  it("keeps findings de-duplicated and newest first", () => {
    const next = applySynopsisSignals(empty, [
      { kind: "finding", at: T1, text: "Stale ownership survives one reconnect", source: "events" },
      { kind: "finding", at: T2, text: "Race is after commit, before ACK", source: "events" },
      { kind: "finding", at: T2, text: "Stale ownership survives one reconnect", source: "events" },
    ]);
    expect(next.recentFindings.map((finding) => finding.text)).toEqual([
      "Stale ownership survives one reconnect",
      "Race is after commit, before ACK",
    ]);
  });

  it("marks model-generated text as such, so it is never read as a recorded fact", () => {
    const next = applySynopsisSignal(empty, {
      kind: "finding",
      at: T1,
      text: "The scheduler probably double-dispatches",
      source: "model",
    });
    expect(next.source).toBe("model");
    expect(next.recentFindings[0]?.source).toBe("model");
  });
});

describe("synopsisSignalForActivity", () => {
  const activity = (kind: string, summary: string) => ({ kind, summary, createdAt: T1 });

  it("maps the §11.1 triggers", () => {
    expect(synopsisSignalForActivity(activity("approval.requested", "write a file"))?.kind).toBe(
      "approval-requested",
    );
    expect(synopsisSignalForActivity(activity("user-input.requested", "which branch?"))?.kind).toBe(
      "question-asked",
    );
    expect(synopsisSignalForActivity(activity("turn.plan.updated", "step 2 of 4"))?.kind).toBe(
      "plan-step",
    );
    expect(synopsisSignalForActivity(activity("runtime.error", "boom"))?.kind).toBe("finding");
  });

  it("splits tool starts into validation and ordinary work", () => {
    expect(synopsisSignalForActivity(activity("tool.started", "pnpm test"))?.kind).toBe(
      "validation-started",
    );
    expect(synopsisSignalForActivity(activity("tool.started", "read src/index.ts"))?.kind).toBe(
      "tool-started",
    );
  });

  it("reads a failed validation from its own label", () => {
    const signal = synopsisSignalForActivity(activity("tool.completed", "pnpm test failed"));
    expect(signal).toEqual({
      kind: "validation-finished",
      at: T1,
      label: "pnpm test failed",
      passed: false,
    });
  });

  it("ignores a completion that was not a validation, rather than guessing", () => {
    expect(synopsisSignalForActivity(activity("tool.completed", "read src/index.ts"))).toBeNull();
  });

  it("returns null for an activity kind it does not know", () => {
    // A fork adding an activity kind must not silently start rewriting
    // synopses with a meaning nobody chose.
    expect(synopsisSignalForActivity(activity("some.fork.activity", "who knows"))).toBeNull();
  });
});

describe("isValidationLabel", () => {
  it("recognises the commands that prove something", () => {
    expect(isValidationLabel("vp test run src/x.test.ts")).toBe(true);
    expect(isValidationLabel("pnpm typecheck")).toBe(true);
    expect(isValidationLabel("eslint --fix")).toBe(false);
    expect(isValidationLabel("cat README.md")).toBe(false);
  });
});
