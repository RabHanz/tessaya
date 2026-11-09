import { describe, expect, it } from "vite-plus/test";

import { watchField } from "./fieldWatch.ts";

/** The field read by read, then what the watch did and which settled texts it tried to learn from. */
const watch = async (reads: ReadonlyArray<string | null>, focus: ReadonlyArray<boolean> = []) => {
  let at = 0;
  const tried: string[] = [];
  const outcome = await watchField({
    reads: reads.length,
    wait: async () => true,
    stillThere: async () => focus[at] ?? true,
    read: async () => reads[at++] ?? null,
    learn: (before) => (tried.push(before), before.includes("Tessaya")),
  });
  return { outcome, tried, readsTaken: at };
};

describe("watching the field after a paste", () => {
  it("learns the moment a fix settles, never from a word half typed, and stops there", async () => {
    expect(
      await watch(["Hi Tisia", "Hi Tisia", "Hi Tes", "Hi Tessaya", "Hi Tessaya", "Hi Tessaya!"]),
    ).toEqual({ outcome: "learned", tried: ["Hi Tisia", "Hi Tessaya"], readsTaken: 5 });
  });

  it("stops when focus leaves the window or the field cannot be read, learning nothing", async () => {
    expect(await watch(["Hi Tisia", "Hi Tessaya", "Hi Tessaya"], [true, true, false])).toEqual({
      outcome: "left",
      tried: [],
      readsTaken: 2,
    });
    expect(await watch(["Hi Tisia", null, "Hi Tessaya"])).toEqual({
      outcome: "unreadable",
      tried: [],
      readsTaken: 2,
    });
  });
});
