import { describe, expect, it } from "vite-plus/test";

import { parseCue } from "./bodyCues.ts";
import {
  BODY_CAPABILITIES,
  decodeBodyMove,
  extensionActs,
  isPrivateMove,
  moveCues,
  rateGate,
} from "./bodyControl.ts";

const ok = (raw: unknown) => {
  const d = decodeBodyMove(raw);
  if (!d.ok) throw new Error(d.error);
  return d.move;
};

describe("decodeBodyMove", () => {
  it("bounds every number and says how to fix what it can't use", () => {
    expect(ok({ bones: { head: [9, 0, -9] }, ms: 1e9 })).toEqual({
      bones: { head: [Math.PI, 0, -Math.PI] },
      ms: 5000,
    });
    expect(ok({ look: { x: 3, y: -3 } }).look).toEqual({ x: 1, y: -1, ms: 2500 });
    expect(decodeBodyMove({ bones: { tail: [0, 0, 0] } })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/unknown bone tail/),
    });
    expect(decodeBodyMove({ face: { weights: { smirk: 1 } } })).toMatchObject({ ok: false });
    expect(
      decodeBodyMove({
        keys: [
          { atMs: 500, bones: {} },
          { atMs: 100, bones: {} },
        ],
      }),
    ).toMatchObject({ ok: false, error: "keys must be in time order" });
    expect(decodeBodyMove({})).toMatchObject({
      ok: false,
      error: expect.stringMatching(/nothing to do/),
    });
    expect(decodeBodyMove({ then: [{ afterMs: 10, then: [] }] })).toMatchObject({ ok: false });
  });
});

describe("the private gate", () => {
  it("lets everyday moves through and marks private postures, faces and extension acts", () => {
    expect(
      isPrivateMove(
        ok({ act: "wave", mood: { name: "happy" }, then: [{ afterMs: 400, act: "lean" }] }),
      ),
    ).toBe(false);
    expect(isPrivateMove(ok({ act: "wave", then: [{ afterMs: 400, posture: "aroused" }] }))).toBe(
      true,
    );
    expect(isPrivateMove(ok({ mood: { name: "melt", intensity: 1 } }))).toBe(true);
    const ext = ok({ act: "myOwnAct" });
    expect(isPrivateMove(ext)).toBe(true);
    expect(extensionActs(ext)).toEqual(["myOwnAct"]);
    expect(BODY_CAPABILITIES.postures).not.toContain("aroused");
  });
});

describe("moveCues", () => {
  it("turns one intent into coordinated cues every body already reads, later steps on the body's clock", () => {
    const cues = moveCues(
      ok({
        act: "lean",
        mood: { name: "shy", intensity: 0.4 },
        then: [{ afterMs: 600, look: { x: -0.5, y: -0.3 } }],
      }),
    );
    expect(cues.map((c) => c.kind)).toEqual(["act", "mood", "seq"]);
    for (const c of cues) expect(parseCue(c)).toEqual(c);
  });
  it("plays keyframes as a clip and direct bones as a held pose that arrives in ms", () => {
    const [keys] = moveCues(
      ok({
        keys: [
          { atMs: 0, bones: { head: [0, 0, 0] } },
          { atMs: 1000, bones: { head: [0.4, 0, 0] } },
        ],
      }),
    );
    expect(keys).toMatchObject({ kind: "clip", fps: 30, loop: false });
    const frames = keys?.kind === "clip" ? keys.frames : [];
    expect(frames).toHaveLength(31);
    expect(frames[15]!.head![0]).toBeCloseTo(0.2, 1);
    const [held] = moveCues(ok({ bones: { leftUpperArm: [0, 0, -0.5] }, ms: 900 }));
    expect(parseCue(held)).toMatchObject({
      kind: "clip",
      frames: [{ leftUpperArm: [0, 0, -0.5] }],
      ms: 900,
    });
  });
});

describe("rateGate", () => {
  it("allows a burst, then one move a quarter second, per caller", () => {
    let s;
    let allowed = 0;
    for (let i = 0; i < 20; i++) {
      const r = rateGate(s, 1000);
      s = r.state;
      if (r.ok) allowed++;
    }
    expect(allowed).toBe(12);
    const blocked = rateGate(s, 1000);
    expect(blocked).toMatchObject({ ok: false, retryMs: 250 });
    expect(rateGate(blocked.state, 1250).ok).toBe(true);
  });
});
