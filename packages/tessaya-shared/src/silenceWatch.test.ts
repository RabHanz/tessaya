import { describe, expect, it } from "vite-plus/test";

import { createSilenceWatch } from "./silenceWatch.ts";
import { frameLevel } from "./voiceTurn.ts";

const S = 1000;
// A live mic in a quiet room peaks well above this; a muted or dead endpoint's dither does not.
const hiss = frameLevel(Int16Array.from({ length: 1280 }, (_, i) => (i % 2 === 0 ? 3 : -3)));

describe("the silent microphone watch", () => {
  it("warns once per quiet episode, and again only after something was heard", () => {
    const w = createSilenceWatch({ seconds: () => 90 });
    w.feed(0, 0);
    expect(w.check(0)).toBeNull();
    w.feed(0, 89 * S);
    expect(w.check(89 * S)).toBeNull();
    expect(w.check(90 * S)).toBe("warn");
    expect(w.check(200 * S)).toBeNull();
    w.feed(0.2, 210 * S);
    expect(w.check(299 * S)).toBeNull();
    expect(w.check(300 * S)).toBe("warn");
  });
  it("counts a dead endpoint's dither as silence", () => {
    const w = createSilenceWatch({ seconds: () => 90 });
    for (let at = 0; at <= 90 * S; at += 10 * S) w.feed(hiss, at);
    expect(w.check(90 * S)).toBe("warn");
  });
  it("warns when the microphone delivers no frames at all", () => {
    const w = createSilenceWatch({ seconds: () => 90 });
    expect(w.check(0)).toBeNull();
    expect(w.check(90 * S)).toBe("warn");
  });
  it("starts the clock again after a reset (a new mic, unmuted)", () => {
    const w = createSilenceWatch({ seconds: () => 90 });
    w.check(0);
    w.reset();
    expect(w.check(60 * S)).toBeNull();
    expect(w.check(149 * S)).toBeNull();
    expect(w.check(150 * S)).toBe("warn");
  });
  it("is off at zero seconds", () => {
    const w = createSilenceWatch({ seconds: () => 0 });
    w.check(0);
    expect(w.check(10_000 * S)).toBeNull();
  });
});
