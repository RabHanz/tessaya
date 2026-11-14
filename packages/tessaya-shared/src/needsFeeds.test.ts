import { describe, expect, it } from "vite-plus/test";

import { notConnected, parseFeed } from "./needsFeeds.ts";

const now = Date.parse("2026-11-02T12:00:00Z");
const feed = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    source: "Cockpit approvals",
    asOf: "2026-11-02T10:00:00Z",
    items: [
      {
        id: "a1",
        title: "Approve the Stripe offer",
        why: "R3 approval waiting",
        weight: 90,
        due: "2026-11-04T00:00:00Z",
      },
    ],
    ...over,
  });

describe("needs feeds", () => {
  it("reads a fresh feed into needs that name their source", () => {
    const r = parseFeed(feed(), now, "file");
    expect(r.problem).toBeNull();
    expect(r.items).toEqual([
      {
        id: "feed:Cockpit approvals:a1",
        source: "ledger",
        title: "Approve the Stripe offer",
        why: "R3 approval waiting (Cockpit approvals)",
        weight: 90,
        dueAt: Date.parse("2026-11-04T00:00:00Z"),
      },
    ]);
  });
  it("does not trust a stale feed, one with no date, broken JSON or no items, and says so", () => {
    expect(parseFeed(feed({ asOf: "2026-10-30T10:00:00Z" }), now, "f").problem).toContain(
      "hours old",
    );
    expect(parseFeed(feed({ asOf: undefined }), now, "f").problem).toContain("does not say when");
    expect(parseFeed("{nope", now, "peers.json").problem).toBe(
      "peers.json: the feed is not valid JSON",
    );
    expect(
      parseFeed(JSON.stringify({ source: "x", asOf: "2026-11-02T10:00:00Z" }), now, "f").problem,
    ).toContain("no items list");
    expect(
      parseFeed(feed({ items: [{ why: "no title" }, { title: "ok" }] }), now, "f").items,
    ).toHaveLength(1);
  });
  it("names an expected source that has no readable feed", () => {
    const good = parseFeed(feed(), now, "f");
    const bad = parseFeed("{", now, "peers.json");
    expect(notConnected(["Cockpit approvals", "Peers' status"], [good, bad])).toEqual([
      "Peers' status",
    ]);
    expect(notConnected([], [])).toEqual([]);
  });
});
