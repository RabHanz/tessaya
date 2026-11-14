// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { createVoiceCore, type VoiceCoreEvent } from "@t3tools/tessaya-voice";

import {
  makeTestAudioInput,
  parseTestScript,
  testAudioItems,
  type TestAudioEvent,
} from "./testAudio.ts";
import { startVoiceLoop } from "./voiceLoop.ts";

/** A 16 kHz mono 16-bit WAV of `ms` milliseconds, every sample `value`. */
const wav = (ms: number, value: number): Buffer => {
  const samples = (16_000 * ms) / 1000;
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) data.writeInt16LE(value, i * 2);
  const head = Buffer.alloc(44);
  head.write("RIFF", 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write("WAVEfmt ", 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(16_000, 24);
  head.writeUInt32LE(32_000, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36);
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
};

const folder = () => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "test-audio-"));

describe("the test microphone's script", () => {
  it("reads a listing: paths, a gap after one, a bare silence, comments", () => {
    expect(parseTestScript("# wake\nwake.wav 1500\n\n800\nother.wav # again\n", "/d")).toEqual([
      { kind: "wav", path: "/d/wake.wav" },
      { kind: "silence", ms: 1500 },
      { kind: "silence", ms: 800 },
      { kind: "wav", path: "/d/other.wav" },
    ]);
  });
  it("plays a folder's WAV files by name", () => {
    const dir = folder();
    NodeFS.writeFileSync(NodePath.join(dir, "b.wav"), wav(40, 0));
    NodeFS.writeFileSync(NodePath.join(dir, "a.wav"), wav(40, 0));
    NodeFS.writeFileSync(NodePath.join(dir, "notes.txt"), "x");
    expect(
      testAudioItems(dir).map((i) => (i.kind === "wav" ? NodePath.basename(i.path) : "")),
    ).toEqual(["a.wav", "b.wav"]);
  });
});

describe("the voice loop on recorded files", () => {
  const WAKE = 12_345;
  const rig = async (files: ReadonlyArray<[string, number]>) => {
    const dir = folder();
    for (const [name, value] of files)
      NodeFS.writeFileSync(NodePath.join(dir, name), wav(400, value));
    const markers: TestAudioEvent[] = [];
    const events: VoiceCoreEvent[] = [];
    let frames = 0;
    let inPhrase = false;
    let release!: () => void;
    const ended = new Promise<void>((resolve) => (release = resolve));
    const core = createVoiceCore({
      waitMs: () => 0,
      // Stands for the wake scorer: the phrase is a file whose samples carry this value.
      wake: {
        name: "fake",
        reset: () => {},
        process: (frame) => {
          const hit = frame[0] === WAKE && !inPhrase;
          inPhrase = frame[0] === WAKE;
          return hit ? 1 : null;
        },
      },
      vad: { name: "fake", reset: () => {}, isSpeech: () => false },
      stt: { name: "fake", transcribe: async () => "" },
    });
    core.subscribe((event) => events.push(event));
    const audio = makeTestAudioInput({
      source: dir,
      onEvent: (event) => {
        markers.push(event);
        if (event.type === "end") release();
      },
      // Immediate, but after the silence tail has run a little the test stops it.
      pace: () => async () => {
        frames += 1;
        if (frames > 10_000) throw new Error("ran away");
        await Promise.resolve();
      },
    });
    const loop = await startVoiceLoop({
      audio,
      core,
      deviceId: null,
      onState: () => {},
      onUtterance: () => {},
    });
    await ended;
    await loop.stop();
    return { markers, events };
  };

  it("wakes on the file that has the wake phrase and not on the one that has none, in order", async () => {
    const { markers, events } = await rig([
      ["1-nothing.wav", 0],
      ["2-wake.wav", WAKE],
    ]);
    expect(markers.map((m) => m.type)).toEqual(["start", "file", "file", "end"]);
    expect(
      markers
        .filter((m) => m.type === "file")
        .map((m) => NodePath.basename((m as { path: string }).path)),
    ).toEqual(["1-nothing.wav", "2-wake.wav"]);
    expect(events.filter((e) => e.type === "wake")).toHaveLength(1);
  });

  it("does not wake on files with no phrase", async () => {
    const { events } = await rig([["1-nothing.wav", 0]]);
    expect(events.some((e) => e.type === "wake")).toBe(false);
  });
});
