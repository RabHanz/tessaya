import { describe, expect, it } from "vite-plus/test";

import { fromUpcoming, islandItems, systemIslandItems, type IslandFeed } from "./island.ts";

const now = new Date(2026, 10, 21, 9, 41).getTime();
const feed = (extra: Partial<IslandFeed>): IslandFeed => ({
  her: "idle",
  jobs: { needYou: 0, working: 0, first: null },
  timers: [],
  upcoming: [],
  ...extra,
});

describe("the island", () => {
  it("puts her state first, then a job that needs him, a timer, and what's next within the hour", () => {
    const items = islandItems(
      feed({
        her: "listening",
        jobs: { needYou: 1, working: 2, first: { title: "Parity sync", href: "/threads/e/t" } },
        timers: [{ id: "pasta", title: "Pasta", endsAt: now + 252_000 }],
        upcoming: [
          { id: "late", title: "Dinner", at: now + 5 * 3_600_000 },
          { id: "acct", title: "Accountant", at: now + 40 * 60_000 },
        ],
      }),
      now,
    );
    expect(items.map((i) => i.label)).toEqual([
      "listening",
      "Parity sync needs you",
      "Pasta",
      "Accountant 10:21",
    ]);
    expect(items[1]).toMatchObject({ detail: "2 more working", href: "/threads/e/t" });
    expect(systemIslandItems(items).map((i) => i.kind)).toEqual(["needsYou", "timer", "upcoming"]);
  });

  it("says jobs are working only when none waits on him, and drops a finished timer", () => {
    const items = islandItems(
      feed({
        jobs: { needYou: 0, working: 3, first: null },
        timers: [{ id: "done", title: "Eggs", endsAt: now - 1 }],
      }),
      now,
    );
    expect(items.map((i) => i.label)).toEqual(["3 working"]);
    expect(islandItems(feed({}), now)).toEqual([]);
  });

  it("takes a one-off house timer from Coming up as a timer, and the rest with a time as what's next", () => {
    const item = (id: string, extra: object) => ({
      id,
      source: "house",
      title: id,
      line: "",
      at: now + 60_000,
      repeats: null,
      paused: false,
      ...extra,
    });
    const got = fromUpcoming([
      item("Pasta", { line: "timer in the house" }),
      item("Lights", { repeats: "daily" }),
      item("Waits", { at: null }),
      item("Paused timer", { paused: true }),
    ]);
    expect(got.timers.map((t) => t.title)).toEqual(["Pasta"]);
    expect(got.upcoming.map((t) => t.title)).toEqual(["Lights"]);
  });
});
