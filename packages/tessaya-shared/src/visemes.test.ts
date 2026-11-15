import { describe, expect, it } from "vite-plus/test";

import {
  alignVisemes,
  createVisemeTrack,
  holdClosures,
  speechUnits,
  visemeAt,
  wordUnits,
  type SoundFrame,
} from "./visemes.ts";

const run = (n: number, rms: number, zcr = 0.06): SoundFrame[] =>
  Array.from({ length: n }, () => ({ rms, zcr }));
const silence = (n: number) => run(n, 0.0001, 0.01);
const vowel = (n: number) => run(n, 0.3, 0.07);
const hiss = (n: number) => run(n, 0.03, 0.45);

describe("the mouth shapes a word asks for", () => {
  it.each([
    // the lips close for M, B and P, and the e of "maybe" is said, not silent
    ["maybe", ["mbp", "aa", "ee", "mbp", "ee"]],
    ["Bob", ["mbp", "oh", "mbp"]],
    // a silent e after one vowel and one consonant
    ["five", ["fv", "ee", "fv"]],
    ["thin", ["th", "ee", "etc"]],
    // a soft c is an s, a silent gh and k say nothing
    ["nice", ["etc", "ee", "etc"]],
    ["know", ["etc", "oh", "oo"]],
    ["wow", ["oo", "oh", "oo"]],
    // hums keep the lips shut however long they last: as written, and as the voice is given them
    ["Mmm,", ["mbp"]],
    ["Hmm", ["mbp"]],
    ["Mhm", ["mbp"]],
    ["Umm", ["uh", "mbp"]],
  ])("%s", (word, visemes) => {
    expect(wordUnits(word).map((u) => u.viseme)).toEqual(visemes);
  });

  it("puts a pause between words, one costly to leave out at a full stop", () => {
    const pauses = speechUnits("Oh, wow. Bob").filter((u) => u.kind === "P");
    expect(pauses.map((u) => u.skip)).toEqual([0, 3, 8, 0]);
  });
});

describe("when each shape happens, from the sound", () => {
  it("closes the lips in the silence between two vowels, and opens them for each vowel", () => {
    // "Bob": a closure, a vowel, a closure
    const frames = [...silence(10), ...vowel(20), ...silence(6), ...vowel(20), ...silence(10)];
    const track = alignVisemes(speechUnits("ah bob"), frames, true);
    expect(visemeAt(track, 150)).toBe("aa");
    expect(visemeAt(track, 350)).toBe("mbp");
    expect(visemeAt(track, 450)).toBe("oh");
  });

  it("puts a hiss on the S and a sentence's end on its long silence", () => {
    const frames = [
      ...silence(5),
      ...vowel(15),
      ...hiss(10),
      ...silence(40),
      ...vowel(25),
      ...silence(5),
    ];
    const track = alignVisemes(speechUnits("ass. oh"), frames, true);
    expect(visemeAt(track, 250)).toBe("etc");
    expect(visemeAt(track, 450)).toBe("rest");
    expect(visemeAt(track, 800)).toBe("oh");
  });

  it("holds closed lips long enough to see, taking the time from the shape before", () => {
    const held = holdClosures([
      { at: 0, end: 200, viseme: "aa" },
      { at: 200, end: 220, viseme: "mbp" },
      { at: 220, end: 400, viseme: "oh" },
    ]);
    expect(held).toEqual([
      { at: 0, end: 140, viseme: "aa" },
      { at: 140, end: 220, viseme: "mbp" },
      { at: 220, end: 400, viseme: "oh" },
    ]);
  });
});

describe("a sentence's shapes as its audio streams in", () => {
  const samples = (frames: SoundFrame[], rate: number) => {
    const step = (rate * 10) / 1000;
    const out = new Int16Array(frames.length * step);
    frames.forEach((f, i) => {
      // a square wave at the frame's level, crossing zero at the frame's rate
      const half = Math.max(1, Math.round(1 / (2 * f.zcr)));
      for (let k = 0; k < step; k++)
        out[i * step + k] = (Math.floor(k / half) % 2 === 0 ? 1 : -1) * f.rms * 32767;
    });
    return out;
  };

  it("keeps the lips shut through a hum from its first frame, before the rest of the line has arrived", () => {
    const rate = 16_000;
    const pcm = samples(
      [...silence(10), ...run(150, 0.3, 0.015), ...vowel(20), ...silence(10)],
      rate,
    );
    const track = createVisemeTrack("Mmm, ah", rate);
    // 300 ms arrived: 200 ms of hum, and nothing of what follows it
    track.push(pcm.subarray(0, rate * 0.3));
    expect(track.at(30)).toBe("rest");
    for (const ms of [110, 200, 280]) expect(track.at(ms)).toBe("mbp");
  });

  it("says nothing until the sound is far enough ahead to trust, and everything once it ends", () => {
    const rate = 16_000;
    const pcm = samples(
      [...silence(10), ...vowel(20), ...silence(6), ...vowel(20), ...silence(10)],
      rate,
    );
    const track = createVisemeTrack("ah bob", rate);
    track.push(pcm.subarray(0, rate * 0.25));
    expect(track.at(50)).toBe("rest");
    // 250 ms arrived: the last 150 ms is not trusted yet
    expect(track.at(150)).toBeUndefined();
    track.push(pcm.subarray(rate * 0.25));
    track.end();
    // the lips close ahead of the closure, and the rounding shows before its vowel but never over the closure
    expect(track.at(270)).toBe("mbp");
    expect(track.at(310)).toBe("mbp");
    expect(track.at(345)).toBe("oh");
    expect(track.at(450)).toBe("oh");
  });
});
