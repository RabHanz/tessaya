import { describe, expect, it } from "vite-plus/test";

import { pulseLog } from "./pulseLog.ts";

import {
  addToDigest,
  eventFromRecord,
  gateDecision,
  learnFrom,
  NOTHING,
  noticePatterns,
  patternEvents,
  PULSE_CATEGORIES,
  reviewDue,
  nextReviewMs,
  type GateInput,
  type PulseDecision,
  type PulseEvent,
} from "./pulse.ts";

const MIN = 60_000;
const DAY = 86_400_000;
const NOW = 100 * DAY;

const row = (kind: string, outcome: string, subject = "Release app", id = 1) => ({
  id,
  at: "1970-04-11T00:00:00.000Z",
  kind,
  actor: "Tessaya",
  ref: `r${id}`,
  subject,
  outcome,
  detail: "",
});

const ev = (over: Partial<PulseEvent> = {}): PulseEvent => ({
  id: "e1",
  category: "sessions",
  text: "Build session failed",
  at: NOW,
  member: null,
  weight: 80,
  urgent: true,
  told: false,
  ...over,
});

const speak = (over: Partial<PulseDecision> = {}): PulseDecision => ({
  action: "speak",
  category: "sessions",
  member: null,
  text: "The build session failed. Want me to look?",
  why: "it failed",
  about: ["e1"],
  remindInMinutes: null,
  ...over,
});

const gate = (over: Partial<GateInput> = {}) =>
  gateDecision({
    decision: speak(),
    digest: [ev()],
    level: "calm",
    categories: PULSE_CATEGORIES,
    muted: [],
    quiet: false,
    learned: {},
    spokenLastHour: 0,
    ...over,
  });

describe("digest", () => {
  it("maps Record rows, marks what job news already said, and drops her own rows", () => {
    expect(eventFromRecord(row("job", "failed"))).toMatchObject({
      category: "jobs",
      urgent: true,
      told: true,
    });
    expect(eventFromRecord(row("job", "running"))).toBeNull();
    // The server's watch lands under the desktop trigger's id, so the same finding is one event.
    expect(eventFromRecord({ ...row("watch", "unanswered"), ref: "ws1" })).toMatchObject({
      id: "wait:ws1",
      category: "sessions",
      weight: 75,
    });
    expect(eventFromRecord(row("session", "died mid-turn, resumed"))).toBeNull();
    expect(eventFromRecord(row("pulse", "speak"))).toBeNull();
    expect(eventFromRecord(row("brain_spend", "over"))).toBeNull();
    expect(eventFromRecord(row("assistant_turn", "answered"))).toBeNull();
    expect(
      eventFromRecord({ ...row("notice", "session_waiting"), detail: "Waiting 20 min" }),
    ).toMatchObject({ category: "sessions", weight: 75, text: "Waiting 20 min", told: false });
  });

  it("keeps one event per id and the weightiest past the cap", () => {
    const d = addToDigest(
      [ev({ id: "a", weight: 10 }), ev({ id: "b", weight: 90 })],
      [ev({ id: "a", weight: 20, text: "newer" }), ev({ id: "c", weight: 50 })],
      2,
    );
    expect(d.map((e) => e.id).toSorted()).toEqual(["b", "c"]);
    expect(addToDigest([ev({ id: "a" })], [ev({ id: "a", text: "newer" })])[0]?.text).toBe("newer");
  });
});

describe("cadence", () => {
  const base = { level: "calm" as const, ownerHere: true, quiet: false };
  it("reviews now on an urgent event, often while he is here, sparsely when away or in quiet hours", () => {
    expect(nextReviewMs({ ...base, digest: [ev()] })).toBe(0);
    const calm = [ev({ urgent: false, weight: 30 })];
    expect(nextReviewMs({ ...base, digest: calm })).toBe(20 * MIN);
    expect(nextReviewMs({ ...base, ownerHere: false, digest: calm })).toBe(90 * MIN);
    expect(nextReviewMs({ ...base, quiet: true, digest: calm })).toBe(240 * MIN);
    expect(nextReviewMs({ ...base, level: "lively", digest: calm })).toBe(10 * MIN);
    expect(nextReviewMs({ ...base, level: "important", digest: calm })).toBe(40 * MIN);
  });

  it("never reviews an empty digest, a light one, or one holding only things already said", () => {
    const at = { ...base, now: NOW, lastReview: 0 };
    expect(reviewDue({ ...at, digest: [] })).toBe(false);
    expect(reviewDue({ ...at, digest: [ev({ told: true })] })).toBe(false);
    expect(reviewDue({ ...at, digest: [ev({ urgent: false, weight: 20 })] })).toBe(false);
    expect(reviewDue({ ...at, digest: [ev()] })).toBe(true);
    expect(
      reviewDue({ ...at, lastReview: NOW - 5 * MIN, digest: [ev({ urgent: false, weight: 30 })] }),
    ).toBe(false);
  });
});

describe("gate", () => {
  it("passes nothing and a weighty speak through", () => {
    expect(gate({ decision: NOTHING("quiet day") })).toEqual({
      decision: NOTHING("quiet day"),
      held: null,
    });
    expect(gate().held).toBeNull();
  });

  it("holds by category, stop words, things already said, quiet hours, level and budget", () => {
    expect(gate({ categories: ["jobs"] })).toMatchObject({
      held: "that kind is off",
      decision: { action: "nothing" },
    });
    expect(gate({ muted: ["build session"] }).held).toBe("you said stop");
    expect(gate({ digest: [ev({ told: true })] }).held).toBe("already said");
    expect(gate({ quiet: true })).toMatchObject({
      held: "quiet hours",
      decision: { action: "note" },
    });
    expect(gate({ quiet: true, decision: speak({ category: "reminders" }) }).held).toBeNull();
    expect(gate({ level: "important", digest: [ev({ weight: 60 })] }).held).toBe(
      "not important enough to interrupt",
    );
    expect(gate({ spokenLastHour: 2 }).held).toBe("hourly budget");
    expect(gate({ level: "lively", spokenLastHour: 2 }).held).toBeNull();
  });

  it("learns from his reactions: told off twice silences a kind, liked lowers its bar", () => {
    const twice = learnFrom(learnFrom({}, "sessions", "told_off"), "sessions", "told_off");
    expect(gate({ learned: twice }).held).toBe("you have not wanted these");
    const middling = [ev({ weight: 42 })];
    expect(gate({ digest: middling }).held).toBe("not important enough to interrupt");
    expect(gate({ digest: middling, learned: learnFrom({}, "sessions", "liked") }).held).toBeNull();
    expect(learnFrom({ jobs: 0.95 }, "jobs", "liked").jobs).toBe(1);
  });

  it("lets a quiet act (a reminder) through in quiet hours", () => {
    expect(
      gate({ quiet: true, decision: speak({ action: "act", remindInMinutes: 30 }) }).held,
    ).toBeNull();
  });
});

describe("patterns (M-027)", () => {
  const hourOf = (at: number) => Math.floor(at / 3_600_000) % 24;
  it("finds a stall hour that repeats over days, and holds a scattered one", () => {
    const at = (day: number, hour: number) => NOW - day * DAY + hour * 3_600_000 - (NOW % DAY);
    const stalls = [at(1, 16), at(2, 16), at(4, 17), at(6, 16), at(3, 9)];
    const [p] = noticePatterns({ now: NOW, hourOf, stalls, people: [] });
    expect(p?.id).toBe("pattern:stall:16");
    expect(p?.confidence).toBeGreaterThanOrEqual(0.6);
    const scattered = [at(1, 2), at(2, 8), at(3, 14), at(4, 20)];
    expect(noticePatterns({ now: NOW, hourOf, stalls: scattered, people: [] })).toEqual([]);
  });

  it("notices someone often heard who has gone quiet, and surfaces it at most weekly", () => {
    const people = [
      { id: "p1", name: "Sara", lastAt: NOW - 15 * DAY, seen: 6 },
      { id: "p2", name: "Once", lastAt: NOW - 30 * DAY, seen: 1 },
      { id: "p3", name: "Lately", lastAt: NOW - DAY, seen: 9 },
    ];
    const found = noticePatterns({ now: NOW, hourOf, stalls: [], people });
    expect(found.map((p) => p.id)).toEqual(["pattern:quiet:p1"]);
    expect(patternEvents(found, {}, NOW)).toHaveLength(1);
    expect(patternEvents(found, { "pattern:quiet:p1": NOW - 2 * DAY }, NOW)).toEqual([]);
    expect(patternEvents(found, { "pattern:quiet:p1": NOW - 8 * DAY }, NOW)).toHaveLength(1);
  });
});

describe("the decision log (Settings → Pulse)", () => {
  it("lists decisions with their reason and his latest reaction, never the reactions themselves", () => {
    const at = "2026-11-16T09:00:00.000Z";
    const rows = pulseLog([
      {
        id: 5,
        at,
        subject: "x",
        outcome: "told_off",
        detail: "category: sessions · row: 2 · stopped",
      },
      { id: 4, at, subject: "x", outcome: "liked", detail: "category: sessions · row: 2" },
      {
        id: 3,
        at,
        subject: "pulse:1",
        outcome: "ignored",
        detail: "no reaction within 30 minutes",
      },
      {
        id: 2,
        at,
        subject: "Build waits",
        outcome: "speak",
        detail: "it waits · category: sessions",
      },
      {
        id: 1,
        at,
        subject: "nothing worth raising",
        outcome: "nothing",
        detail: "quiet · held: quiet hours · category: jobs",
      },
    ]);
    expect(rows).toEqual([
      {
        id: 2,
        at,
        event: "Build waits",
        decision: "Said it",
        reason: "it waits",
        category: "sessions",
        reaction: "stopped",
      },
      {
        id: 1,
        at,
        event: "nothing worth raising",
        decision: "Stayed quiet",
        reason: "quiet · held: quiet hours",
        category: "jobs",
        reaction: null,
      },
    ]);
  });
});
