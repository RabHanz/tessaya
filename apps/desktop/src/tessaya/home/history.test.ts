// @effect-diagnostics globalDate:off
import { describe, expect, it, vi } from "vite-plus/test";

import { openState } from "./pageStates.ts";

const DAY = 864e5;
const NOW = Date.UTC(2026, 10, 2, 12);
/** n turns spread over `days` days, newest first. */
const turns = (n: number, days: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `t${i}`,
    at: new Date(NOW - Math.floor((i * days * DAY) / n) - 1000).toISOString(),
    kind: "dictation",
    app: "notepad.exe",
    raw: `turn ${i}`,
    cleaned: `Turn ${i}`,
    status: "ok",
    menu: [],
  }));

const open = async (rows: unknown[]) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  const page = await openState("empty");
  page.exec(`window.__BATON_HISTORY__ = ${JSON.stringify(rows)}`);
  return page;
};
/** The page asks for its rows when History opens and draws them a tick later. */
const loaded = async (page: Awaited<ReturnType<typeof open>>) => {
  page.show("history");
  await Promise.resolve();
  await Promise.resolve();
};
const count = (page: Awaited<ReturnType<typeof open>>, cls: string) =>
  page.elements().filter((e) => e.className.split(/\s+/).includes(cls)).length;

describe("History is grouped by day and never renders hundreds of rows", () => {
  it("500 turns over 10 days keep the DOM under 60 rows, with Today open and earlier days folded", async () => {
    const page = await open(turns(500, 10));
    await loaded(page);
    expect(page.errors).toEqual([]);
    expect(count(page, "hrow")).toBeLessThanOrEqual(20);
    expect(count(page, "dayhead")).toBeGreaterThan(5);
    // Every day open at once is still 20 a day at most.
    page.exec("hexp = {}; for (const d of ['Today','Yesterday']) hexp[d] = true; render()");
    expect(count(page, "hrow")).toBeLessThanOrEqual(60);
  });

  it("filters to Today or the last 7 days", async () => {
    const page = await open(turns(100, 14));
    await loaded(page);
    page.exec("hrange = 'today'; render()");
    expect(count(page, "dayhead")).toBe(1);
    page.exec("hrange = 'week'; render()");
    expect(count(page, "dayhead")).toBeLessThanOrEqual(8);
  });
});
