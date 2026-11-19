import { describe, expect, it } from "vite-plus/test";

import { EXPRESSION_GESTURES, EXPRESSION_MOODS } from "@t3tools/tessaya-contracts";

import { FACE_LIBRARY } from "./expressionMap.ts";
import {
  BODY_FACES,
  GESTURES,
  beastkin,
  faceWeights,
  lineCues,
  mouthWeights,
  limitMouth,
  MAX_ZONES,
  mouthIntentOf,
  parseCue,
  swingAt,
  textTrack,
} from "./bodyCues.ts";

describe("body faces", () => {
  it("shows every spine mood and face library name, scaled by intensity", () => {
    for (const face of [...EXPRESSION_MOODS, ...FACE_LIBRARY])
      expect(Object.hasOwn(BODY_FACES, face), face).toBe(true);
    expect(faceWeights("happy", 1)).toEqual({ happy: 0.7 });
    expect(faceWeights("happy", 0).happy).toBeCloseTo(0.28);
    expect(faceWeights("no-such-mood", 1)).toEqual({});
  });

  it("opens the mouth by the aligned viseme, or by level alone before the alignment reaches it", () => {
    expect(mouthWeights("aa", 0.2)).toEqual({ aa: 0.2 });
    expect(mouthWeights("mbp")).toEqual({});
    expect(mouthWeights(undefined, 0.2).aa).toBeCloseTo(0.14, 6);
    expect(mouthWeights(undefined, 0)).toEqual({});
    // speaking never opens her jaw past a third of its range, at any loudness or shape
    for (const v of [undefined, "aa", "oh", "oo", "ee", "uh", "l", "etc"] as const)
      for (const level of [0.3, 0.7, 1])
        for (const w of Object.values(mouthWeights(v, level))) expect(w).toBeLessThanOrEqual(0.35);
  });

  it("eases a face's jaw past what it asks for, reaching full only for a strong act, and says what it eased", () => {
    // a smile with a wide jaw is a feeling: eased toward the moderate reach, never cut flat
    const smile = limitMouth({ happy: 0.5, aa: 0.9 }, mouthIntentOf({ happy: 0.5, aa: 0.9 }));
    expect(smile.weights.aa).toBeLessThan(0.6);
    expect(smile.weights.aa).toBeGreaterThan(limitMouth({ happy: 0.5, aa: 0.5 }, "expression").weights.aa!);
    expect(smile.eased).toEqual([expect.objectContaining({ key: "aa", asked: 0.9 })]);
    // "open wide" (only her jaw), a gasp and a hard laugh are strong: her full natural range
    for (const w of [{ aa: 1 }, { surprised: 0.8, oh: 1 }, { happy: 1, aa: 0.9 }]) {
      expect(mouthIntentOf(w)).toBe("strong");
      expect(Math.max(...Object.values(limitMouth(w, "strong").weights))).toBeGreaterThanOrEqual(0.85);
    }
    // a yawn's own jaw reaches near full
    expect(GESTURES["yawn"]?.face?.aa).toBeGreaterThanOrEqual(0.85);
  });

  it("has a move for every public gesture but none, and each ends where it began", () => {
    for (const g of EXPRESSION_GESTURES.filter((g) => g !== "none")) {
      const move = GESTURES[g]!;
      expect(move, g).toBeDefined();
      for (const s of move.swings) {
        expect(swingAt(s, move.ms, 0)).toBe(0);
        expect(swingAt(s, move.ms, move.ms)).toBe(0);
      }
    }
  });
});

describe("beastkin", () => {
  it.each([
    ["curious", 1, 0, 1, (b: ReturnType<typeof beastkin>) => b.earPitch > 0],
    [
      "sad",
      1,
      0,
      1,
      (b: ReturnType<typeof beastkin>) => b.earPitch < 0 && b.tailAmp === 0 && b.tailDroop > 0,
    ],
    ["angry", 1, 0, 1, (b: ReturnType<typeof beastkin>) => b.earPitch <= -0.9],
    ["happy", 1, 0, 1, (b: ReturnType<typeof beastkin>) => b.tailAmp > 0.3],
    // arousal alone wags; unease pins the ears and stills the tail, whatever the mood
    ["neutral", 0.5, 0.8, 1, (b: ReturnType<typeof beastkin>) => b.tailAmp > 0.15 && b.tailHz > 2],
    ["happy", 1, 0.8, 0, (b: ReturnType<typeof beastkin>) => b.earPitch < -0.5 && b.tailAmp === 0],
  ] as const)("%s at %s, arousal %s, comfort %s", (mood, intensity, arousal, comfort, holds) => {
    expect(holds(beastkin({ mood, intensity, arousal, comfort }))).toBe(true);
  });

  it("flattens the ears, quivers them and lifts the tail stiff at an arch", () => {
    const b = beastkin({
      mood: "happy",
      intensity: 1,
      arousal: 1,
      motion: { breath: 1, breathHz: 1, tremble: 1, arch: 1 },
    });
    expect(b.earPitch).toBeLessThan(-0.5);
    expect(b.earQuiver).toBeGreaterThan(0);
    expect(b.tailDroop).toBeLessThan(0);
  });
});

describe("cue wire", () => {
  it.each([
    [{ kind: "show" }, { kind: "show" }],
    [
      { kind: "mood", mood: "happy", intensity: 3 },
      { kind: "mood", mood: "happy", intensity: 1 },
    ],
    [
      { kind: "mood", mood: "happy", intensity: 0.5, arousal: 0.4, comfort: 9 },
      { kind: "mood", mood: "happy", intensity: 0.5, arousal: 0.4, comfort: 1 },
    ],
    // the intimate set: only named states, each clamped, and motion with every field
    [
      {
        kind: "mood",
        mood: "happy",
        intensity: 0.5,
        states: { blush: 2, eyesRoll: 0.5, tongue: 1, drool: 1 },
        motion: { breath: 0.5, tremble: -1 },
      },
      {
        kind: "mood",
        mood: "happy",
        intensity: 0.5,
        states: { blush: 1, eyesRoll: 0.5, tongue: 1 },
        motion: { breath: 0.5, breathHz: 0.25, tremble: 0, arch: 0 },
      },
    ],
    [{ kind: "model", persona: "freya", url: "/tessaya/layer/companion/body/model" }, "same"],
    // a cue can never point a body at another host
    [{ kind: "model", persona: "freya", url: "https://cdn.example/x.vrm" }, null],
    [{ kind: "model", persona: "freya", url: "//cdn.example/x.vrm" }, null],
    [{ kind: "model", persona: "freya", url: "blob:https://host/8c1f" }, "same"],
    [
      { kind: "level", value: 0.4, viseme: "zz" },
      { kind: "level", value: 0.4 },
    ],
    [{ kind: "gesture" }, null],
    [{ kind: "stop" }, { kind: "stop" }],
    [
      {
        kind: "prop",
        id: "p1",
        url: "/tessaya/layer/companion/body/prop/p1",
        bone: "rightHand",
        on: true,
        intensity: 2,
        speed: 1,
      },
      {
        kind: "prop",
        id: "p1",
        url: "/tessaya/layer/companion/body/prop/p1",
        bone: "rightHand",
        on: true,
        intensity: 1,
        speed: 1,
      },
    ],
    [{ kind: "prop", id: "p1", url: "https://x.example/p.glb" }, null],
    [
      { kind: "prop", id: "p1", bone: "tail" },
      { kind: "prop", id: "p1" },
    ],
    [{ kind: "pose", pose: "sit" }, "same"],
    [{ kind: "pose", pose: "auto" }, "same"],
    [{ kind: "pose", pose: "cartwheel" }, null],
    [{ kind: "act", act: "walkOver" }, "same"],
    [{ kind: "act", act: "toString" }, null],
    [
      { kind: "outfit", off: ["tops", "tops", "skin", 3] },
      { kind: "outfit", off: ["tops"] },
    ],
    [
      {
        kind: "speak",
        track: [],
        effects: [
          { atMs: 10, act: "sit" },
          { atMs: 20, act: "fly" },
        ],
      },
      { kind: "speak", track: [], effects: [{ atMs: 10, act: "sit" }] },
    ],
    [
      {
        kind: "clip",
        id: "sway",
        fps: 4,
        loop: true,
        frames: [{ spine: [0, 0, 0.1], tail: [0, 0, 1] }, { head: [9, 0, 0] }],
      },
      // out-of-range angles clamp, unknown bones drop
      {
        kind: "clip",
        id: "sway",
        fps: 4,
        loop: true,
        grounded: false,
        frames: [{ spine: [0, 0, 0.1] }, { head: [Math.PI, 0, 0] }],
      },
    ],
    [
      {
        kind: "zones",
        zones: [
          { id: "ears", bone: "head", radius: 0.05 },
          { id: "x", bone: "head", radius: 3 },
        ],
      },
      {
        kind: "zones",
        zones: [
          { id: "ears", bone: "head", radius: 0.05 },
          { id: "x", bone: "head", radius: 0.3 },
        ],
      },
    ],
    [
      {
        kind: "expressions",
        map: { blush: [{ name: "Cheek", weight: 0.8 }, { name: 3 }], sad: [] },
      },
      { kind: "expressions", map: { blush: [{ name: "Cheek", weight: 0.8 }] } },
    ],
    [{ kind: "nope" }, null],
    ["show", null],
  ])("%j", (raw, want) => {
    expect(parseCue(raw)).toEqual(want === "same" ? raw : want);
  });

  it("keeps every touch region a pack sends, and counts any past the bound instead of losing them", () => {
    const zone = (i: number) => ({ id: `spot${i}`, bone: "spine", radius: 0.05 });
    const many = parseCue({ kind: "zones", zones: Array.from({ length: 83 }, (_, i) => zone(i)) });
    expect(many).toMatchObject({ kind: "zones" });
    expect(many?.kind === "zones" && many.zones.length).toBe(83);
    expect(many?.kind === "zones" && many.dropped).toBeFalsy();
    const over = parseCue({
      kind: "zones",
      zones: Array.from({ length: MAX_ZONES + 6 }, (_, i) => zone(i)),
    });
    expect(over?.kind === "zones" && [over.zones.length, over.dropped]).toEqual([MAX_ZONES, 6]);
  });

  it("keeps only well-formed speech segments and effects", () => {
    expect(
      parseCue({
        kind: "speak",
        track: [
          { at: 0, end: 90, viseme: "aa" },
          { at: 90, end: 10, viseme: "ee" },
          { at: 0, end: 5, viseme: "x" },
        ],
        effects: [{ atMs: 40, face: "laughing" }, { atMs: 1 }],
      }),
    ).toEqual({
      kind: "speak",
      track: [{ at: 0, end: 90, viseme: "aa" }],
      effects: [{ atMs: 40, face: "laughing" }],
    });
  });
});

describe("line timing", () => {
  it("stretches the text's mouth to the measured length and pins words the aligner heard", () => {
    const free = textTrack("Hello there");
    expect(free[0]!.at).toBe(0);
    const fitted = textTrack("Hello there", { durationMs: 2000 });
    expect(fitted.at(-1)!.end).toBeCloseTo(2000, -1);
    const pinned = textTrack("Hello there", { wordMs: [undefined, 1500] });
    const there = pinned.find((s) => s.at >= 1500);
    expect(there).toBeDefined();
  });

  it("puts a G7 effect on its word, with the speaker switch and mood first", () => {
    const cues = lineCues({
      persona: "freya",
      text: "That is brilliant you did it",
      mood: "happy",
      intensity: 0.8,
      gesture: "nodSoft",
      wordMs: [0, 200, 400, 900, 1100, 1300],
      effects: [{ when: { at: "speech", sentence: 0, word: 3 }, face: "laughing" }],
    });
    expect(cues.map((c) => c.kind)).toEqual(["speaker", "mood", "gesture", "speak"]);
    const speak = cues[3]!;
    // "brilliant" carries the line, so a talking beat lands on its own word too
    expect(speak.kind === "speak" && speak.effects).toEqual([
      { atMs: 555, gesture: "beatR" },
      { atMs: 900, face: "laughing" },
    ]);
  });
});
