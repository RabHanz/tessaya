import { describe, expect, it } from "vite-plus/test";

import type { MemoryItem } from "./memory.ts";
import { comingUp, needsFromMemory } from "./memoryDates.ts";

const item = (text: string, over: Partial<MemoryItem> = {}): MemoryItem => ({
  id: text,
  kind: "fact",
  text,
  source: "user",
  sourceRef: null,
  scope: "global",
  scopeRef: null,
  confidence: 1,
  pinned: false,
  createdAt: "2026-11-10T09:00:00.000Z",
  updatedAt: "2026-11-10T09:00:00.000Z",
  lastUsedAt: null,
  expiresAt: null,
  supersededBy: null,
  proposed: false,
  ...over,
});
// Friday 13 November 2026, 10:00 in Karachi.
const now = Date.parse("2026-11-13T05:00:00.000Z");
const zone = "Asia/Karachi";

describe("what his memories say is coming up", () => {
  it("finds a birthday each year, a dated plan, a weekday said lately and a time-bound end, soonest first", () => {
    const got = comingUp(
      [
        item("Maya's birthday is the sixteenth of November"),
        item("Mum's birthday is 2 March"),
        item("The boiler service is booked for 18 November 2026"),
        // Said on Tuesday 10 November: the coming Saturday.
        item("The dentist is on Saturday"),
        item("I go to the gym every Saturday"),
        item("Keep the guest room free", { expiresAt: "2026-11-15T12:00:00.000Z" }),
        item("Old plan for 14 November", { supersededBy: "x" }),
      ],
      now,
      zone,
    );
    expect(got.map((c) => [c.item.text, c.inDays, c.kind])).toEqual([
      ["The dentist is on Saturday", 1, "once"],
      ["Keep the guest room free", 2, "until"],
      ["Maya's birthday is the sixteenth of November", 3, "every year"],
      ["The boiler service is booked for 18 November 2026", 5, "once"],
    ]);
  });

  it("wraps a birthday into next year, and forgets a weekday said long ago", () => {
    const late = Date.parse("2026-12-30T05:00:00.000Z");
    expect(comingUp([item("Ali's birthday is January 2")], late, zone)[0]?.inDays).toBe(3);
    expect(comingUp([item("The dentist is on Saturday")], late, zone)).toEqual([]);
  });

  it("becomes 'what needs me' items with a date to rank by", () => {
    const [need] = needsFromMemory(
      [item("Maya's birthday is the sixteenth of November")],
      now,
      zone,
    );
    expect(need).toMatchObject({ source: "memory", why: "it's in 3 days", weight: 40 });
  });
});
