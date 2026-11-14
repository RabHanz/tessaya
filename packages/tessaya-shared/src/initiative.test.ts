import { DateTime } from "effect";
import type { WatchFinding } from "@t3tools/tessaya-contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  answerOffer,
  allowTopic,
  decide,
  DEFAULT_POLICY,
  EMPTY_INITIATIVE,
  triggersFromCi,
  triggersFromFindings,
  stopAbout,
  resumeAbout,
} from "./initiative.ts";

const now = Date.parse("2026-11-02T12:00:00Z");
const failed = (id: string, minutes = 20) =>
  triggersFromFindings([
    { workSessionId: id, title: `Build ${id}`, kind: "failed", minutes },
  ] as unknown as ReadonlyArray<WatchFinding>);

describe("the initiative policy", () => {
  it("offers a failure once, then not again inside the cooldown", () => {
    const first = decide(failed("a"), EMPTY_INITIATIVE, DEFAULT_POLICY, now, 12);
    expect(first.offers.map((o) => o.offer)).toEqual([
      "Build a failed 20 min ago. Want me to look?",
    ]);
    const second = decide(failed("a"), first.state, DEFAULT_POLICY, now + 60_000, 12);
    expect(second.offers).toEqual([]);
  });

  it("holds everything in quiet hours and says why", () => {
    const r = decide(failed("a"), EMPTY_INITIATIVE, DEFAULT_POLICY, now, 23);
    expect(r.offers).toEqual([]);
    expect(r.state.declined[0]?.why).toBe("quiet hours");
  });

  it("keeps to the hourly budget, strongest first", () => {
    const many = ["a", "b", "c", "d"].flatMap((id) => failed(id));
    const r = decide(many, EMPTY_INITIATIVE, { ...DEFAULT_POLICY, maxPerHour: 2 }, now, 12);
    expect(r.offers).toHaveLength(2);
    expect(r.state.declined.filter((d) => d.why === "hourly budget")).toHaveLength(2);
    const later = decide(
      many,
      r.state,
      { ...DEFAULT_POLICY, maxPerHour: 2 },
      now + 30 * 60_000,
      12,
    );
    expect(later.offers.map((o) => o.id)).not.toContain(r.offers[0]?.id);
  });

  it("snoozes on Later and silences a topic on Never until he allows it", () => {
    const t = failed("a")[0]!;
    const snoozed = answerOffer(EMPTY_INITIATIVE, t, "later", now);
    expect(
      decide([t], snoozed, { ...DEFAULT_POLICY, cooldownMs: 0 }, now + 3_600_000, 12).offers,
    ).toEqual([]);
    expect(
      decide([t], snoozed, { ...DEFAULT_POLICY, cooldownMs: 0 }, now + 3 * 3_600_000, 12).offers,
    ).toHaveLength(1);
    const never = answerOffer(EMPTY_INITIATIVE, t, "never", now);
    expect(decide([t], never, DEFAULT_POLICY, now, 12).offers).toEqual([]);
    expect(decide([t], allowTopic(never, t.topic), DEFAULT_POLICY, now, 12).offers).toHaveLength(1);
  });

  it("keeps a low-importance finish below the bar", () => {
    const t = triggersFromFindings([
      { workSessionId: "z", title: "Z", kind: "unseen", minutes: 90 },
    ] as unknown as ReadonlyArray<WatchFinding>);
    expect(
      decide(t, EMPTY_INITIATIVE, { ...DEFAULT_POLICY, minScore: 60 }, now, 12).offers,
    ).toEqual([]);
  });

  it("offers a failed build on a repository, only the newest run per workflow", () => {
    const iso = (m: number) => DateTime.formatIso(DateTime.makeUnsafe(now - m * 60_000));
    const t = triggersFromCi(
      [
        {
          repo: "o/r",
          runId: 1,
          name: "verify",
          branch: "main",
          conclusion: "failure",
          createdAt: iso(60),
        },
        {
          repo: "o/r",
          runId: 2,
          name: "verify",
          branch: "main",
          conclusion: "success",
          createdAt: iso(10),
        },
        {
          repo: "o/r",
          runId: 3,
          name: "lint",
          branch: "main",
          conclusion: "failure",
          createdAt: iso(20),
        },
      ],
      now,
    );
    expect(t.map((x) => x.id)).toEqual(["ci:o/r:3"]);
    expect(t[0]?.offer).toBe("The lint build for o/r (main) failed 20 min ago. Want me to look?");
  });

  it("stops and resumes by the words he used", () => {
    const r = decide(failed("a"), EMPTY_INITIATIVE, DEFAULT_POLICY, now, 12);
    const muted = stopAbout(r.state, "build a");
    expect(muted.stopped).toEqual(["Build a"]);
    expect(
      decide(failed("a"), muted.state, { ...DEFAULT_POLICY, cooldownMs: 0 }, now + 1, 12).offers,
    ).toEqual([]);
    expect(resumeAbout(muted.state, "build").state.never).toEqual([]);
    expect(stopAbout(r.state, "nothing like this").stopped).toEqual([]);
  });
});
