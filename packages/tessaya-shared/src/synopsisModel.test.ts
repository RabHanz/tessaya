/**
 * What the model may write, and what it may not touch.
 *
 * The interesting cases are all refusals of authority rather than of text: a
 * model that writes two sentences is doing its job, and a model that quietly
 * changes `needsUser` is deciding whether to interrupt somebody.
 */
import { describe, expect, it } from "vite-plus/test";

import { EMPTY_SYNOPSIS, type WorkSessionSynopsis } from "@t3tools/tessaya-contracts";

import { applyModelSynopsis, buildSynopsisPrompt, SYNOPSIS_TURN_WINDOW } from "./synopsisModel.ts";

const base: WorkSessionSynopsis = {
  ...EMPTY_SYNOPSIS("2026-09-18T09:00:00.000Z"),
  currentAction: "Running tests",
  next: ["review rule: have Claude review it"],
  needsUser: true,
  changedFiles: ["apps/server/src/scheduler.ts"],
  validation: [
    { label: "pnpm test", outcome: "passed" as const, observedAt: "2026-09-18T09:00:00.000Z" },
  ],
  recentFindings: [
    {
      text: "the reconnect races the queue drain",
      observedAt: "2026-09-18T08:59:00.000Z",
      source: "events" as const,
    },
  ],
};

describe("a written synopsis replaces the account, not the facts", () => {
  const written = applyModelSynopsis(base, {
    currentAction: "The reconnect fix is in and the queue drain no longer double-schedules.",
    next: "Run the integration suite against a restarted scheduler to confirm.",
    at: "2026-09-18T09:05:00.000Z",
  });

  it("writes the two sentences and marks where they came from", () => {
    expect(written.currentAction).toBe(
      "The reconnect fix is in and the queue drain no longer double-schedules.",
    );
    expect(written.next).toEqual([
      "Run the integration suite against a restarted scheduler to confirm.",
    ]);
    expect(written.source).toBe("model");
    expect(written.updatedAt).toBe("2026-09-18T09:05:00.000Z");
  });

  it("leaves every derived fact exactly as the events left it", () => {
    // The whole safety argument for D51 in four assertions: a model writes the
    // account and decides nothing.
    expect(written.needsUser).toBe(true);
    expect(written.changedFiles).toEqual(base.changedFiles);
    expect(written.validation).toEqual(base.validation);
    expect(written.recentFindings).toEqual(base.recentFindings);
  });

  it("keeps one sentence when the model sends a paragraph", () => {
    const long = applyModelSynopsis(base, {
      currentAction: "The fix is in. It also touched the retry path. Tests are green.",
      next: "Confirm on a restart. Then close it.",
      at: "2026-09-18T09:05:00.000Z",
    });

    // This line renders in a 256px sidebar; a paragraph there is a scrollbar.
    expect(long.currentAction).toBe("The fix is in.");
    expect(long.next).toEqual(["Confirm on a restart."]);
  });

  it("keeps what was there when the model writes nothing usable", () => {
    const empty = applyModelSynopsis(base, {
      currentAction: "   ",
      next: "",
      at: "2026-09-18T09:05:00.000Z",
    });

    expect(empty.currentAction).toBe("Running tests");
    expect(empty.next).toEqual(base.next);
  });
});

describe("the prompt carries the work and its turns, and nothing else", () => {
  const prompt = buildSynopsisPrompt({
    title: "Scheduler reconnect race",
    objective: "A reconnect must not double-schedule the queue.",
    turns: [
      { role: "user", text: "the queue double-schedules after a reconnect" },
      { role: "assistant", text: "Traced it to the drain running before the lease is taken." },
    ],
  });

  it("names the work and labels who said what", () => {
    expect(prompt).toContain("Scheduler reconnect race");
    expect(prompt).toContain("A reconnect must not double-schedule the queue.");
    expect(prompt).toContain("Person: the queue double-schedules after a reconnect");
    expect(prompt).toContain("Agent: Traced it to the drain");
  });

  it("bounds the window, so a long thread costs the same as a short one", () => {
    const many = buildSynopsisPrompt({
      title: "Long one",
      objective: "",
      turns: Array.from({ length: 40 }, (_, index) => ({
        role: "user" as const,
        text: `turn number ${index}`,
      })),
    });

    expect(many).toContain("turn number 39");
    expect(many).not.toContain("turn number 33");
    expect(many.split("\n").filter((line) => line.startsWith("Person:")).length).toBe(
      SYNOPSIS_TURN_WINDOW,
    );
  });

  it("says so rather than sending an empty section when there are no turns", () => {
    const none = buildSynopsisPrompt({ title: "New work", objective: "", turns: [] });
    expect(none).toContain("(nothing yet)");
  });
});
