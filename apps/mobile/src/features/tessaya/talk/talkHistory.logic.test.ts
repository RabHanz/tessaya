import { describe, expect, it } from "vite-plus/test";

import { mergeLines, talkRows, vesselLabel, type TalkLine } from "./talkHistory.logic";

const at = (day: number, h: number, m = 0) => new Date(2026, 10, day, h, m).getTime();
const line = (when: number, role: "them" | "her", text: string, vessel = "tumble"): TalkLine => ({
  at: when,
  vessel,
  role,
  text,
  private: false,
});

describe("Talk's history", () => {
  it("names each line's device, this phone included", () => {
    expect(vesselLabel("phone-abc", "phone-abc")).toBe("this phone");
    expect(vesselLabel("desk-voice", "phone-abc")).toBe("Desk voice");
  });

  it("heads each day and keeps a private moment content-free", () => {
    const rows = talkRows(
      [
        line(at(20, 22, 48), "her", "Night."),
        line(at(21, 7, 2), "them", "Morning."),
        { ...line(at(21, 8, 0), "her", "(a private moment)"), private: true },
      ],
      null,
      at(21, 9, 41),
    );
    expect(rows.map((r) => (r.kind === "day" ? r.label : r.text))).toEqual([
      "Yesterday",
      "Night.",
      "Today",
      "Morning.",
      "A private moment",
    ]);
    expect(rows[1]).toMatchObject({ where: "on Tumble · 22:48" });
  });

  it("merges an earlier page without repeating the lines on its edge", () => {
    const a = line(at(21, 7), "them", "Morning.");
    const b = line(at(21, 8), "her", "Hello.");
    expect(mergeLines([a, b], [b, line(at(21, 9), "them", "Bye.")]).map((l) => l.text)).toEqual([
      "Morning.",
      "Hello.",
      "Bye.",
    ]);
  });
});
