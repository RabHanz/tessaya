import { describe, expect, it } from "vite-plus/test";

import {
  claimedRegion,
  decodeSensePack,
  feltOf,
  feltTone,
  feltWords,
  fire,
  HUMAN_SENSE,
  mergeSense,
  NO_SENSE,
  reflexesOf,
  zonesPack,
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

  it("reads the same whether a body steps it every frame or a server once a touch", () => {
    const press: Contact = { region: "hand", pressure: 0.7, cmPerS: 0, areaCm2: 2 };
    const event = once(press).levels["hand"]!["light"]!;
    // a 100 ms ramp to the same press at 60 frames a second
    let state = NO_SENSE;
    let peak = 0;
    for (let f = 1; f <= 30; f += 1) {
      const step = fire(map, state, [{ ...press, pressure: 0.7 * Math.min(1, f / 6) }], f * 16.7);
      state = step.state;
      peak = Math.max(peak, step.levels["hand"]!["light"] ?? 0);
      // a held press is one touch: it does not habituate frame by frame
      if (f === 30) expect(step.state.sites["hand"]!.habit).toBeLessThan(0.1);
      if (f === 30) expect(step.levels["hand"]!["light"] ?? 0).toBeLessThan(0.1);
    }
    expect(peak).toBeGreaterThan(event * 0.6);
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

describe("stretch, temperature and reflex arcs", () => {
  it("a pull on her hair fires stretch fibres, and a hard one hurts and makes her pull away", () => {
    const pull = (stretch: number) =>
      once({ region: "hair", pressure: 0.1, cmPerS: 0, areaCm2: 4, stretch });
    const soft = pull(0.3);
    expect(soft.rates["hair"]!["stretch"]).toBeGreaterThan(0);
    expect(soft.rates["hair"]!["noci"]).toBeUndefined();
    expect(feltWords("hair", soft.rates["hair"]!, soft.state, 0)).toBe("a pull");
    const hard = pull(0.95);
    expect(hard.rates["hair"]!["noci"]).toBeGreaterThan(0);
    expect(feltTone(hard.rates["hair"]!)).toBe("hurt");
    expect(reflexesOf(map, hard.levels)[0]).toMatchObject({ action: "withdraw", region: "hair" });
    expect(reflexesOf(map, soft.levels).some((r) => r.action === "withdraw")).toBe(false);
  });

  it("a fingertip poke startles her; a palm laid on her as firmly does not", () => {
    const startles = (areaCm2: number) =>
      reflexesOf(map, once({ region: "arm", pressure: 0.45, cmPerS: 0, areaCm2 }).levels).some(
        (r) => r.action === "flinch",
      );
    expect(startles(1.4)).toBe(true);
    expect(startles(50)).toBe(false);
  });

  it("warm and cold fire only away from her skin's own temperature", () => {
    const at = (tempC: number) =>
      once({ region: "arm", pressure: 0.3, cmPerS: 0, areaCm2: 20, tempC }).rates["arm"]!;
    expect(at(33)["warm"] ?? 0).toBe(0);
    expect(at(40)["warm"]).toBeGreaterThan(0);
    expect(at(20)["cold"]).toBeGreaterThan(0);
    expect(at(20)["warm"]).toBeUndefined();
  });

  it("a slow stroke near the caress optimum leans her in; a light brush only turns her toward it", () => {
    const lean = (v: number) =>
      reflexesOf(map, once(stroke(v)).levels).some((r) => r.action === "leanIn");
    expect(lean(3)).toBe(true);
    expect(lean(40)).toBe(false);
    expect(feltTone(once(stroke(3)).rates["arm"]!)).toBe("pleasant");
  });
});

describe("packs", () => {
  it("a custom-bone region claims a touch inside its capsule, and the older zones cue becomes a pack", () => {
    const tail = mergeSense(
      [
        HUMAN_SENSE,
        {
          version: 1,
          id: "tail",
          regions: [
            {
              id: "tail",
              anchor: { bone: "J_Tail_01", to: "J_Tail_03", radius: 0.05 },
              twoPointMm: 30,
              hairy: true,
            },
          ],
        },
      ],
      false,
    );
    const bones: Record<string, readonly [number, number, number]> = {
      J_Tail_01: [0, 1, -0.1],
      J_Tail_03: [0, 0.8, -0.4],
    };
    expect(claimedRegion(tail, [0, 0.9, -0.26], (b) => bones[b])).toBe("tail");
    expect(claimedRegion(tail, [0, 1.5, 0.2], (b) => bones[b])).toBeNull();
    expect(zonesPack([{ id: "earlobe", bone: "head", radius: 0.03 }]).regions[0]).toMatchObject({
      id: "earlobe",
      anchor: { bone: "head", radius: 0.03 },
    });
  });

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
