import { describe, expect, it } from "vite-plus/test";

import { parseCue } from "./bodyCues.ts";
import {
  CORE_SCENES,
  decodeScene,
  dryRun,
  fromViewerAxes,
  isPrivateScene,
  sceneCues,
} from "./bodyScene.ts";
import { REFERENCE_RIG } from "./bodyRig.ts";

describe("body scenes", () => {
  it("decodes every core scene, plays it on the body's clock, and needs no correction on a reference body", () => {
    for (const raw of Object.values(CORE_SCENES)) {
      const d = decodeScene(raw);
      if (!d.ok) throw new Error(JSON.stringify(d.errors));
      expect(isPrivateScene(d.scene)).toBe(false);
      const cues = sceneCues(d.scene);
      for (const c of cues) expect(parseCue(c)).toEqual(c);
      expect(
        dryRun(d.scene, REFERENCE_RIG).filter((b) => b.corrected.some((i) => i.kind !== "twist")),
      ).toEqual([]);
    }
  });

  it("teaches: each error says where it is and how to fix it", () => {
    const d = decodeScene({
      version: 2,
      id: "Bad Id",
      beats: [
        { atMs: 500, move: { act: "wave" } },
        { atMs: 200, move: { bones: { tail: [0, 0, 0] } } },
        { move: {} },
      ],
    });
    expect(d.ok).toBe(false);
    if (d.ok) return;
    expect(d.errors.map((e) => e.at)).toEqual([
      "version",
      "id",
      "beats[1].atMs",
      "beats[1].move",
      "beats[2].atMs",
    ]);
    for (const e of d.errors) expect(e.fix.length).toBeGreaterThan(5);
  });

  it("migrates the standalone viewer's beats into a scene in the body's axes, and says what it dropped", () => {
    const d = decodeScene([
      {
        name: "Greeting",
        pose: { rightUpperArm: [0.1, 0, -1.2] },
        expression: { happy: 0.6 },
        speak: "hello",
        duration: 2500,
      },
      { name: "Shy", gaze: [0.2, -0.15], duration: 2000 },
    ]);
    if (!d.ok) throw new Error(JSON.stringify(d.errors));
    expect(d.notes).toEqual(["speak dropped"]);
    expect(d.scene.beats.map((b) => b.atMs)).toEqual([0, 2500]);
    expect(d.scene.beats[0]!.move.bones).toEqual({ rightUpperArm: [-0.1, 0, 1.2] });
    expect(d.scene.beats[1]!.move.look).toMatchObject({ x: 0.5, y: -0.5 });
    expect(fromViewerAxes("leftLowerLeg", [1.2, 0, 0.1])).toEqual([1.2, 0, -0.1]);
  });

  it("reports what a dry run had to correct, beat by beat", () => {
    const d = decodeScene({
      version: 1,
      id: "knees",
      beats: [{ atMs: 0, label: "bad knee", move: { bones: { leftLowerLeg: [-0.8, 0, 0] } } }],
    });
    if (!d.ok) throw new Error(JSON.stringify(d.errors));
    expect(dryRun(d.scene, REFERENCE_RIG)[0]).toMatchObject({
      at: "beats[0]",
      label: "bad knee",
      corrected: [{ bone: "leftLowerLeg", kind: "reversal" }],
    });
  });
});
