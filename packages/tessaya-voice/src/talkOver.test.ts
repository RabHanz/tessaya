import { describe, expect, it } from "vite-plus/test";

import { rng, speechLike } from "./echoSim.ts";
import { createTalkOver } from "./talkOver.ts";

const i16 = (f: Float32Array, gain: number) =>
  Int16Array.from(f, (v) => Math.round(v * gain * 32768));

describe("talking over her", () => {
  it("keeps the room it learned across sessions, ignores her echo and hears him over it", () => {
    const her = i16(speechLike(4, 1, 200), 1);
    const him = i16(speechLike(1.5, 9, 120), 0.3);
    const talk = createTalkOver({ searchMs: 96 });
    const session = (withHim: boolean) => {
      let heard = false;
      for (let at = 0; at + 960 <= her.length; at += 960) {
        const mic = new Int16Array(960);
        for (let i = 0; i < 960; i += 1) {
          const e = at + i - 400;
          mic[i] =
            (e >= 0 ? her[e]! * 0.03 : 0) +
            (withHim && at >= 32_000 ? (him[at + i - 32_000] ?? 0) : 0);
        }
        talk.reference(her.subarray(at, at + 960), at);
        if (talk.process(mic, at).some((v) => v.ready && v.speech) && at >= 16_000) heard = true;
      }
      return heard;
    };
    expect(session(false)).toBe(false);
    // The next session counts its frames from zero again: the learned room still holds.
    expect(talk.state().learned).toBeGreaterThan(60);
    expect(session(true)).toBe(true);
    expect(session(false)).toBe(false);
  });

  it("hears him over her on headphones, where none of her comes back", () => {
    const her = i16(speechLike(4, 1, 200), 1);
    const him = i16(speechLike(1.5, 9, 120), 0.3);
    const hiss = rng(5);
    const session = (withHim: boolean) => {
      const talk = createTalkOver({ searchMs: 96 });
      let first: number | null = null;
      for (let at = 0; at + 960 <= her.length; at += 960) {
        const mic = new Int16Array(960);
        for (let i = 0; i < 960; i += 1)
          mic[i] =
            Math.round((hiss() - 0.5) * 20) +
            (withHim && at >= 32_000 ? (him[at + i - 32_000] ?? 0) : 0);
        talk.reference(her.subarray(at, at + 960), at);
        if (talk.process(mic, at).some((v) => v.ready && v.speech) && first === null) first = at;
      }
      return first;
    };
    expect(session(false)).toBeNull();
    // Within half a second of his first word.
    expect(session(true)).toBeGreaterThanOrEqual(32_000);
    expect(session(true)!).toBeLessThan(32_000 + 8_000);
  });
});
