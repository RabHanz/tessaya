// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeVM from "node:vm";

import { integratedLufs } from "@t3tools/tessaya-voice/loudness";
import { describe, expect, it } from "vite-plus/test";

import { SOUND_GAIN } from "./desktopMascot.ts";

interface Physics {
  readonly mass: number;
  readonly soft: number;
  readonly bounce: number;
}
interface Foley extends Partial<Physics> {
  readonly speed: number;
  readonly rate: number;
  readonly seed: number;
  readonly variant?: number;
}

/** Her body's sounds as the stage page loads them (apps/web/public/companion/sounds.js). */
const loadSounds = () => {
  const dir = NodePath.join(__dirname, "..", "..", "..", "..", "web", "public", "companion");
  const g: Record<string, unknown> = {};
  const context = NodeVM.createContext({ window: g, self: g, console });
  for (const file of ["rig.js", "bodies.js", "sounds.js"])
    NodeVM.runInContext(NodeFS.readFileSync(NodePath.join(dir, file), "utf8"), context);
  const TCS = g["TCS"] as {
    PHYSICS: Record<string, Physics>;
    SOUND: {
      KINDS: ReadonlyArray<string>;
      foley: (kind: string, o: Foley) => Float32Array | null;
      bed: (rate: number) => Float32Array;
    };
  };
  return { physics: TCS.PHYSICS, ...TCS.SOUND };
};

const S = loadSounds();
const RATE = 24_000;
const BED_RATE = 11_025;
const pcm16 = (x: Float32Array) =>
  Int16Array.from(x, (v) => Math.max(-32768, Math.min(32767, Math.round(v * 32767))));
const peak = (x: Float32Array) => x.reduce((a, v) => Math.max(a, Math.abs(v)), 0);
/** An event's loudness as one 400 ms block from its start (events are front-loaded). */
const loudness = (x: Float32Array) => {
  const block = new Float32Array(RATE * 0.4);
  block.set(x.subarray(0, block.length));
  return integratedLufs(pcm16(block), RATE);
};
/** The share of its energy in the sample-to-sample change: higher is brighter. */
const brightness = (x: Float32Array) => {
  let change = 0;
  let all = 0;
  for (let i = 1; i < x.length; i += 1) {
    change += (x[i]! - x[i - 1]!) ** 2;
    all += x[i]! ** 2;
  }
  return change / all;
};
const BODIES = Object.keys(S.physics);

describe("her body's sounds", () => {
  const bed = S.bed(BED_RATE);

  // As it plays: the same mono samples on two speakers measure 3 LU louder (BS.1770 sums the channels).
  it("puts her bed at about -25 LUFS as it plays, every level within -28 to -22, with headroom", () => {
    const played = integratedLufs(pcm16(bed), BED_RATE) + 3.01;
    expect(Math.abs(played + 25)).toBeLessThan(0.5);
    for (const gain of [SOUND_GAIN.soft, SOUND_GAIN.normal, SOUND_GAIN.full]) {
      const at = played + 20 * Math.log10(gain);
      expect(at).toBeGreaterThanOrEqual(-28);
      expect(at).toBeLessThanOrEqual(-22);
      expect(peak(bed) * gain).toBeLessThan(0.5);
    }
  });

  it("loops the bed without a seam", () => {
    let step = 0;
    for (let i = 1; i < bed.length; i += 1) step = Math.max(step, Math.abs(bed[i]! - bed[i - 1]!));
    expect(Math.abs(bed[0]! - bed.at(-1)!)).toBeLessThanOrEqual(step);
  });

  it.each(S.KINDS)("%s: audible on every body and never near clipping", (kind) => {
    for (const body of BODIES)
      for (const speed of [600, 3000]) {
        const x = S.foley(kind, { ...S.physics[body], speed, rate: RATE, seed: 5 })!;
        expect(peak(x) * SOUND_GAIN.full, `${body} at ${speed}`).toBeLessThan(1);
        expect(loudness(x), `${body} at ${speed}`).toBeGreaterThan(-40);
      }
  });

  it("lands louder the harder she falls", () => {
    for (const body of BODIES) {
      const at = (speed: number) =>
        loudness(S.foley("land", { ...S.physics[body], speed, rate: RATE, seed: 9 })!);
      expect(at(400)).toBeLessThan(at(1200));
      expect(at(1200)).toBeLessThan(at(3000));
    }
  });

  it("never plays the same clip twice: each render is jittered, and variants differ", () => {
    const one = S.foley("poke", { ...S.physics["felt"], speed: 400, rate: RATE, seed: 1 })!;
    const two = S.foley("poke", { ...S.physics["felt"], speed: 400, rate: RATE, seed: 2 })!;
    const other = S.foley("poke", {
      ...S.physics["felt"],
      speed: 400,
      rate: RATE,
      seed: 1,
      variant: 1,
    })!;
    expect(one).not.toEqual(two);
    expect(one).not.toEqual(other);
  });

  it("rings brighter from a rigid body than a plush one", () => {
    const land = (body: string) =>
      brightness(S.foley("land", { ...S.physics[body], speed: 2000, rate: RATE, seed: 3 })!);
    expect(land("thimble")).toBeGreaterThan(land("drop"));
  });
});
