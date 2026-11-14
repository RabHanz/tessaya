import { describe, expect, it } from "vite-plus/test";

import {
  addCommitment,
  briefCommitments,
  closeCommitment,
  commitmentsToPush,
  describeCommitments,
  mergeCommitments,
  needsFromCommitments,
  pruneCommitments,
} from "./commitments.ts";

const now = Date.parse("2026-11-02T12:00:00Z");
const HOUR = 3_600_000;

describe("the commitments ledger", () => {
  it("adds, dedupes the same words, and closes", () => {
    let list = addCommitment(
      [],
      { text: " Check back on the  deploy ", due: now + HOUR },
      now,
      "a",
    );
    expect(list[0]?.text).toBe("Check back on the deploy");
    list = addCommitment(list, { text: "check back on the deploy", due: now + 2 * HOUR }, now, "b");
    expect(list).toHaveLength(1);
    expect(list[0]?.due).toBe(now + 2 * HOUR);
    list = closeCommitment(list, "a", "done", now);
    expect(list[0]?.status).toBe("done");
    expect(() => closeCommitment(list, "a", "done", now)).toThrow("No open commitment");
  });

  it("refuses empty, long and undated-nonsense input", () => {
    expect(() => addCommitment([], { text: "  " }, now, "a")).toThrow();
    expect(() => addCommitment([], { text: "x".repeat(301) }, now, "a")).toThrow("too long");
    expect(() => addCommitment([], { text: "x", due: NaN }, now, "a")).toThrow();
  });

  it("raises what is due or near as needs, not what has no date or is far", () => {
    let list = addCommitment([], { text: "due soon", due: now - HOUR }, now, "a");
    list = addCommitment(list, { text: "someday" }, now, "b");
    list = addCommitment(list, { text: "next week", due: now + 7 * 24 * HOUR }, now, "c");
    expect(needsFromCommitments(list, now).map((n) => n.ref)).toEqual(["a"]);
    expect(briefCommitments(list, now)).toBe("Due now: due soon.");
    expect(describeCommitments(list, now)).toContain("overdue by 60 min");
  });

  it("forgets closed ones after a month", () => {
    const list = closeCommitment(addCommitment([], { text: "t" }, now, "a"), "a", "done", now);
    expect(pruneCommitments(list, now + 31 * 24 * HOUR)).toEqual([]);
    expect(pruneCommitments(list, now + HOUR)).toHaveLength(1);
  });

  it("merges two devices: closed beats open, newer beats older, same words once", () => {
    const open = addCommitment([], { text: "check the deploy" }, now, "a");
    const closed = closeCommitment(open, "a", "done", now + HOUR);
    expect(mergeCommitments(open, closed)[0]?.status).toBe("done");
    expect(mergeCommitments(closed, open)[0]?.status).toBe("done");
    const moved = addCommitment(
      open,
      { text: "check the deploy", due: now + 9 * HOUR },
      now + HOUR,
      "z",
    );
    expect(mergeCommitments(open, moved)[0]?.due).toBe(now + 9 * HOUR);
    const other = addCommitment([], { text: "Check the deploy" }, now + 5, "b");
    expect(mergeCommitments(open, other).map((c) => c.id)).toEqual(["a"]);
  });

  it("pushes only what the server does not hold in the same state", () => {
    const list = addCommitment(
      addCommitment([], { text: "one" }, now, "a"),
      { text: "two" },
      now,
      "b",
    );
    expect(commitmentsToPush(list, [list[0]!]).map((c) => c.id)).toEqual(["b"]);
    expect(commitmentsToPush(list, list)).toEqual([]);
  });
});
