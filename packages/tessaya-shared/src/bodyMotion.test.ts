import { describe, expect, it } from "vite-plus/test";

import { GESTURES, TOUCH_ZONES } from "./bodyCues.ts";
import {
  ACTS,
  POSTURES,
  outfitPiece,
  readTouch,
  postureFor,
  stepAt,
  talkBeats,
  touchKind,
  touchZoneAt,
  type Skeleton,
  type Vec3,
} from "./bodyMotion.ts";

// a 1.6 m VRoid-like rig in VRM 1.0 axes, arms down: she faces +z, her left is +x
const rig: Skeleton = {
  hips: [0, 0.95, 0],
  spine: [0, 1.02, 0],
  chest: [0, 1.12, 0],
  upperChest: [0, 1.22, 0],
  neck: [0, 1.36, 0],
  head: [0, 1.44, 0],
  leftShoulder: [0.04, 1.32, 0],
  rightShoulder: [-0.04, 1.32, 0],
  leftUpperArm: [0.12, 1.33, 0],
  rightUpperArm: [-0.12, 1.33, 0],
  leftLowerArm: [0.16, 1.08, 0],
  rightLowerArm: [-0.16, 1.08, 0],
  leftHand: [0.18, 0.84, 0],
  rightHand: [-0.18, 0.84, 0],
  leftUpperLeg: [0.08, 0.88, 0],
  rightUpperLeg: [-0.08, 0.88, 0],
  leftLowerLeg: [0.09, 0.48, 0.01],
  rightLowerLeg: [-0.09, 0.48, 0.01],
  leftFoot: [0.1, 0.08, -0.01],
  rightFoot: [-0.1, 0.08, -0.01],
  leftToes: [0.1, 0.02, 0.12],
  rightToes: [-0.1, 0.02, 0.12],
};

describe("touch map", () => {
  it.each<[string, Vec3, string, string?]>([
    // the old nearest-joint map called these hips: the top of the thigh, front and side
    ["thigh", [0.09, 0.78, 0.07], "upper front thigh"],
    ["thigh", [-0.15, 0.74, 0], "outer thigh"],
    ["thigh", [0.06, 0.62, -0.06], "back of the thigh"],
    ["hips", [0, 0.9, 0.08], "front of the pelvis"],
    ["hips", [0.07, 0.88, -0.1], "her seat"],
    ["hips", [0.11, 0.9, 0.07], "front of the hip bone"],
    ["belly", [0, 1.03, 0.1], "belly"],
    ["waist", [0.12, 1.02, 0], "waist, at her side"],
    ["chest", [0.07, 1.2, 0.1], "chest"],
    ["back", [0, 1.15, -0.1], "upper back"],
    ["back", [0, 1.02, -0.09], "lower back"],
    ["neck", [0, 1.38, 0.04], "neck"],
    ["face", [0.04, 1.48, 0.09], "cheek"],
    ["face", [0, 1.42, 0.08], "chin"],
    ["head", [0, 1.62, 0], "crown"],
    ["hair", [0, 1.5, -0.08], "back of the head"],
    ["hair", [0.2, 1.1, -0.1], "long hair", "Hair001"],
    ["shoulder", [0.14, 1.36, 0], "shoulder"],
    ["arm", [0.15, 1.2, 0.03], "upper arm"],
    ["arm", [-0.17, 0.95, 0.02], "forearm"],
    ["hand", [0.19, 0.8, 0.02], "hand"],
    ["leg", [0.09, 0.3, 0.05], "shin"],
    ["foot", [0.1, 0.04, 0.08], "foot"],
  ])("%s: %s", (zone, p, _what, mesh) => {
    expect(touchZoneAt(p, rig, mesh)).toBe(zone);
  });

  it("names only zones the protocol knows, and misses what is off her body", () => {
    expect(touchZoneAt([1.5, 1, 0], rig)).toBeNull();
    expect(touchZoneAt([0, 1, 0], {})).toBeNull();
    expect(TOUCH_ZONES).toEqual(
      expect.arrayContaining(["hair", "back", "waist", "leg", "foot", "thigh", "hips"]),
    );
  });

  it.each<[string, Parameters<typeof readTouch>[0]]>([
    ["tap", { ms: 150, travelPx: 2 }],
    ["poke", { ms: 80, travelPx: 1, pressure: 0.9 }],
    ["pat", { ms: 140, travelPx: 3, taps: 3 }],
    ["caress", { ms: 1500, travelPx: 200 }],
    ["stroke", { ms: 400, travelPx: 200 }],
    ["rub", { ms: 900, travelPx: 300, reversals: 3 }],
    ["tickle", { ms: 600, travelPx: 500, reversals: 6 }],
    ["hold", { ms: 900, travelPx: 4 }],
    ["grab", { ms: 900, travelPx: 4, pressure: 0.9 }],
    ["squeeze", { ms: 700, travelPx: 4, pointers: 2 }],
    ["pinch", { ms: 300, travelPx: 4, pointers: 2, spreadPx: -40 }],
  ])("reads a %s", (kind, sample) => {
    expect(readTouch(sample).kind).toBe(kind);
  });

  it("reads a firmer, faster touch as stronger, and a caress as gentle", () => {
    const soft = readTouch({ ms: 300, travelPx: 100, pressure: 0.5 });
    const hard = readTouch({ ms: 300, travelPx: 300, pressure: 1 });
    expect(hard.intensity).toBeGreaterThan(soft.intensity);
    expect(hard.speed).toBeGreaterThan(soft.speed);
    expect(readTouch({ ms: 2000, travelPx: 200 }).intensity).toBeLessThanOrEqual(0.6);
  });

  it("tells a tap from a stroke and a hold", () => {
    expect(touchKind(120, 3)).toBe("tap");
    expect(touchKind(700, 5)).toBe("hold");
    expect(touchKind(300, 60)).toBe("stroke");
  });
});

describe("motion set", () => {
  it.each<[string, Parameters<typeof postureFor>[0]]>([
    ["happy", { mood: "happy", intensity: 0.7 }],
    ["shy", { mood: "shy", intensity: 0.6 }],
    ["teasing", { mood: "smug", intensity: 0.6 }],
    ["playful", { mood: "playful", intensity: 0.7 }],
    ["affectionate", { mood: "love", intensity: 0.7 }],
    ["sad", { mood: "sad", intensity: 0.8 }],
    ["sleepy", { mood: "sleepy", intensity: 0.6 }],
    ["aroused", { mood: "happy", intensity: 0.6, arousal: 0.7, comfort: 0.8 }],
    // ill at ease guards whatever her mood or arousal says
    ["guarded", { mood: "happy", intensity: 0.8, arousal: 0.9, comfort: 0.2 }],
    ["shy", { mood: "embarrassed", intensity: 0.5, arousal: 0.6, comfort: 0.7 }],
    ["stand", { mood: "happy", intensity: 0.05 }],
    ["stand", { mood: "no-such-mood", intensity: 1 }],
  ])("%s for %j", (posture, affect) => {
    expect(postureFor(affect)).toBe(posture);
  });

  it("keeps the legs out of every standing posture, so a planted foot never slides", () => {
    const legs = /Leg|Foot/;
    for (const [name, p] of Object.entries(POSTURES)) {
      const moves = Object.keys(p.bones).some((b) => legs.test(b)) || "hips" in p.bones;
      expect(moves, name).toBe("grounded" in p && p.grounded === true);
    }
  });

  it("acts only through postures and gestures the body has", () => {
    for (const [name, a] of Object.entries(ACTS)) {
      if ("posture" in a && a.posture !== "auto") expect(POSTURES, name).toHaveProperty(a.posture);
      if ("gesture" in a) expect(GESTURES, name).toHaveProperty(a.gesture);
    }
  });

  it("finds the outfit pieces in VRoid material names, and nothing in skin", () => {
    expect(outfitPiece("N00_002_03_Tops_01_CLOTH")).toBe("tops");
    expect(outfitPiece("N00_010_01_Onepiece_00_CLOTH_02")).toBe("onepiece");
    expect(outfitPiece("N00_008_01_Shoes_01_CLOTH")).toBe("shoes");
    expect(outfitPiece("N00_000_00_Body_00_SKIN")).toBeNull();
  });

  it("steps in place one foot at a time", () => {
    const early = stepAt(250);
    const late = stepAt(800);
    expect(Object.keys(early)).toEqual(["leftUpperLeg", "leftLowerLeg"]);
    expect(Object.keys(late)).toEqual(["rightUpperLeg", "rightLowerLeg"]);
    expect(stepAt(0).leftUpperLeg?.[0]).toBeCloseTo(0);
  });

  it("beats on the words that carry a line, spaced apart", () => {
    const words = "Honestly, I missed you so much today!"
      .split(" ")
      .map((text, i) => ({ text, atMs: i * 300 }));
    const beats = talkBeats(words);
    expect(beats.map((b) => b.atMs)).toEqual([0, 1800]);
    expect(beats[0]!.gesture).not.toBe(beats[1]!.gesture);
  });
});
