import { describe, expect, it } from "vite-plus/test";

import { PILL_BANDS, createBandGain, frameBands } from "./voiceBands.ts";

const tone = (hz: number, amp = 0.5) =>
  Int16Array.from({ length: 320 }, (_, i) =>
    Math.round(amp * 32767 * Math.sin((2 * Math.PI * hz * i) / 16000)),
  );
const loudest = (bands: Float32Array) => bands.indexOf(Math.max(...bands));
let seed = 1;
/** Steady white hiss at about -40 dB, the same every run. */
const hiss = Int16Array.from({ length: 320 }, () => {
  seed = (seed * 1103515245 + 12345) % 2 ** 31;
  return Math.round((seed / 2 ** 31 - 0.5) * 2 * 0.02 * 32767);
});

describe("frameBands", () => {
  it("is zero for silence", () => {
    expect([...frameBands(new Int16Array(320))].every((v) => v === 0)).toBe(true);
  });
  it("puts a tone in the band of its pitch, low to high", () => {
    const low = loudest(frameBands(tone(200)));
    const mid = loudest(frameBands(tone(1000)));
    const high = loudest(frameBands(tone(4000)));
    expect(low).toBeLessThan(mid);
    expect(mid).toBeLessThan(high);
    expect(high).toBe(PILL_BANDS - 1);
    // A half-scale tone reads about half scale in its band.
    expect(Math.max(...frameBands(tone(1000)))).toBeGreaterThan(0.2);
    expect(Math.max(...frameBands(tone(1000)))).toBeLessThan(0.6);
  });
});

describe("createBandGain", () => {
  it("keeps the noise gate: a gated frame is flat and does not teach the peaks", () => {
    const gain = createBandGain();
    const room = frameBands(tone(300, 0.4));
    for (let i = 0; i < 50; i += 1) expect(Math.max(...gain(room, 0))).toBe(0);
    expect(Math.max(...gain(room, Number.NaN))).toBe(0);
    // Speech after the gated room is shown as by a pill that never heard the room.
    const speech = frameBands(tone(300, 0.1));
    expect([...gain(speech, 0.5)]).toEqual([...createBandGain()(speech, 0.5)]);
  });
  it("lifts his quiet high bands to move as much as the loud low ones, never past the gate", () => {
    const gain = createBandGain();
    // A voice tilted 10 to 1, low over high, alternating which part is sounding.
    const lowPart = frameBands(tone(250, 0.5));
    const highPart = frameBands(tone(3500, 0.05));
    let lowShown = gain(lowPart, 0.8);
    let highShown = gain(highPart, 0.8);
    for (let i = 0; i < 20; i += 1) {
      lowShown = gain(lowPart, 0.8);
      highShown = gain(highPart, 0.8);
    }
    expect(highShown[loudest(highPart)]).toBeGreaterThan(0.7);
    expect(lowShown[loudest(lowPart)]).toBeGreaterThan(0.7);
    // Each frame shows its own shape: the sounding band is tall, the other short.
    expect(highShown[loudest(lowPart)]).toBeLessThan(0.4);
    expect(Math.max(...lowShown, ...highShown)).toBeLessThanOrEqual(0.8 + 1e-6);
    // Hiss under his voice is not lifted: the bands only the hiss reaches stay short.
    const hissy = createBandGain();
    const voice = frameBands(Int16Array.from(tone(250, 0.5), (v, i) => v + hiss[i]!));
    let shown = hissy(voice, 0.8);
    for (let i = 0; i < 100; i += 1) shown = hissy(voice, 0.8);
    expect(Math.max(...shown.slice(6))).toBeLessThan(0.4);
  });
  it("shows a first syllable after a pause in its own shape, then hands over to the per-band peaks", () => {
    // Loud low, quiet high: by its own shape the high band is short, by its own peak it is tall.
    const mixed = frameBands(Int16Array.from(tone(250, 0.5), (v, i) => v + tone(3500, 0.05)[i]!));
    const low = loudest(frameBands(tone(250)));
    const high = loudest(frameBands(tone(3500)));
    const gain = createBandGain();
    const shown = Array.from({ length: 20 }, () => gain(mixed, 0.8)[high]!);
    expect(gain(mixed, 0.8)[low]).toBeGreaterThan(0.7);
    // Held for 8 frames, handed over across the next 8, then by its own peak.
    expect(Math.max(...shown.slice(0, 8))).toBeLessThan(0.4);
    for (let i = 8; i < 16; i += 1) expect(shown[i + 1]).toBeGreaterThanOrEqual(shown[i]!);
    expect(shown[16]).toBeGreaterThan(0.7);
    // A gap of 9 gated frames is between syllables; 10 is a pause and starts the shape again.
    for (let i = 0; i < 9; i += 1) gain(mixed, 0);
    expect(gain(mixed, 0.8)[high]).toBeGreaterThan(0.7);
    for (let i = 0; i < 10; i += 1) gain(mixed, 0);
    expect(gain(mixed, 0.8)[high]).toBeLessThan(0.4);
  });
});
