import { describe, expect, it } from "vite-plus/test";

import { parseCue } from "./bodyCues.ts";
import { POSTURES, type Euler, type PoseBone } from "./bodyMotion.ts";
import { decodePerform, performCues } from "./bodyPlanner.ts";
import { dot, preparePose, REFERENCE_RIG, v3 } from "./bodyRig.ts";
import { palmsIn, TWO_HAND_SKILLS, twoHandsAt, type TwoHandSkill } from "./bodySkills.ts";

type Pose = Partial<Record<string, Euler>>;
const stand = POSTURES.stand.bones as Partial<Record<PoseBone, Euler>>;
const frames = (skill: TwoHandSkill, style: string, rate?: number) =>
  Array.from({ length: 60 }, (_, i) =>
    twoHandsAt(skill, { style, ...(rate === undefined ? {} : { rate }) }, stand, i / 30),
  );
const bonesOf = (f: Pose): Pose =>
  Object.fromEntries(Object.entries(f).filter(([b]) => !/Fingers$/.test(b)));
/** Palm surface to palm surface along the left palm's facing: below 0 is one hand inside the other. */
const gapOf = (f: Pose) => {
  const p = palmsIn({ ...stand, ...bonesOf(f) });
  return dot(v3.sub(p.right.palm, p.left.palm), p.left.normal);
};
const facingOf = (f: Pose) => {
  const p = palmsIn({ ...stand, ...bonesOf(f) });
  return -dot(p.left.normal, p.right.normal);
};
const worstFix = (f: Pose) =>
  Math.max(
    0,
    ...preparePose(REFERENCE_RIG, { ...stand, ...bonesOf(f) } as Record<string, Euler>).issues.map(
      (i) => i.by,
    ),
  );

describe("two-hand skills", () => {
  const all = Object.entries(TWO_HAND_SKILLS).flatMap(([skill, styles]) =>
    styles.map((style) => [skill as TwoHandSkill, style] as const),
  );

  it.each(all)("%s (%s) stays inside her joint ranges in every frame", (skill, style) => {
    for (const f of frames(skill, style)) expect(worstFix(f)).toBeLessThan(0.1);
  });

  it.each(all.filter(([s]) => s === "rub" || s === "pray" || s === "wring" || s === "interlace"))(
    "%s (%s): palms facing, touching, never through each other",
    (skill, style) => {
      for (const f of frames(skill, style)) {
        const gap = gapOf(f);
        expect(gap).toBeGreaterThanOrEqual(0);
        expect(gap).toBeLessThan(0.015);
        expect(facingOf(f)).toBeGreaterThan(skill === "interlace" ? 0.5 : 0.95);
        // palms that meet are closed on her own hands too; interlaced fingers are not palm to palm
        expect(f["palms"] === undefined).toBe(skill === "interlace");
      }
    },
  );

  it("claps on the beat: palms close to touching, never through, and open again, at the rate asked", () => {
    const gaps = frames("clap", "polite", 2).map(gapOf);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(0);
    expect(Math.min(...gaps)).toBeLessThan(0.01);
    expect(Math.max(...gaps)).toBeGreaterThan(0.08);
    // contacts in 2 s at 2 a second: each a run of touching frames
    const touching = gaps.map((g) => g < 0.01);
    const claps = touching.filter((t, i) => t && !touching[i - 1]).length;
    expect(claps).toBe(4);
    for (const f of frames("clap", "polite", 2)) expect(facingOf(f)).toBeGreaterThan(0.95);
    // each frame tells the renderer the skin gap to close her own palms to, met on the beat
    const asked = frames("clap", "polite", 2).map((f) => f["palms"]!);
    expect(asked.every((p) => p[1] === 1 && p[2] === 0)).toBe(true);
    expect(asked.filter((p) => p[0] <= 0.004).length).toBeGreaterThanOrEqual(8);
    // centred in front of her sternum: 20-30 cm ahead of the upper chest, at mid-chest height
    for (const f of frames("clap", "polite", 2)) {
      const [ahead, up] = f["meet"]!;
      expect(ahead).toBeGreaterThan(0.2);
      expect(ahead).toBeLessThan(0.3);
      expect(Math.abs(up + 0.05)).toBeLessThan(0.06);
    }
  });

  it.each([
    ["overhead", [0.1, 0.34, 0]],
    ["left", [0.26, -0.06, 0.16]],
    ["behind", [-0.2, -0.4, 0]],
    ["a point", [0.3, 0.1, -0.1]],
  ] as const)("claps %s: there, palm to palm, inside her joint ranges", (where, at) => {
    const fs = Array.from({ length: 30 }, (_, i) =>
      twoHandsAt(
        "clap",
        { style: "polite", rate: 2, where: where === "a point" ? at : where },
        stand,
        i / 30,
      ),
    );
    const gaps = fs.map(gapOf);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(0);
    expect(Math.min(...gaps)).toBeLessThan(0.01);
    for (const f of fs) {
      expect(worstFix(f)).toBeLessThan(0.1);
      const meet = f["meet"]!;
      expect(Math.hypot(meet[0] - at[0], meet[1] - at[1], meet[2] - at[2])).toBeLessThan(0.03);
    }
  });

  it("holds the other wrist: her left palm on top of her right wrist, fingers wrapped round", () => {
    for (const f of frames("holdWrist", "patient")) {
      const p = palmsIn({ ...stand, ...bonesOf(f) });
      const wrist = p.right.palm;
      expect(Math.hypot(...v3.sub(p.left.palm, wrist))).toBeLessThan(0.16);
      expect(p.left.normal[1]).toBeLessThan(-0.9);
      expect(f["leftFingers"]![0]).toBeGreaterThan(0.6);
    }
  });

  it("interlaced fingers are curled round the other hand", () => {
    for (const f of frames("interlace", "relaxed")) {
      expect(f["leftFingers"]![0]).toBeGreaterThan(0.7);
      expect(f["rightFingers"]![1]).toBeGreaterThan(0.5);
    }
  });
});

describe("a two-hand skill in a performance", () => {
  it("decodes, plays its rhythm through the hold, and carries finger shapes the clip decoder keeps", () => {
    const d = decodePerform({
      feel: { valence: 0.8, arousal: 0.6, dominance: 0.2 },
      hands: { skill: "clap", style: "excited", repeat: 3 },
    });
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.perform.hands).toEqual({ skill: "clap", style: "excited", repeat: 3 });
    const clip = performCues(d.perform, stand).cues.find((c) => c.kind === "clip");
    if (clip?.kind !== "clip") throw new Error("no clip");
    const gaps = clip.frames.map((f) => gapOf(f as Pose));
    const touching = gaps.map((g) => g < 0.01);
    expect(touching.filter((t, i) => t && !touching[i - 1]).length).toBeGreaterThanOrEqual(3);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(0);
    const decoded = parseCue({ ...clip });
    expect(decoded?.kind === "clip" && decoded.frames.some((f) => "leftFingers" in f)).toBe(true);
  });

  it.each(["rub", "pray", "wring", "interlace"] as const)(
    "%s: the palms come together and stay together, never through, on the way in or out",
    (skill) => {
      const d = decodePerform({
        feel: { valence: 0.3, arousal: 0.4, dominance: 0 },
        hands: { skill },
      });
      if (!d.ok) throw new Error(d.error);
      const clip = performCues(d.perform, stand).cues.find((c) => c.kind === "clip");
      if (clip?.kind !== "clip") throw new Error("no clip");
      const gaps = clip.frames.map((f) => gapOf(f as Pose));
      expect(Math.min(...gaps)).toBeGreaterThanOrEqual(0);
      expect(gaps.filter((g) => g < 0.015).length).toBeGreaterThan(30);
    },
  );

  it("refuses a skill it does not know, naming the ones it does", () => {
    const d = decodePerform({
      feel: { valence: 0, arousal: 0, dominance: 0 },
      hands: { skill: "juggle" },
    });
    expect(d.ok === false && d.error).toContain("clap");
  });
});
