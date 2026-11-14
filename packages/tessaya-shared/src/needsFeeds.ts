/**
 * Other places that know what needs him, read through a file they write (a status export, a cron
 * job's output, a bridge to a system Tessaya has no direct interface to). Read-only: a feed is data
 * about what needs him, never an instruction. Pure: the shape, the staleness, and which expected
 * sources have no feed.
 */
import type { NeedItem } from "./needsMe.ts";

export interface FeedRead {
  readonly source: string;
  readonly items: ReadonlyArray<NeedItem>;
  /** Set when the feed could not be used, in words for him. */
  readonly problem: string | null;
}

export const FEED_STALE_MS = 24 * 3_600_000;
export const FEED_ITEMS_MAX = 50;

const str = (v: unknown, max: number): string | null =>
  typeof v === "string" && v.trim() !== "" ? v.trim().slice(0, max) : null;

/**
 * `{ "source": "Cockpit approvals", "asOf": "2026-11-02T10:00:00Z", "items": [{ "id", "title", "why", "weight", "due" }] }`.
 * A feed without an asOf, or older than a day, is stale: its items are not trusted as current.
 */
export const parseFeed = (text: string, now: number, fallbackName: string): FeedRead => {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return {
      source: fallbackName,
      items: [],
      problem: `${fallbackName}: the feed is not valid JSON`,
    };
  }
  const o = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;
  const source = str(o["source"], 60) ?? fallbackName;
  if (!Array.isArray(o["items"]))
    return { source, items: [], problem: `${source}: the feed has no items list` };
  const asOf = typeof o["asOf"] === "string" ? Date.parse(o["asOf"]) : NaN;
  if (Number.isNaN(asOf))
    return { source, items: [], problem: `${source}: the feed does not say when it was written` };
  if (now - asOf > FEED_STALE_MS) {
    return {
      source,
      items: [],
      problem: `${source}: the feed is ${Math.round((now - asOf) / 3_600_000)} hours old, so it is not trusted`,
    };
  }
  const items: NeedItem[] = [];
  for (const raw of (o["items"] as unknown[]).slice(0, FEED_ITEMS_MAX)) {
    const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    const title = str(r["title"], 160);
    const id = str(r["id"], 80) ?? title;
    if (title === null || id === null) continue;
    const weight = typeof r["weight"] === "number" ? Math.max(0, Math.min(100, r["weight"])) : 60;
    const due = typeof r["due"] === "string" ? Date.parse(r["due"]) : NaN;
    items.push({
      id: `feed:${source}:${id}`,
      source: "ledger",
      title,
      why: `${str(r["why"], 200) ?? "waiting for you"} (${source})`,
      weight,
      ...(Number.isNaN(due) ? {} : { dueAt: due }),
    });
  }
  return { source, items, problem: null };
};

/** Expected sources no readable feed provides, named so a short answer is not taken for a clear one. */
export const notConnected = (
  expected: ReadonlyArray<string>,
  reads: ReadonlyArray<FeedRead>,
): ReadonlyArray<string> =>
  expected.filter(
    (name) =>
      !reads.some((r) => r.problem === null && r.source.toLowerCase() === name.toLowerCase()),
  );
