import { describe, expect, it } from "vite-plus/test";

import {
  decodeSensePack,
  feltOf,
  fire,
  HUMAN_SENSE,
  mergeSense,
  NO_SENSE,
  type Contact,
} from "./bodySense.ts";

const map = mergeSense([HUMAN_SENSE], false);
const once = (c: Contact, state = NO_SENSE, at = 1000) => fire(map, state, [c], at);
const stroke = (cmPerS: number, region = "arm"): Contact => ({
  region,
  pressure: 0.2,
  cmPerS,
  areaCm2: 4,
});

describe("fire", () => {
  it("a caress fibre answers a slow stroke best, on hairy skin only", () => {
    const caress = (v: number, region?: string) =>
      once(stroke(v, region)).rates[region ?? "arm"]?.["caress"] ?? 0;
    expect(caress(3)).toBeGreaterThan(caress(30));
    expect(caress(3)).toBeGreaterThan(caress(0.3));
    expect(caress(3, "hand")).toBe(0);
  });

  it("the same press fires more where receptors are dense (the hand) than on her back", () => {
    const press = (region: string) =>
      once({ region, pressure: 0.5, cmPerS: 0, areaCm2: 2 }).rates[region]!["pressure"]!;
    expect(press("hand")).toBeGreaterThan(press("back") * 5);
  });

  it("habituates to taps at one site, recovers when left alone, and is sensitised after too much", () => {
    const tap: Contact = { region: "arm", pressure: 0.5, cmPerS: 0, areaCm2: 1 };
    let state = NO_SENSE;
    const felt: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      const step = fire(map, state, [tap], 1000 + i * 500);
      felt.push(step.rates["arm"]!["pressure"]!);
      state = fire(map, step.state, [], 1250 + i * 500).state;
    }
    expect(felt.at(-1)!).toBeLessThan(felt[0]! * 0.8);
    expect(fire(map, state, [tap], 200_000).rates["arm"]!["pressure"]).toBeGreaterThan(
      felt.at(-1)!,
    );
    const hurt = fire(
      map,
      NO_SENSE,
      [{ region: "arm", pressure: 0.95, cmPerS: 0, areaCm2: 1 }],
      1000,
    );
    expect(hurt.rates["arm"]!["noci"]).toBeGreaterThan(0);
    // a light touch after it fires the pressure population that stayed silent before
    const light: Contact = { region: "arm", pressure: 0.13, cmPerS: 0, areaCm2: 1 };
    expect(once(light).rates["arm"]!["pressure"]).toBeUndefined();
    expect(fire(map, hurt.state, [light], 2000).rates["arm"]!["pressure"]).toBeGreaterThan(0);
  });

  it("feels nothing on a region it has no map for, and leaves private regions out unless allowed", () => {
    expect(once({ region: "thigh", pressure: 0.5, cmPerS: 0, areaCm2: 1 }).rates).toEqual({});
    const open = mergeSense([HUMAN_SENSE], true);
    expect(
      fire(open, NO_SENSE, [{ region: "thigh", pressure: 0.5, cmPerS: 0, areaCm2: 1 }], 1).rates[
        "thigh"
      ],
    ).toBeDefined();
    expect(feltOf(once(stroke(3)).rates)[0]).toMatchObject({ surface: "arm" });
  });
});

describe("packs", () => {
  it("a pack adds a region the engine never named, and bad packs say how to fix them", () => {
    const ear = {
      version: 1,
      id: "ears",
      regions: [{ id: "earlobe", anchor: { bone: "head" }, twoPointMm: 12, hairy: false }],
    };
    const d = decodeSensePack(ear);
    expect(d.ok).toBe(true);
    const withEar = mergeSense([HUMAN_SENSE, ...(d.ok ? [d.pack] : [])], false);
    expect(
      fire(withEar, NO_SENSE, [{ region: "earlobe", pressure: 0.3, cmPerS: 0, areaCm2: 1 }], 1)
        .rates["earlobe"],
    ).toBeDefined();
    expect(
      decodeSensePack({ version: 1, id: "x", regions: [{ id: "y", anchor: {}, twoPointMm: 500 }] }),
    ).toMatchObject({
      ok: false,
      errors: [
        expect.stringMatching(/anchor\.bone/),
        expect.stringMatching(/twoPointMm/),
        expect.stringMatching(/hairy/),
      ],
    });
  });
});
