/* oxlint-disable t3code/no-wall-clock-in-tests -- Baton file predating upstream's rule (D82) */
// @effect-diagnostics globalDate:off nodeBuiltinImport:off
/**
 * The capture → core loop, headless: a WAV file is the microphone and a tiny
 * energy segmenter stands in for the voice core, which is another lane's.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { makeWavFileAudioInput } from "./WavFileAudioInput.ts";
import { startVoiceLoop } from "./voiceLoop.ts";
import type { VoiceCore, VoiceState, VoiceUtterance } from "./voiceTypes.ts";
import { VOICE_FRAME_SAMPLES } from "./voiceTypes.ts";

/** 48 kHz stereo 16-bit: what a DJI receiver hands Windows. */
const writeWav = (segments: ReadonlyArray<{ seconds: number; tone: boolean }>): string => {
  const rate = 48_000;
  const channels = 2;
  const samples: number[] = [];
  for (const segment of segments) {
    for (let i = 0; i < segment.seconds * rate; i++) {
      const v = segment.tone ? Math.round(Math.sin((2 * Math.PI * 220 * i) / rate) * 12000) : 0;
      samples.push(v, v);
    }
  }
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((v, i) => data.writeInt16LE(v, i * 2));
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  const path = NodePath.join(NodeOS.tmpdir(), `baton-voice-${process.pid}-${Date.now()}.wav`);
  NodeFS.writeFileSync(path, Buffer.concat([header, data]));
  return path;
};

/** Stand-in core: each burst of sound is one utterance in the current mode. */
const makeEnergyCore = () => {
  const stateListeners = new Set<(s: VoiceState) => void>();
  const utteranceListeners = new Set<(u: VoiceUtterance) => void>();
  let mode: VoiceUtterance["mode"] = "command_window";
  let voiced = 0;
  let frames = 0;
  const core: VoiceCore = {
    pushAudio: (frame) => {
      frames++;
      expect(frame.length).toBe(VOICE_FRAME_SAMPLES);
      const loud = frame.some((v) => Math.abs(v) > 2000);
      if (loud) voiced++;
      else if (voiced > 0) {
        for (const l of utteranceListeners) l({ text: `burst of ${voiced} frames`, mode });
        voiced = 0;
      }
    },
    activate: (activation) => {
      if (activation === "toggle_direct_session") mode = "direct_session";
      for (const l of stateListeners) l(mode);
    },
    onState: (l) => (stateListeners.add(l), () => stateListeners.delete(l)),
    onUtterance: (l) => (utteranceListeners.add(l), () => utteranceListeners.delete(l)),
    dispose: () => {},
  };
  return { core, frames: () => frames };
};

describe("voice loop, WAV file as the microphone", () => {
  it("resamples to 16 kHz frames, segments, and routes each utterance", async () => {
    const path = writeWav([
      { seconds: 0.2, tone: false },
      { seconds: 0.5, tone: true },
      { seconds: 0.3, tone: false },
      { seconds: 0.4, tone: true },
      { seconds: 0.2, tone: false },
    ]);
    const { core, frames } = makeEnergyCore();
    const heard: Array<{ text: string; route: string }> = [];
    const states: VoiceState[] = [];
    const loop = await startVoiceLoop({
      audio: makeWavFileAudioInput([path]),
      core,
      deviceId: null,
      onState: (s) => states.push(s),
      onUtterance: (u, route) => heard.push({ text: u.text, route }),
    });
    // 1.6 s at 16 kHz is 25 600 samples: 80 frames of 320.
    expect(frames()).toBe(80);
    expect(heard.map((h) => h.route)).toEqual(["fabric_intent", "fabric_intent"]);
    // 0.5 s of sound is 25 frames of 20 ms.
    expect(heard[0]?.text).toBe("burst of 25 frames");

    loop.activate("toggle_direct_session");
    await loop.switchDevice(null);
    expect(heard.slice(2).map((h) => h.route)).toEqual(["focused_session", "focused_session"]);
    expect(states.at(-1)).toBe("direct_session");
    await loop.stop();
    NodeFS.rmSync(path);
  });

  it("hard mute: not one frame reaches the core, and waking unmutes", async () => {
    const path = writeWav([
      { seconds: 0.5, tone: true },
      { seconds: 0.1, tone: false },
    ]);
    const { core, frames } = makeEnergyCore();
    const states: VoiceState[] = [];
    const loop = await startVoiceLoop({
      audio: makeWavFileAudioInput([path]),
      core,
      deviceId: null,
      muted: true,
      onState: (s) => states.push(s),
      onUtterance: () => {
        throw new Error("a muted loop routed an utterance");
      },
    });
    expect(frames()).toBe(0);
    expect(states).toEqual(["muted"]);
    loop.activate("wake");
    expect(loop.isMuted()).toBe(false);
    await loop.stop();
    NodeFS.rmSync(path);
  });
});
