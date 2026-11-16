import { describe, expect, it } from "vite-plus/test";

import { EMOTIONS, PROP_AT, VESSELS, clipFor, faceFor, renderFor } from "./expressionMap.ts";

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
    const props = new Set<string>(
      Object.values(VESSELS).flatMap((v) => ("props" in v ? v.props : [])),
    );
    const names = new Set<string>([
      ...Object.values(VESSELS).flatMap((v) => ("face" in v ? v.face : [])),
      ...Object.keys(EMOTIONS),
    ]);
    for (const [label, look] of Object.entries(EMOTIONS)) {
      for (const k of look.kin) expect(names, `${label} kin ${k}`).toContain(k);
      for (const p of look.props ?? []) expect(props, `${label} prop ${p}`).toContain(p);
    }
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
