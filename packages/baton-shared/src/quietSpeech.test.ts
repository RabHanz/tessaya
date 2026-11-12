import { describe, expect, it } from "vite-plus/test";

import {
  boostCore,
  createQuietBoost,
  inSpeechSetup,
  quietThreshold,
  silenceWhile,
} from "./quietSpeech.ts";

const tone = (amplitude: number, n = 320) =>
  Int16Array.from({ length: n }, (_, i) => Math.round(amplitude * Math.sin(i / 3)));
const rmsOf = (f: Int16Array) => Math.sqrt(f.reduce((s, v) => s + (v / 32768) ** 2, 0) / f.length);

describe("quiet-speech mode", () => {
  it("lowers each wake threshold, never under the floor", () => {
    expect(quietThreshold(0.9)).toBeCloseTo(0.7);
    expect(quietThreshold(0.6)).toBe(0.5);
    expect(quietThreshold(0.3)).toBe(0.5);
  });

  it("lifts a whisper towards a speaking level, by at most 18 dB", () => {
    const boost = createQuietBoost();
    const whisper = tone(300);
    let out: Int16Array = whisper;
    for (let i = 0; i < 20; i += 1) out = boost(whisper);
    expect(rmsOf(out) / rmsOf(whisper)).toBeGreaterThan(3);
    expect(rmsOf(out) / rmsOf(whisper)).toBeLessThanOrEqual(8.05);
  });

  it("leaves silence and room tone alone, and does not lift speech that is already loud", () => {
    const boost = createQuietBoost();
    const silence = new Int16Array(320);
    const roomTone = tone(40);
    const loud = tone(9000);
    for (let i = 0; i < 20; i += 1) {
      expect(boost(silence)).toBe(silence);
      expect(boost(roomTone)).toBe(roomTone);
    }
    expect(boost(loud)).toBe(loud);
  });

  it("is a core that lifts audio only while it is on", () => {
    const heard: number[] = [];
    let on = false;
    const core = boostCore(
      { pushAudio: (f: Int16Array) => void heard.push(rmsOf(f)), name: () => "kept" },
      () => on,
    );
    const whisper = tone(300);
    core.pushAudio(whisper);
    on = true;
    for (let i = 0; i < 10; i += 1) core.pushAudio(whisper);
    expect(heard[0]).toBeCloseTo(rmsOf(whisper));
    expect(heard.at(-1)!).toBeGreaterThan(heard[0]! * 3);
    expect(core.name()).toBe("kept");
  });
});

describe("silence while the dictation key records", () => {
  it("passes silence while on, decided as each frame arrives, and keeps the rest of the core", () => {
    const heard: number[] = [];
    let on = true;
    const core = silenceWhile(
      { pushAudio: (f: Int16Array) => void heard.push(rmsOf(f)), name: () => "kept" },
      () => on,
    );
    core.pushAudio(tone(300));
    on = false;
    core.pushAudio(tone(300));
    expect(heard[0]).toBe(0);
    expect(heard[1]).toBeGreaterThan(0);
    expect(core.name()).toBe("kept");
  });
});

it("keeps her deaf through every speech setup, and hearing once none is under way", () => {
  const none = { recording: false, reading: false, micTest: false };
  expect(inSpeechSetup(none)).toBe(false);
  for (const setup of ["recording", "reading", "micTest"] as const)
    expect(inSpeechSetup({ ...none, [setup]: true })).toBe(true);
});
