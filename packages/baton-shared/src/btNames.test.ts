import { describe, expect, it } from "vite-plus/test";

import {
  btKindOf,
  btKindOfCod,
  kindOf,
  knownFrom,
  mergeKnown,
  resolveBluetooth,
  type BtKnown,
} from "./btNames.ts";

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

describe("kinds from the class of device", () => {
  // Major class audio/video (0x04 << 8) with the minor class in bits 2-7.
  const cod = (minor: number) => (0x04 << 8) | (minor << 2);
  it.each([
    [cod(0x06), "headphones"],
    [cod(0x01), "headset"],
    [cod(0x05), "speaker"],
    [cod(0x08), "car"],
    [cod(0x0a), "receiver"],
  ])("%s is %s", (value, kind) => {
    expect(btKindOfCod(value)).toBe(kind);
  });

  it("matches his words to the kind the class says, whatever the name", () => {
    const buds: BtKnown = {
      mac: "11:22:33:44:55:66",
      name: "Galaxy X",
      lastAt: null,
      cod: cod(0x01),
    };
    const car: BtKnown = { mac: "11:22:33:44:55:77", name: "MyCar", lastAt: null, kind: "car" };
    expect(resolveBluetooth("my headphones", [buds, car, MINISO])).toEqual({
      kind: "one",
      device: buds,
    });
    expect(resolveBluetooth("the car", [buds, car, MINISO])).toEqual({ kind: "one", device: car });
    expect(kindOf({ name: "Unknown", cod: 0x1f00 })).toBe("other");
    expect(
      knownFrom([{ mac: "11:22:33:44:55:66", name: "x", cod: 1028, kind: "headset" }]),
    ).toEqual([{ mac: "11:22:33:44:55:66", name: "x", lastAt: null, cod: 1028, kind: "headset" }]);
  });
});
