import { describe, expect, it } from "vite-plus/test";

import {
  WHATS_NEW_KEEP_MS,
  keptNews,
  newsLine,
  whatsNewLine,
  type WhatsNewEntry,
} from "./whatsNew.ts";

const DAY = 86_400_000;
const NOW = 100 * DAY;
const entry = (
  daysAgo: number,
  items: ReadonlyArray<string>,
  version = `v${daysAgo}`,
): WhatsNewEntry => ({
  at: NOW - daysAgo * DAY,
  surface: "server",
  version,
  items,
});

describe("what's new in her", () => {
  it("keeps two weeks, newest first, one copy of a release", () => {
    const kept = keptNews(
      [
        entry(3, ["I hear you without my name"]),
        entry(1, ["My voice carries how I feel"]),
        entry(20, ["old"]),
        entry(1, ["dup"], "v1"),
      ],
      NOW,
    );
    expect(kept.map((e) => e.items[0])).toEqual([
      "My voice carries how I feel",
      "I hear you without my name",
    ]);
    expect(keptNews([entry(0, ["x"])], NOW + WHATS_NEW_KEEP_MS)).toEqual([]);
  });

  it("says the top few and offers the rest", () => {
    const line = whatsNewLine([entry(1, ["a", "b", "c", "d", "e", "f", "g"])], NOW);
    expect(line).toContain("a; b; c; d; e");
    expect(line).toContain("offer the 2 more");
    expect(whatsNewLine([], NOW)).toBe("");
  });

  it("brings the newest up once after a release, then not again", () => {
    const news = [entry(1, ["My voice carries how I feel"])];
    expect(newsLine(news, 0, NOW)).toContain("My voice carries how I feel");
    expect(newsLine(news, NOW - DAY, NOW)).toBe("");
  });
});
