import { describe, expect, it } from "vite-plus/test";

import { makeMotionReader, type Accel } from "./sleeveMotion.ts";

const FLAT: Accel = { x: 0, y: 0, z: -1 };
const MOVE: Accel = { x: 0.3, y: -0.4, z: -0.6 };
const FACING: Accel = { x: 0, y: -0.85, z: -0.5 };
const DOWN: Accel = { x: 0, y: 0, z: 1 };

/** Samples every 100 ms from `from`; the moments they brought, in order. */
const run = (read: ReturnType<typeof makeMotionReader>, steps: ReadonlyArray<[Accel, number]>) => {
  let t = 0;
  const out: string[] = [];
  for (const [a, n] of steps)
    for (let i = 0; i < n; i++) {
      const m = read(a, (t += 100));
      if (m !== null) out.push(m);
    }
  return out;
};

describe("a Sleeve's motion", () => {
  it("is picked up and raised to him: lifted, then raised", () => {
    expect(
      run(makeMotionReader(), [
        [FLAT, 25],
        [MOVE, 3],
        [FACING, 5],
      ]),
    ).toEqual(["lifted", "raised"]);
  });

  it("is not raised when it was never at rest, or comes up too late", () => {
    expect(
      run(makeMotionReader(), [
        [FLAT, 5],
        [MOVE, 3],
        [FACING, 5],
      ]),
    ).toEqual([]);
    expect(
      run(makeMotionReader(), [
        [FLAT, 25],
        [MOVE, 3],
        [FLAT, 20],
        [FACING, 5],
      ]),
    ).toEqual(["lifted"]);
  });

  it("is put face down once, and turned back up once", () => {
    expect(
      run(makeMotionReader(), [
        [FLAT, 25],
        [DOWN, 20],
        [FLAT, 5],
      ]),
    ).toEqual(["facedown", "faceup"]);
  });

  it("is shaken by three hard jolts within a second", () => {
    const jolt: Accel = { x: 2.6, y: 0, z: -1 };
    expect(
      run(makeMotionReader(), [
        [jolt, 1],
        [FLAT, 1],
        [jolt, 1],
        [FLAT, 1],
        [jolt, 1],
      ]),
    ).toContain("shaken");
  });
});
