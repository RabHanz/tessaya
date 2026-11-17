import { describe, expect, it } from "vite-plus/test";

import {
  findGaps,
  newEventId,
  publicPointer,
  toEnvelope,
  whyLines,
  type ActionEnvelope,
  type ActionInput,
} from "./provenance.ts";

const bytes = (n: number) => new Uint8Array(n).fill(7);
let seq = 0;
const ev = (input: ActionInput & { at: number }): ActionEnvelope =>
  toEnvelope(input, { id: `e${++seq}`, at: input.at, origin: "server-a", cause: [] });

describe("event ids", () => {
  it("sort by time and are 26 characters", () => {
    const a = newEventId(1_700_000_000_000, bytes);
    const b = newEventId(1_700_000_000_001, bytes);
    expect(a).toHaveLength(26);
    expect(a < b).toBe(true);
  });
});

describe("the envelope", () => {
  it("merges the fiber's cause, caps text and data, and clamps certainty", () => {
    const e = toEnvelope(
      {
        kind: "tool.call",
        actor: { kind: "agent", certainty: 3 },
        cause: ["b", "a"],
        subject: "x".repeat(500),
        data: { blob: "y".repeat(5_000) },
      },
      { id: "id1", at: 1, origin: "server-a", cause: ["a"] },
    );
    expect(e.cause).toEqual(["a", "b"]);
    expect(e.subject.length).toBeLessThanOrEqual(200);
    expect(e.actor.certainty).toBe(1);
    expect(JSON.stringify(e.data).length).toBeLessThan(2_100);
  });

  it("keeps nothing of a private event in its public pointer but the id and links", () => {
    const e = toEnvelope(
      {
        kind: "private.recall",
        actor: { kind: "owner", id: "owner", certainty: 0.9 },
        persona: "Freya",
        subject: "the secret thing",
        data: { words: "the secret thing" },
        cause: ["c1"],
      },
      { id: "p1", at: 5, origin: "server-a", cause: [] },
    );
    const pointer = publicPointer(e);
    expect(pointer).toMatchObject({
      id: "p1",
      kind: "private",
      cause: ["c1"],
      persona: null,
      data: null,
    });
    expect(JSON.stringify(pointer)).not.toContain("secret");
    expect(JSON.stringify(pointer)).not.toContain("Freya");
  });
});

describe("the gap detector", () => {
  it("flags a session opened with no cause and no person behind it, not one he opened", () => {
    const found = findGaps([
      ev({
        kind: "room.session.opened",
        actor: { kind: "device", id: "tumble", certainty: 1 },
        at: 1,
      }),
      ev({ kind: "room.session.opened", actor: { kind: "owner", certainty: 0.95 }, at: 2 }),
    ]);
    expect(found.map((f) => f.rule)).toEqual(["uncaused_state_change"]);
    expect(found[0]!.title).toContain("tumble");
  });

  it("counts a failure only when it repeats three times within an hour", () => {
    const fail = (at: number) =>
      ev({
        kind: "tool.call",
        actor: { kind: "agent", certainty: 1 },
        subject: "home_do",
        outcome: "fail",
        at,
      });
    expect(findGaps([fail(0), fail(10_000)])).toEqual([]);
    expect(findGaps([fail(0), fail(2 * 3_600_000), fail(4 * 3_600_000)])).toEqual([]);
    const found = findGaps([fail(0), fail(1_000), fail(2_000)]);
    expect(found).toMatchObject([{ rule: "repeating_failure", count: 3 }]);
  });

  it("flags a setting he set being overwritten by something else within ten minutes", () => {
    const found = findGaps([
      ev({
        kind: "settings.changed",
        actor: { kind: "owner", certainty: 1 },
        subject: "quietHours",
        at: 0,
      }),
      ev({
        kind: "settings.changed",
        actor: { kind: "rule", id: "sync", certainty: 1 },
        subject: "quietHours",
        at: 60_000,
      }),
    ]);
    expect(found.map((f) => f.rule)).toContain("setting_overwritten");
  });

  it("flags Voice ID holding him when the next turn on that Tessel was surely him", () => {
    const found = findGaps([
      ev({
        kind: "room.voice_id",
        actor: { kind: "guest", certainty: 0.3 },
        outcome: "guest",
        data: { vessel: "t1" },
        at: 0,
      }),
      ev({
        kind: "room.voice_id",
        actor: { kind: "owner", certainty: 0.97 },
        outcome: "owner",
        data: { vessel: "t1" },
        at: 30_000,
      }),
    ]);
    expect(found.map((f) => f.rule)).toEqual(["owner_turn_unverified"]);
  });

  it("flags two turn verdicts on one Tessel a second apart as two loops answering (18 Nov), not two on two Tessels", () => {
    const verdict = (vessel: string, at: number) =>
      ev({
        kind: "room.voice_id",
        actor: { kind: "owner", id: "owner", certainty: 0.95 },
        outcome: "owner",
        data: { vessel },
        at,
      });
    const found = findGaps([verdict("t1", 0), verdict("t1", 900), verdict("t2", 1_000)]);
    expect(found.map((f) => [f.rule, f.key])).toEqual([["double_turn", "double_turn|t1"]]);
    expect(findGaps([verdict("t1", 0), verdict("t1", 20_000)])).toEqual([]);
  });
});

describe("why", () => {
  it("reads a chain newest first and says when the root had no cause", () => {
    const leaf = ev({
      kind: "device.cmd",
      actor: { kind: "persona", id: "Freya", certainty: 1 },
      subject: "eye",
      at: 2,
    });
    const root = ev({
      kind: "room.wake",
      actor: { kind: "device", id: "tumble", certainty: 1 },
      at: 1,
    });
    const lines = whyLines([leaf, root]);
    expect(lines[0]).toBe("Freya did device.cmd: eye");
    expect(lines[1]).toContain("because tumble did room.wake");
    expect(lines[1]).toContain("no recorded cause");
  });
});
