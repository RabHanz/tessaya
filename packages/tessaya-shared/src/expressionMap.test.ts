// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import {
  EMOTIONS,
  FACE_LIBRARY,
  NONVERBAL_LOOKS,
  PROP_AT,
  VESSELS,
  clipFor,
  effectFor,
  faceFor,
  PROPS,
  propTagOf,
  renderFor,
} from "./expressionMap.ts";

describe("clips by name", () => {
  const body = {
    id: "body",
    clips: [
      "Neutral_Idle",
      "Happy_Idle",
      "Happy_Idle_2",
      "Sad_Talking_Fixed",
      "Sad_Talking",
      "Happy_Reaction",
    ],
  };
  it("plays <Emotion>_<State>, its variants in turn, a fixed one for a whole reply, and falls down the kin", () => {
    expect(clipFor(body, "happy", "Idle", { turn: 1 })).toBe("Happy_Idle_2");
    expect(clipFor(body, "proud", "Reaction")).toBe("Happy_Reaction");
    expect(clipFor(body, "sad", "Talking")).toBe("Sad_Talking");
    expect(clipFor(body, "sad", "Talking", { wholeReply: true })).toBe("Sad_Talking_Fixed");
    expect(clipFor(body, "angry", "Idle")).toBe("Neutral_Idle");
    expect(clipFor(body, "happy", "Fidget")).toBeNull();
    expect(clipFor(VESSELS.pill, "happy", "Idle")).toBeNull();
  });
});

describe("the expression map", () => {
  it("every emotion's kin and props name something real, so a new row cannot point at nothing", () => {
    // a mood's props, and every vessel's, are the vocabulary's (props.js), so none is lost to a name mismatch
    const props = new Set<string>(PROPS);
    for (const v of Object.values(VESSELS))
      for (const p of "props" in v ? v.props : []) expect(props, `${v.id} prop ${p}`).toContain(p);
    const names = new Set<string>([
      ...Object.values(VESSELS).flatMap((v) => ("face" in v ? v.face : [])),
      ...Object.keys(EMOTIONS),
    ]);
    for (const [label, look] of Object.entries(EMOTIONS)) {
      for (const k of look.kin) expect(names, `${label} kin ${k}`).toContain(k);
      for (const p of look.props ?? []) expect(props, `${label} prop ${p}`).toContain(p);
    }
    // A stage direction's face is one every face library draws, so it is never dropped as unknown.
    for (const [sound, look] of Object.entries(NONVERBAL_LOOKS))
      if (look.face !== undefined) expect(FACE_LIBRARY, sound).toContain(look.face);
  });

  it("a stage direction buzzes only a vessel with a motor", () => {
    expect(effectFor(VESSELS.tessel, "laugh")).toEqual({ face: "laughing", haptic: "giggle" });
    expect(effectFor(VESSELS.mascot, "laugh")).toEqual({ face: "laughing", haptic: null });
    expect(effectFor(VESSELS.speaker, "gasp")).toEqual({ face: null, haptic: null });
  });

  it("every emotion draws a face on every vessel with one, falling back through its kin", () => {
    for (const vessel of [VESSELS.tessel, VESSELS.mascot, VESSELS.pill])
      for (const label of Object.keys(EMOTIONS)) expect(faceFor(vessel, label)).not.toBeNull();
    // The rig has no "steady": it shows as calm, its kin.
    expect(faceFor(VESSELS.mascot, "steady")).toBe("calm");
    // A vessel that draws only a few faces gets the nearest one, then neutral.
    const small = { id: "small", face: ["neutral", "sad", "thinking"] };
    expect(faceFor(small, "hurt")).toBe("sad");
    expect(faceFor(small, "determined")).toBe("thinking");
    expect(faceFor(small, "proud")).toBe("neutral");
    expect(faceFor(small, "giddy")).toBe("neutral");
    expect(faceFor(VESSELS.speaker, "sad")).toBeNull();
  });

  it("renders only the channels a vessel declares, a prop only when the mood is strong and the vessel has it", () => {
    expect(renderFor(VESSELS.mascot, "proud", PROP_AT).prop).toBe("crown");
    expect(renderFor(VESSELS.mascot, "proud", PROP_AT - 0.1).prop).toBeNull();
    // The Tessel has no crown; focused falls to its next prop, reading.
    expect(renderFor(VESSELS.tessel, "proud", 1).prop).toBeNull();
    expect(renderFor(VESSELS.tessel, "focused", 1).prop).toBe("reading");
    // sleepy reaches the Tessel's mask by its own name (it was lost to "mask" against props.js's "sleepmask")
    expect(renderFor(VESSELS.tessel, "sleepy", 1).prop).toBe("mask");
    // A motor buzzes the mood's own pattern; a mood without one stays still.
    expect(renderFor(VESSELS.tessel, "sulky", 0.3).haptic).toBe("thump");
    expect(renderFor(VESSELS.tessel, "focused", 1).haptic).toBeNull();
    expect(renderFor(VESSELS.pill, "proud", 1)).toEqual({ face: "proud" });
    expect(renderFor({ id: "lamp", light: true }, "sad", 1)).toEqual({ face: null, dye: "indigo" });
    expect(renderFor(VESSELS.speaker, "concerned", 1).voice).toEqual({
      style: "gentle, slower, kind",
      sound: null,
      blocks: ["[laughs]", "[excited]"],
    });
    // A new device is a manifest: no code change.
    expect(renderFor({ id: "watch", face: ["neutral", "happy"], voice: true }, "proud", 1)).toEqual(
      {
        face: "happy",
        voice: { style: "warm, quietly pleased", sound: "laugh", blocks: [] },
      },
    );
  });
});

describe("props from what is going on", () => {
  it("every prop in the vocabulary is the Character Studio's, and every one is reachable on her cartoon", () => {
    const studio = [
      ...NodeFS.readFileSync(
        new URL("../../../apps/web/public/companion/props.js", import.meta.url),
        "utf8",
      ).matchAll(/\badd\("([a-z0-9]+)"/g),
    ].map((m) => m[1]);
    expect(PROPS).toEqual(studio);
    for (const p of PROPS) expect(renderFor(VESSELS.mascot, "neutral", 0, { tag: p }).prop).toBe(p);
  });

  it("puts what he pinned first, then the line's tag, then the house, then the mood", () => {
    const busy = { building: true, hour: 23 } as const;
    expect(renderFor(VESSELS.mascot, "proud", 1, busy).prop).toBe("hardhat");
    expect(renderFor(VESSELS.mascot, "proud", 1, { ...busy, tag: "rocket" }).prop).toBe("rocket");
    expect(
      renderFor(VESSELS.mascot, "proud", 1, { ...busy, tag: "rocket", pinned: "umbrella" }).prop,
    ).toBe("umbrella");
    expect(renderFor(VESSELS.mascot, "proud", 1, { hour: 14 }).prop).toBe("crown");
    expect(renderFor(VESSELS.mascot, "neutral", 0, { hour: 23 }).prop).toBe("nightcap");
    expect(renderFor(VESSELS.mascot, "neutral", 0, { weather: "rain" }).prop).toBe("umbrella");
    expect(propTagOf("Bring a coat [prop:umbrella] today")).toBe("umbrella");
  });

  it("names a prop as each form calls it, and leaves the Tessel to its own when it has no such prop", () => {
    // the Tumble firmware lane's table (eye.accessory): party, mask, reading, sun, magnifier
    expect(renderFor(VESSELS.tessel, "neutral", 0, { release: true }).prop).toBe("party");
    expect(renderFor(VESSELS.tessel, "neutral", 0, { weather: "sun" }).prop).toBe("sun");
    expect(renderFor(VESSELS.tessel, "neutral", 0, { tag: "magnifier" }).prop).toBe("magnifier");
    // no hard hat on Tumble: unset (its firmware's auto), never "none"
    expect(renderFor(VESSELS.tessel, "neutral", 0, { building: true }).prop).toBeNull();
  });
});
