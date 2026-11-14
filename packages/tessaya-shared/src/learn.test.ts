import { describe, expect, it } from "vite-plus/test";

import {
  applyLearnOp,
  EMPTY_PROGRESS,
  LEARN_ITEMS,
  pickTip,
  readLearnProgress,
  type LearnProgress,
} from "./learn.ts";
import { TESSAYA_PLACES } from "@t3tools/tessaya-contracts";

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

describe("applyLearnOp", () => {
  it("records use, sightings, dismissals, mode, days and what's new, and ignores nonsense", () => {
    let p = EMPTY_PROGRESS;
    p = applyLearnOp(p, { op: "use", place: "snippets" });
    p = applyLearnOp(p, { op: "use", place: "snippets" });
    p = applyLearnOp(p, { op: "seen", id: "wake", at: 5 });
    p = applyLearnOp(p, { op: "seen", id: "wake", at: 9 });
    p = applyLearnOp(p, { op: "dismiss", id: "vault" });
    p = applyLearnOp(p, { op: "mode", mode: "all" });
    p = applyLearnOp(p, { op: "day", day: "2026-11-12" });
    p = applyLearnOp(p, { op: "whatsNew", since: "2026-11-12" });
    expect(p).toEqual({
      used: ["snippets"],
      seen: { wake: 2 },
      dismissed: ["vault"],
      days: ["2026-11-12"],
      lastTipAt: 9,
      mode: "all",
      whatsNewSeen: "2026-11-12",
    });
    expect(applyLearnOp(p, { op: "mode", mode: "loud" } as never)).toBe(p);
    expect(applyLearnOp(p, { op: "day", day: "today" })).toBe(p);
    expect(applyLearnOp(p, { op: "reset" })).toMatchObject({
      used: [],
      seen: {},
      dismissed: [],
      mode: "all",
    });
  });

  it("reads a stored progress defensively, and runs from its own source", () => {
    expect(readLearnProgress({ used: ["a", 3], seen: { x: "no", y: 1 }, mode: "loud" })).toEqual({
      ...EMPTY_PROGRESS,
      used: ["a"],
      seen: { y: 1 },
    });
    expect(readLearnProgress(null)).toEqual(EMPTY_PROGRESS);
    const copy = new Function(`return (${applyLearnOp.toString()})`)() as typeof applyLearnOp;
    expect(copy(EMPTY_PROGRESS, { op: "use", place: "vault" }).used).toEqual(["vault"]);
  });
});
