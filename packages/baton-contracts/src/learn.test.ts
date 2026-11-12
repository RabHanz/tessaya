import { describe, expect, it } from "vite-plus/test";

import { EMPTY_PROGRESS, LEARN_ITEMS, pickTip, type LearnProgress } from "./learn.ts";
import { TESSAYA_PLACES } from "./places.ts";

const DAY = 24 * 3600 * 1000;
const days = (n: number) =>
  Array.from({ length: n }, (_, i) => `2026-11-${String(i + 1).padStart(2, "0")}`);
const at = (progress: Partial<LearnProgress>, page: string, area: string | null, now = 100 * DAY) =>
  pickTip(LEARN_ITEMS, { ...EMPTY_PROGRESS, ...progress }, { page, area }, now)?.id ?? null;

describe("pickTip", () => {
  it("shows a tip about the page first, then one about the area, and none elsewhere", () => {
    expect(at({ days: days(5) }, "snippets", "talk")).toBe("snippets");
    expect(at({ days: days(5) }, "dictation", "talk")).toBe("wake");
    expect(at({ days: days(1) }, "nowhere", null)).toBeNull();
  });

  it("waits for its day of use, unless he asked to see everything", () => {
    expect(at({ days: days(1) }, "hardware", "devices")).toBeNull();
    expect(at({ days: days(5) }, "hardware", "devices")).toBe("hardware");
    expect(at({ days: days(1), mode: "all" }, "hardware", "devices")).toBe("hardware");
  });

  it("never repeats one he used, dismissed or saw twice, and shows at most one a day", () => {
    const base = { days: days(9) };
    expect(at({ ...base, used: ["snippets"] }, "snippets", "talk")).not.toBe("snippets");
    expect(at({ ...base, dismissed: ["snippets"] }, "snippets", "talk")).not.toBe("snippets");
    expect(at({ ...base, seen: { snippets: 2 } }, "snippets", "talk")).not.toBe("snippets");
    expect(at({ ...base, lastTipAt: 100 * DAY - 3600 * 1000 }, "snippets", "talk")).toBeNull();
    expect(
      at({ ...base, lastTipAt: 100 * DAY - 3600 * 1000, mode: "all" }, "snippets", "talk"),
    ).toBe("snippets");
    expect(at({ ...base, mode: "off" }, "snippets", "talk")).toBeNull();
  });

  it("teaches only places that exist, and runs from its own source", () => {
    const places = new Set<string>([
      ...TESSAYA_PLACES.map((p) => p.id),
      "help",
      "snippets",
      "style",
      "transforms",
      "scratchpad",
      "approvals",
      "memory",
      "vault",
      "cloud",
      "insights",
    ]);
    for (const item of LEARN_ITEMS) expect(places.has(item.place), item.id).toBe(true);
    const copy = new Function(`return (${pickTip.toString()})`)() as typeof pickTip;
    expect(
      copy(LEARN_ITEMS, { ...EMPTY_PROGRESS, days: days(5) }, { page: "snippets", area: "talk" }, 0)
        ?.id,
    ).toBe("snippets");
  });
});
