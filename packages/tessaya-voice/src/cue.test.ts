import { describe, expect, it } from "vite-plus/test";

import { createVoiceCore, type VoiceCoreEvent } from "./core.ts";
import { VOICE_FRAME_SAMPLES, VOICE_SAMPLE_RATE } from "./types.ts";

/** A stand-in for Baton's cue: a loud tone. The wake and speech detectors below fire on any sound at all. */
const tone = (frames: number): Int16Array[] =>
  Array.from({ length: frames }, (_, f) =>
    Int16Array.from({ length: VOICE_FRAME_SAMPLES }, (_, i) =>
      Math.round(
        9000 * Math.sin((2 * Math.PI * 523 * (f * VOICE_FRAME_SAMPLES + i)) / VOICE_SAMPLE_RATE),
      ),
    ),
  );
const loud = (frame: Int16Array) => frame.some((v) => Math.abs(v) > 500);

const makeCore = () => {
  const events: VoiceCoreEvent[] = [];
  const core = createVoiceCore({
    wake: { name: "any-sound", process: (f) => (loud(f) ? 1 : null), reset: () => {} },
    vad: { name: "any-sound", isSpeech: loud, reset: () => {} },
    stt: { name: "none", transcribe: async () => "" },
    origin: 0,
  });
  core.subscribe((e) => events.push(e));
  return { core, events };
};
const feed = (core: ReturnType<typeof makeCore>["core"], frames: Int16Array[]) =>
  frames.forEach((f) => core.pushAudio(f));
const frames = (ms: number) => Math.ceil((ms * VOICE_SAMPLE_RATE) / 1000 / VOICE_FRAME_SAMPLES);

describe("a cue is not heard", () => {
  it("is heard when nothing gates it (the control)", () => {
    const { core, events } = makeCore();
    feed(core, tone(frames(250)));
    expect(events.some((e) => e.type === "wake")).toBe(true);
  });

  it("neither wakes the wake word nor reaches a dictation capture while its window is gated", async () => {
    const { core, events } = makeCore();
    await core.hear("Jarvis");
    await core.hear("dictate");
    expect(core.snapshot().state).toBe("dictation");
    events.length = 0;
    core.playingCue(250 + 150);
    feed(core, tone(frames(250 + 150)));
    expect(
      events.filter((e) => e.type === "wake" || e.type === "audio" || e.type === "speech_end"),
    ).toEqual([]);
    expect(core.hearingSpeech()).toBe(false);
    // After the window the same sound is heard again: only the window is gated.
    feed(core, tone(frames(100)));
    expect(core.hearingSpeech()).toBe(true);
  });
});

describe("dictation owns everything said during it", () => {
  it("does not wake while dictating by voice, but still hears the words", async () => {
    const { core, events } = makeCore();
    await core.hear("Jarvis, dictate");
    expect(core.snapshot().state).toBe("dictation");
    events.length = 0;
    feed(core, tone(frames(250)));
    expect(events.some((e) => e.type === "wake")).toBe(false);
    expect(core.hearingSpeech()).toBe(true);
  });
});
