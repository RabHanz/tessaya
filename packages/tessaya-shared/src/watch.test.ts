import { WorkSessionId, type BatonFleetEntry } from "@t3tools/tessaya-contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  describeWatch,
  findingRecord,
  findingsFromRecord,
  watchRecordStart,
  watchRecordStep,
  outcomeRecord,
  outcomesFromRecord,
  watchFleet,
  watchLiveSessions,
} from "./watch.ts";

const NOW = Date.parse("2026-11-02T12:00:00.000Z");
const ago = (min: number) => DateTime.formatIso(DateTime.makeUnsafe(NOW - min * 60_000));
const entry = (id: string, state: string, minutes: number, over: object = {}) =>
  ({
    workSessionId: id,
    title: `Work ${id}`,
    lifecycle: "active",
    state,
    updatedAt: ago(minutes),
    threads: [],
    synopsis: null,
    ...over,
  }) as unknown as BatonFleetEntry;

describe("watching the fleet", () => {
  it("flags what state says is wrong or left alone, worst first, and nothing else", () => {
    const found = watchFleet(
      [
        entry("ok", "working", 5),
        entry("slow", "working", 50),
        entry("ask", "needs_input", 45),
        entry("freshAsk", "needs_input", 5),
        entry("bad", "failed", 2, {
          synopsis: { currentAction: "ran the tests", recentFindings: [] },
        }),
        entry("seen", "done_unseen", 300),
        entry("fresh", "done_unseen", 10),
        entry("settled", "failed", 90, { lifecycle: "settled" }),
        entry("idle", "idle", 9999),
      ],
      NOW,
    );
    expect(found.map((f) => `${f.workSessionId}:${f.kind}`)).toEqual([
      "bad:failed",
      "slow:stalled",
      "ask:unanswered",
      "seen:unseen",
    ]);
    expect(found[0]?.lastDid).toBe("ran the tests");
  });
  it("counts a thread's own activity, so a busy thread is not stalled", () => {
    const e = entry("busy", "working", 90, { threads: [{ lastActivityAt: ago(3) }] });
    expect(watchFleet([e], NOW)).toEqual([]);
  });
  it("says so when nothing is wrong", () => {
    expect(describeWatch([])).toBe("Nothing is being left alone.");
    expect(describeWatch(watchFleet([entry("bad", "failed", 130)], NOW))).toBe(
      "Work bad failed (2 h) [id: bad]",
    );
  });
});

describe("watching his terminal sessions", () => {
  const live = (id: string, status: string, minutes: number) => ({
    sessionId: id,
    name: `Term ${id}`,
    cwd: "/home/user/app",
    status,
    updatedAt: ago(minutes),
  });
  it("names one waiting on him too long, and what the watchdog did about one that died", () => {
    const found = watchLiveSessions(
      [live("asks", "waiting", 45), live("fresh", "waiting", 5), live("busy", "busy", 90)],
      [
        { sessionId: "back", title: "Back", resumed: true, at: NOW - 2 * 60_000 },
        {
          sessionId: "capped",
          title: "Capped",
          resumed: false,
          why: "already resumed three times this hour",
          at: NOW,
        },
        { sessionId: "old", title: "Old", resumed: true, at: NOW - 13 * 3_600_000 },
      ],
      NOW,
    );
    expect(found.map((f) => `${f.workSessionId}:${f.kind}`)).toEqual([
      "capped:failed",
      "asks:unanswered",
      "back:unseen",
    ]);
    expect(found[0]?.lastDid).toContain("three times this hour");
  });
  it("drops a death that was not resumed once the session runs again", () => {
    const outcome = {
      sessionId: "s",
      title: "S",
      resumed: false,
      why: "auto-resume is off here",
      at: NOW,
    };
    expect(watchLiveSessions([live("s", "busy", 1)], [outcome], NOW)).toEqual([]);
  });
  it("reads what the watchdog did back from the Record, so a server restart still reports it", () => {
    const died = { sessionId: "s", title: "Fix login", resumed: false, why: "stopped on purpose" };
    const rows = [
      { ...outcomeRecord(died), id: 2, at: ago(3), actor: "watchdog", project: null, ref: "s" },
      {
        id: 1,
        at: ago(9),
        kind: "job",
        actor: "job",
        project: null,
        ref: "j",
        subject: "J",
        outcome: "done",
        detail: "",
      },
    ];
    const found = watchLiveSessions([], outcomesFromRecord(rows), NOW);
    expect(found).toEqual([
      {
        workSessionId: "s",
        title: "Fix login",
        kind: "failed",
        minutes: 3,
        lastDid: "died mid-turn, not resumed: stopped on purpose",
      },
    ]);
  });
  it("keeps the server watch's failures and stalls in the Record for the brief, though they cleared", () => {
    const row = (kind: "failed" | "stalled" | "unanswered", id: number) => ({
      ...findingRecord({
        workSessionId: WorkSessionId.make(`w${id}`),
        title: `T${id}`,
        kind,
        minutes: 40,
        lastDid: "ran the tests",
      }),
      id,
      at: ago(id),
      project: null,
    });
    expect(findingsFromRecord([row("failed", 1), row("unanswered", 2), row("stalled", 3)])).toEqual(
      [
        { workSessionId: "w1", title: "T1", kind: "failed", minutes: 0, lastDid: "ran the tests" },
        { workSessionId: "w3", title: "T3", kind: "stalled", minutes: 0, lastDid: "ran the tests" },
      ],
    );
  });
  it("writes a finding to the Record once while it stands, at most every 6 h when it flaps, never 'limited', and not again after a restart", () => {
    const HOUR = 3_600_000;
    const finding = (id: string, kind: "failed" | "stalled" | "limited") => ({
      workSessionId: WorkSessionId.make(id),
      title: id,
      kind,
      minutes: 40,
    });
    const ids = (write: ReadonlyArray<{ workSessionId: string }>) =>
      write.map((f) => f.workSessionId);
    let state = watchRecordStart([]);
    const step = (found: ReturnType<typeof finding>[], at: number) => {
      const out = watchRecordStep(found, state, at);
      state = out.next;
      return ids(out.write);
    };
    expect(step([finding("a", "failed"), finding("b", "limited")], NOW)).toEqual(["a"]);
    expect(step([finding("a", "failed")], NOW + 60_000)).toEqual([]);
    // It clears and comes back within 6 h: not written again; after them, it is.
    expect(step([], NOW + 2 * 60_000)).toEqual([]);
    expect(step([finding("a", "failed")], NOW + HOUR)).toEqual([]);
    expect(step([], NOW + HOUR + 60_000)).toEqual([]);
    expect(step([finding("a", "failed")], NOW + 7 * HOUR)).toEqual(["a"]);
    // A restart reads the newest row per session, however old: what stood is not written again.
    const row = (id: number, ref: string, outcome: string, at: number) => ({
      id,
      at: DateTime.formatIso(DateTime.makeUnsafe(at)),
      kind: "watch",
      actor: "watch",
      project: null,
      ref,
      subject: ref,
      outcome,
      detail: "",
    });
    state = watchRecordStart([
      row(2, "c", "stalled", NOW - 30 * HOUR),
      row(1, "c", "failed", NOW - 40 * HOUR),
    ]);
    expect(step([finding("c", "stalled")], NOW)).toEqual([]);
    expect(step([finding("c", "stalled"), finding("c", "failed")], NOW)).toEqual(["c"]);
  });
});
