import { beforeEach, expect, it, vi } from "vite-plus/test";

const audio = vi.hoisted(() => {
  const listeners = new Set<(event: { pcm: string }) => void>();
  return {
    listeners,
    start: vi.fn(async () => ({})),
    setMic: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    addListener: (_event: string, listener: (event: { pcm: string }) => void) => {
      listeners.add(listener);
      return { remove: () => listeners.delete(listener) };
    },
    emit: (samples: ReadonlyArray<number>) => {
      const pcm = btoa(String.fromCharCode(...new Uint8Array(new Int16Array(samples).buffer)));
      for (const listener of listeners) listener({ pcm });
    },
  };
});
const stream = vi.hoisted(() => ({
  fed: [] as number[][],
  onText: null as null | ((text: { committed: string; tentative: string }) => void),
  finish: vi.fn(async () => "approve the plan"),
}));

vi.mock("../../../modules/t3-phone-audio", () => ({ PhoneAudio: audio }));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "id" }));
vi.mock("expo-file-system", () => ({
  Paths: { cache: "file:///cache" },
  File: class {
    readonly uri: string;
    constructor(dir: string, name: string) {
      this.uri = `${dir}/${name}`;
    }
  },
}));
vi.mock("@t3tools/client-runtime/voice-input", () => ({
  openSpeechStream: (input: {
    onText: (text: { committed: string; tentative: string }) => void;
  }) => {
    stream.onText = input.onText;
    return {
      feed: (pcm: Float32Array) => stream.fed.push([...pcm]),
      finish: stream.finish,
    };
  },
}));

import { holdPhoneAudio } from "../../lib/phoneAudioHold";
import { getLiveWords } from "./liveWords";
import {
  createLiveRecorder,
  liveCaptureAvailable,
  liveRecording,
  streamLiveCapture,
} from "./liveCapture";

beforeEach(() => {
  stream.fed = [];
  stream.finish.mockClear();
});

const options = (url = async () => "wss://box/speech") => ({
  url,
  signal: new AbortController().signal,
  canSend: () => true,
});

it("streams what was heard before and after the socket opened, then the server's final words", async () => {
  const recorder = createLiveRecorder();
  await recorder.prepareToRecordAsync();
  recorder.record({ forDuration: 300 });
  audio.emit([16384]);
  const live = streamLiveCapture(options());
  await Promise.resolve();
  await Promise.resolve();
  audio.emit([-16384]);
  stream.onText?.({ committed: "approve", tentative: "the" });
  expect(getLiveWords()).toEqual({ committed: "approve", tentative: "the" });
  await recorder.stop();
  await expect(live).resolves.toBe("approve the plan");
  expect(stream.fed).toEqual([[0.5], [-0.5]]);
  expect(audio.setMic).toHaveBeenLastCalledWith(false);
  // The recording stays for the upload fallback, as PCM16.
  expect([...new Int16Array(liveRecording(recorder.uri!)!.buffer)]).toEqual([16384, -16384]);
});

it("leaves the recording to the upload when the stream cannot open", async () => {
  const recorder = createLiveRecorder();
  await recorder.prepareToRecordAsync();
  recorder.record({ forDuration: 300 });
  const live = streamLiveCapture(
    options(async () => {
      throw new Error("no ticket");
    }),
  );
  await recorder.stop();
  await expect(live).resolves.toBeNull();
  expect(stream.finish).not.toHaveBeenCalled();
});

it("keeps off the audio module while a Sleeve's or Tessel's link holds it", () => {
  expect(liveCaptureAvailable()).toBe(true);
  const release = holdPhoneAudio();
  expect(liveCaptureAvailable()).toBe(false);
  release();
  expect(liveCaptureAvailable()).toBe(true);
});
