import { describe, expect, it } from "vite-plus/test";

import { btKindOf, knownFrom, mergeKnown, resolveBluetooth, type BtKnown } from "./btNames.ts";

const MINISO: BtKnown = { mac: "E8:07:BF:35:26:5C", name: "MINISO-V5", lastAt: 100 };
const TAO: BtKnown = { mac: "B0:2A:43:4C:E1:77", name: "TaoTronics SoundLiberty", lastAt: 50 };
const SONY: BtKnown = { mac: "14:C6:00:00:00:01", name: "WH-1000XM4", lastAt: null };
const JBL: BtKnown = { mac: "AA:BB:CC:DD:EE:01", name: "JBL Flip 5", lastAt: 300 };

describe("resolveBluetooth", () => {
  it.each([
    ["the Miniso", [MINISO, TAO, SONY], MINISO],
    ["the minisio", [MINISO, TAO, SONY], MINISO],
    ["my headphones", [MINISO, TAO, SONY], SONY],
    ["my speakers", [MINISO, SONY], MINISO],
    // Two speakers: the one he used last.
    ["the speaker", [MINISO, JBL, SONY], JBL],
    // A name no device has, with a kind word: the kind decides when there is one of it.
    ["the office speaker", [MINISO, SONY], MINISO],
    ["e8:07:bf:35:26:5c", [MINISO], MINISO],
  ])("%s", (query, known, expected) => {
    expect(resolveBluetooth(query, known)).toEqual({ kind: "one", device: expected });
  });

  it("asks when two match equally, and says when nothing does", () => {
    const twin = { ...MINISO, mac: "E8:07:BF:35:26:5D", name: "MINISO-V5", lastAt: 100 };
    expect(resolveBluetooth("the miniso", [MINISO, twin]).kind).toBe("several");
    expect(
      resolveBluetooth(
        "the office speaker",
        [MINISO, JBL].map((k) => ({ ...k, lastAt: null })),
      ).kind,
    ).toBe("several");
    expect(resolveBluetooth("the kitchen radio", [MINISO, SONY])).toEqual({ kind: "none" });
  });

  it("merges sources by address, keeping a name and the latest use", () => {
    const merged = mergeKnown(
      [{ ...MINISO, name: "" }],
      [{ ...MINISO, lastAt: null }],
      knownFrom([{ mac: "bad" }]),
    );
    expect(merged).toEqual([MINISO]);
    expect(btKindOf("JBL Flip 5")).toBe("speaker");
  });
});
