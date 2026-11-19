import { describe, expect, it } from "vite-plus/test";

import { parseCue } from "./bodyCues.ts";
import {
  branchFor,
  CORE_SCENES,
  decodeScene,
  decodeScenePack,
  poseAt,
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
      version: 3,
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
  it("reads version 1 as version 2 and sends a story to where stories play", () => {
    const v1 = decodeScene({ version: 1, id: "wave", beats: [{ atMs: 0, move: { act: "wave" } }] });
    if (!v1.ok) throw new Error(JSON.stringify(v1.errors));
    expect([v1.scene.version, v1.scene.bodies, v1.scene.branches]).toEqual([2, ["her"], []]);
    const story = decodeScene({
      id: "cafe",
      title: "Cafe",
      beats: [{ id: "b1", message: { kind: "story", text: "Rain." } }],
    });
    expect(story.ok ? null : story.errors[0]!.fix).toMatch(/story/);
  });

  it("moves two bodies, each on its own beats, and branches on a touch, words, a feeling or a story flag", () => {
    const d = decodeScene({
      version: 2,
      id: "duet",
      bodies: ["her", "guest"],
      beats: [
        { atMs: 0, move: { act: "wave" } },
        { atMs: 0, body: "guest", move: { act: "bow" } },
        { atMs: 1000, move: { act: "nod" } },
      ],
      branches: [
        {
          id: "pat",
          on: { touch: { part: "head", kind: "pat" } },
          beats: [{ atMs: 0, move: { gesture: "giggleOnce" } }],
        },
        {
          id: "dance",
          on: { speech: { says: ["dance"] } },
          beats: [{ atMs: 0, move: { act: "dance" } }],
          after: "end",
        },
        {
          id: "warm",
          on: { affect: { feeling: "valence", above: 0.5 } },
          beats: [{ atMs: 0, move: { act: "hug" } }],
          once: false,
        },
        { id: "dark", on: { flag: "lights-off" }, beats: [{ atMs: 0, move: { act: "sit" } }] },
      ],
    });
    if (!d.ok) throw new Error(JSON.stringify(d.errors));
    expect(sceneCues(d.scene).map((c) => c.kind)).toEqual(["act", "seq"]);
    expect(sceneCues(d.scene, "guest")).toEqual([{ kind: "act", act: "bow" }]);
    const fired = new Set(["pat"]);
    expect(branchFor(d.scene, { touch: { part: "head", kind: "pat" } })?.id).toBe("pat");
    expect(branchFor(d.scene, { touch: { part: "head", kind: "pat" } }, fired)).toBeNull();
    expect(branchFor(d.scene, { speech: "Will you DANCE for me?" })?.after).toBe("end");
    expect(branchFor(d.scene, { speech: "a dancer" })).toBeNull();
    expect(branchFor(d.scene, { affect: { valence: 0.7 } }, new Set(["warm"]))?.id).toBe("warm");
    expect(branchFor(d.scene, { flag: "lights-off" })?.id).toBe("dark");
  });

  it("teaches branches and bodies too", () => {
    const d = decodeScene({
      version: 2,
      id: "bad",
      bodies: ["her"],
      beats: [{ atMs: 0, body: "guest", move: { act: "wave" } }],
      branches: [
        { id: "x", on: { touch: {}, flag: "a" }, beats: [] },
        { id: "y", on: { affect: { feeling: "joy" } }, beats: [{ atMs: 0, move: {} }] },
      ],
    });
    expect(d.ok ? [] : d.errors.map((e) => e.at)).toEqual([
      "beats[0].body",
      "branches[0].on",
      "branches[0].beats",
      "branches[1].on.affect.feeling",
      "branches[1].on.affect",
      "branches[1].beats[0].move",
    ]);
  });

  it("loads a pack scene by scene, private as a whole when the pack is", () => {
    const p = decodeScenePack({
      pack: "everyday",
      private: true,
      scenes: [
        CORE_SCENES["greeting"],
        { version: 2, id: "x", beats: [] },
        CORE_SCENES["greeting"],
      ],
    });
    expect(p.scenes.map((s) => [s.id, s.pack, s.private])).toEqual([
      ["greeting", "everyday", true],
    ]);
    expect(p.errors.map((e) => e.at)).toEqual(["scenes[1].beats", "scenes[2].id"]);
    expect(isPrivateScene(p.scenes[0]!)).toBe(true);
  });

  it("scrubs smoothly: between two posed beats a joint is part way along the turn", () => {
    const d = decodeScene({
      version: 2,
      id: "arm",
      beats: [
        { atMs: 0, move: { bones: { leftUpperArm: [0, 0, 0] } } },
        { atMs: 1000, move: { bones: { leftUpperArm: [0, 0, 1] } } },
        { atMs: 1500, move: { act: "nod" } },
      ],
    });
    if (!d.ok) throw new Error(JSON.stringify(d.errors));
    expect(poseAt(d.scene, 500).bones["leftUpperArm"]![2]).toBeCloseTo(0.5, 3);
    expect(poseAt(d.scene, 1600)).toMatchObject({ beat: 2, bones: { leftUpperArm: [0, 0, 1] } });
  });
});
