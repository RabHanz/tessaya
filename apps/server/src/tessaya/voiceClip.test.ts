import { describe, expect, it } from "vite-plus/test";

import {
  BASIC_CLEAN,
  cloneClipProblem,
  highPass,
  isNearSilence,
  markSynthetic,
  normalise,
  readWav,
  writeWav,
} from "./voiceClip.ts";

const RATE = 24_000;
/** Speech-like: 300 ms syllables of a loud vowel-ish tone, 200 ms gaps of a quiet room. */
const speechy = (seconds: number, { gain = 8_000, floor = 30, gaps = true } = {}) => {
  const samples = new Int16Array(Math.round(seconds * RATE));
  for (let i = 0; i < samples.length; i++) {
    const t = i / RATE;
    const voiced = !gaps || t % 0.5 < 0.3;
    const noise = (((i * 2_654_435_761) >>> 0) / 2 ** 32 - 0.5) * 2 * floor;
    const value =
      (voiced
        ? gain * Math.sin(2 * Math.PI * 180 * t) * Math.sin(Math.PI * ((t % 0.5) / 0.3))
        : 0) + noise;
    // A recorder clips at full scale; an Int16Array would wrap.
    samples[i] = Math.max(-32_768, Math.min(32_767, Math.round(value)));
  }
  return { rate: RATE, samples };
};

describe("a clip for a voice clone", () => {
  it("reads 16-bit WAVs, averaging stereo, and nothing else", () => {
    const mono = speechy(1);
    const back = readWav(writeWav(mono));
    expect(back?.rate).toBe(RATE);
    expect(back?.samples).toEqual(mono.samples);
    const stereo = writeWav({ rate: RATE, samples: Int16Array.from([100, 300, -200, 0]) });
    // Re-label the 4 mono samples as 2 stereo frames.
    const view = new DataView(stereo.buffer);
    view.setUint16(22, 2, true);
    expect(Array.from(readWav(stereo)?.samples ?? [])).toEqual([200, -100]);
    expect(readWav(new TextEncoder().encode("ID3 an mp3 file, not a wav at all.........."))).toBe(
      null,
    );
    const float = writeWav(mono);
    new DataView(float.buffer).setUint16(34, 32, true);
    expect(readWav(float)).toBe(null);
  });

  it("takes 5 to 30 s of clean speech, and says why it refuses anything else", () => {
    expect(cloneClipProblem(speechy(8))).toBe(null);
    expect(cloneClipProblem(speechy(3))).toMatch(/at least 5 seconds/);
    expect(cloneClipProblem(speechy(31))).toMatch(/under 30 seconds/);
    expect(cloneClipProblem(speechy(8, { gain: 40_000 }))).toMatch(/distorted/);
    expect(cloneClipProblem(speechy(8, { gain: 150, floor: 5 }))).toMatch(/too quiet/);
    expect(cloneClipProblem(speechy(8, { floor: 4_000 }))).toMatch(
      /Too noisy: record somewhere quieter/,
    );
    // One short word in 8 s of room tone.
    const word = speechy(8, { gaps: false, gain: 0 });
    word.samples.set(speechy(1, { gaps: false }).samples, RATE);
    expect(cloneClipProblem(word)).toMatch(/under 3 seconds of speech/);
  });

  it("calls Pocket's silent failure silence, and stamps a clone's line as synthetic", () => {
    expect(isNearSilence(speechy(2, { gain: 80, floor: 20 }))).toBe(true);
    expect(isNearSilence(speechy(2))).toBe(false);
    const marked = markSynthetic(writeWav(speechy(1)));
    const tail = new TextDecoder().decode(marked.subarray(-64));
    expect(tail).toContain("INFOICMT");
    expect(tail).toContain("Synthetic speech: a cloned voice");
    expect(new DataView(marked.buffer).getUint32(4, true)).toBe(marked.length - 8);
    expect(readWav(marked)?.samples.length).toBe(RATE);
  });

  it("cleans a reference: pauses trimmed, rumble cut, speech to -20 dBFS", async () => {
    const speech = speechy(6, { gain: 2_000 });
    const padded = new Int16Array(speech.samples.length + 2 * RATE);
    padded.set(speech.samples, RATE);
    // 20 Hz rumble under the whole clip.
    for (let i = 0; i < padded.length; i++)
      padded[i] = padded[i]! + Math.round(1_500 * Math.sin((2 * Math.PI * 20 * i) / RATE));
    const clean = await BASIC_CLEAN.reference({ rate: RATE, samples: padded });
    // About 0.85 s of each silent second trimmed away (150 ms margins kept).
    expect(clean.samples.length / RATE).toBeGreaterThan(6);
    expect(clean.samples.length / RATE).toBeLessThan(6.8);
    const rumble = highPass(
      {
        rate: RATE,
        samples: Int16Array.from(
          { length: RATE },
          (_, i) => 10_000 * Math.sin((2 * Math.PI * 20 * i) / RATE),
        ),
      },
      70,
    );
    expect(Math.max(...rumble.samples.subarray(RATE / 2).map(Math.abs))).toBeLessThan(1_200);
    const loud = normalise(speechy(6, { gain: 500 }));
    let peak = 0;
    for (const s of loud.samples) peak = Math.max(peak, Math.abs(s));
    expect(20 * Math.log10(peak / 32_768)).toBeLessThanOrEqual(-1);
    expect(20 * Math.log10(peak / 32_768)).toBeGreaterThan(-18);
  });
});
