// @effect-diagnostics globalDate:off
import * as NodeVM from "node:vm";

import { describe, expect, it } from "vite-plus/test";

import { APP_SCRIPT } from "./appScript.ts";

describe("APP_SCRIPT", () => {
  // The page script lives in a template literal, so a stray escape such as /\+/ turns into /+/ and
  // the whole window fails to parse at runtime, where no type check can see it.
  it("parses as a script", () => {
    expect(() => new NodeVM.Script(APP_SCRIPT)).not.toThrow();
    // Comment lines are cut from what ships; a multi-line template literal would make that unsafe.
    expect(APP_SCRIPT).not.toContain("`");
  });
  // The Home sentence and the Your voice row are built by these two functions from the enabled, shipped words only.
  it("names only the words it is given on Home", () => {
    const page = NodeVM.runInNewContext(
      `${/function sayWords[\s\S]*?\nfunction wakeLine[^\n]*/.exec(APP_SCRIPT)![0]}; ({ sayWords, wakeLine })`,
    ) as { sayWords: (w: string[]) => string; wakeLine: (w: string[]) => string };
    expect(page.sayWords(["Sebastian", "Alfred"])).toBe("Say Sebastian or Alfred to talk.");
    expect(page.wakeLine(["Sebastian", "Alfred"])).toBe("Sebastian, Alfred");
    expect(page.wakeLine([])).toBe("Off");
  });
});

describe("command palette", () => {
  const page = NodeVM.runInNewContext(
    `${/function paletteRank[\s\S]*?\n}\n/.exec(APP_SCRIPT)![0]}; ({ paletteRank })`,
  ) as { paletteRank: (items: unknown[], q: string) => Array<{ label: string }> };
  const items = [
    { kind: "Page", label: "Trust", hint: "Open the Trust page" },
    { kind: "Command", label: "Mute the microphone", hint: "" },
    { kind: "Setting", label: "Hold to dictate", hint: "Trust me" },
  ];
  it("matches every word, label first, and shows a few when the box is empty", () => {
    expect(page.paletteRank(items, "").length).toBe(3);
    expect(page.paletteRank(items, "trust").map((i) => i.label)).toEqual([
      "Trust",
      "Hold to dictate",
    ]);
    expect(page.paletteRank(items, "mute mic").map((i) => i.label)).toEqual([
      "Mute the microphone",
    ]);
    expect(page.paletteRank(items, "zzz")).toEqual([]);
  });
});

describe("the greeting", () => {
  type Ctx = {
    now: Date;
    waiting: number;
    daysAway: number;
    firstToday: boolean;
    lateNights: number;
  };
  type Saved = { last: string | null; recent: string[]; nights: string[] };
  const page = NodeVM.runInNewContext(
    `${/const STR = .*\nconst L = .*\n/.exec(APP_SCRIPT)![0]}${/const NIGHT_MS[\s\S]*?\n(?=let greet = null)/.exec(APP_SCRIPT)![0]}; ({ greetContext, greetLine })`,
  ) as {
    greetContext: (now: Date, saved: Saved, waiting: number) => { ctx: Ctx; nights: string[] };
    greetLine: (c: Ctx, recent: string[], rand: () => number) => { key: string; text: string };
  };
  const first = () => 0;
  const at = (iso: string) => new Date(iso);
  const fresh: Saved = { last: null, recent: [], nights: [] };
  const line = (iso: string, saved: Saved = fresh, waiting = 0, recent: string[] = [], r = 0) =>
    page.greetLine(page.greetContext(at(iso), saved, waiting).ctx, recent, () => r);

  it("follows the time of day on an ordinary open (Thursday)", () => {
    const seen = { last: "2026-11-05T07:00:00", recent: [], nights: [] };
    expect(line("2026-11-05T02:00:00", seen).key).toMatch(/^greet\.small\./);
    expect(line("2026-11-05T06:30:00", seen).key).toMatch(/^greet\.early\./);
    expect(line("2026-11-05T09:00:00", seen).key).toMatch(/^greet\.morning\./);
    expect(line("2026-11-05T14:00:00", seen).key).toMatch(/^greet\.afternoon\./);
    expect(line("2026-11-05T19:00:00", seen).key).toMatch(/^greet\.evening\./);
    expect(line("2026-11-05T23:30:00", seen).key).toMatch(/^greet\.small\./);
  });

  it("puts sessions waiting first, then a long absence, then the day of the week on its first open", () => {
    expect(line("2026-11-09T09:00:00", fresh, 3).text).toBe("You're in demand.");
    // The banner says how many; the greeting never repeats the count.
    for (const n of [1, 3])
      expect(line("2026-11-09T09:00:00", fresh, n, [], 0.99).text).not.toMatch(/\d/);
    const away = { last: "2026-11-01T18:00:00", recent: [], nights: [] };
    expect(line("2026-11-05T09:00:00", away).key).toMatch(/^greet\.away\./);
    expect(
      page.greetLine(page.greetContext(at("2026-11-05T09:00:00"), away, 0).ctx, [], () => 0.5).text,
    ).toBe("3 days. Did you miss me?");
    expect(line("2026-11-09T09:00:00").key).toMatch(/^greet\.monday\./);
    expect(line("2026-11-06T09:00:00").key).toMatch(/^greet\.friday\./);
    expect(line("2026-11-07T09:00:00").key).toMatch(/^greet\.weekend\./);
    const earlierToday = { last: "2026-11-09T08:00:00", recent: [], nights: [] };
    expect(line("2026-11-09T09:00:00", earlierToday).key).toMatch(/^greet\.morning\./);
  });

  it("counts late nights in a row and only remarks from the third", () => {
    let saved: Saved = { last: "2026-11-02T10:00:00", recent: [], nights: [] };
    const keys: string[] = [];
    for (const iso of ["2026-11-03T01:00:00", "2026-11-03T23:40:00", "2026-11-05T00:30:00"]) {
      const g = page.greetContext(at(iso), saved, 0);
      keys.push(page.greetLine(g.ctx, [], first).text);
      saved = { last: iso, recent: [], nights: g.nights };
    }
    expect(keys).toEqual(["Still up, then.", "Still up, then.", "Night 3 running. Noted."]);
    // A night off breaks the run.
    const gap = page.greetContext(at("2026-11-07T01:00:00"), saved, 0);
    expect(gap.ctx.lateNights).toBe(1);
  });

  it("never repeats one of the last four, and falls back to time of day when a situation's lines are spent", () => {
    const recent: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      const pick = line(
        "2026-11-05T09:00:00",
        { last: "2026-11-05T08:00:00", recent: [], nights: [] },
        0,
        recent.slice(-4),
      );
      expect(recent.slice(-4)).not.toContain(pick.key);
      recent.push(pick.key);
    }
    const spent = ["greet.waiting.1", "greet.waiting.2", "greet.waiting.3", "greet.waiting.4"];
    expect(
      line("2026-11-05T09:00:00", { last: "2026-11-05T08:00:00", recent: [], nights: [] }, 1, spent)
        .key,
    ).toMatch(/^greet\.morning\./);
  });
});
