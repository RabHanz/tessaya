/**
 * Dictation whose words appear as he speaks: the audio module already in the build (T3PhoneAudio, the Sleeve's and the
 * Tessels') records, so each 60 ms frame reaches the server's speech stream while he talks. The recording stays in
 * memory, so a stream that fails still transcribes it the old way.
 */
import { DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS } from "@t3tools/contracts";
import { openSpeechStream } from "@t3tools/client-runtime/voice-input";
import type { RecorderState, RecordingStatus } from "expo-audio";
import { File, Paths } from "expo-file-system";

import { PhoneAudio } from "../../../modules/t3-phone-audio";
import { uuidv4 } from "../../lib/uuid";
import { phoneAudioHeld } from "../../lib/phoneAudioHold";
import type { NativeVoiceRecorder } from "./lazyVoiceRecorder";
import { setLiveWords } from "./liveWords";

type Capture = {
  readonly uri: string;
  readonly frames: Int16Array[];
  readonly listeners: Set<(pcm: Int16Array) => void>;
  readonly ended: PromiseWithResolvers<void>;
};
let capture: Capture | null = null;

/** Live capture needs the module and nobody else holding it (a Sleeve's or a Tessel's link). */
// A module that failed to start (an old build's, a busy route) is not tried again this launch: the next press records the old way.
let broken = false;
export const liveCaptureAvailable = (): boolean =>
  PhoneAudio !== null && !broken && !phoneAudioHeld();

const decodeBase64 = (b64: string) => {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return new Int16Array(bytes.buffer, 0, bytes.byteLength >> 1);
};
const toFloat = (pcm: Int16Array) => {
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i]! / 32768;
  return out;
};
const joined = (frames: ReadonlyArray<Int16Array>) => {
  const out = new Int16Array(frames.reduce((n, f) => n + f.length, 0));
  let at = 0;
  for (const f of frames) {
    out.set(f, at);
    at += f.length;
  }
  return out;
};

/** The recording a live capture kept, as 16 kHz PCM16 bytes, for the upload fallback; null for any other file. */
export const liveRecording = (uri: string): Uint8Array | null =>
  capture?.uri === uri ? new Uint8Array(joined(capture.frames).buffer) : null;

/** A recorder over T3PhoneAudio with the shape the lazy recorder drives. */
export function createLiveRecorder(): NativeVoiceRecorder<RecordingStatus, RecorderState> {
  const audio = PhoneAudio!;
  const statusListeners = new Set<(status: RecordingStatus) => void>();
  let mine: Capture | null = null;
  let startedAt = 0;
  let recording = false;
  let metering = -160;
  let limit: ReturnType<typeof setTimeout> | null = null;
  let frameSub: { remove(): void } | null = null;

  const finish = async (status: Partial<RecordingStatus>) => {
    if (!recording || !mine) return;
    recording = false;
    if (limit !== null) clearTimeout(limit);
    frameSub?.remove();
    frameSub = null;
    await audio.setMic(false).catch(() => undefined);
    await audio.stop().catch(() => undefined);
    const done = mine;
    done.ended.resolve();
    for (const listener of statusListeners)
      listener({
        id: done.uri,
        isFinished: true,
        hasError: false,
        error: null,
        url: done.uri,
        ...status,
      });
  };

  return {
    get uri() {
      return mine?.uri ?? null;
    },
    async prepareToRecordAsync() {
      await audio.start().catch((error: unknown) => {
        broken = true;
        throw error;
      });
      mine = {
        uri: new File(Paths.cache, `dictation-${uuidv4()}.pcm`).uri,
        frames: [],
        listeners: new Set(),
        ended: Promise.withResolvers<void>(),
      };
      capture = mine;
      setLiveWords(null);
    },
    record({ forDuration }) {
      if (!mine) return;
      const target = mine;
      recording = true;
      startedAt = Date.now();
      frameSub = audio.addListener("onMic", (event) => {
        const pcm = decodeBase64(event.pcm);
        target.frames.push(pcm);
        let sum = 0;
        for (const s of pcm) sum += s * s;
        const rms = Math.sqrt(sum / Math.max(1, pcm.length)) / 32768;
        metering = rms > 0 ? 20 * Math.log10(rms) : -160;
        for (const listener of target.listeners) listener(pcm);
      });
      void audio
        .setMic(true)
        .catch(
          (error: unknown) =>
            void finish({ hasError: true, error: error instanceof Error ? error.message : "mic" }),
        );
      limit = setTimeout(() => void finish({}), forDuration * 1000);
    },
    stop: () => finish({}),
    getStatus: () => ({
      canRecord: mine !== null,
      isRecording: recording,
      durationMillis: recording ? Date.now() - startedAt : 0,
      fileSize: 0,
      mediaServicesDidReset: false,
      metering,
      url: mine?.uri ?? null,
    }),
    addListener(_event, listener) {
      statusListeners.add(listener);
      return { remove: () => statusListeners.delete(listener) };
    },
    getAvailableInputs: () => [],
    setInput: () => undefined,
    release() {
      void finish({});
      statusListeners.clear();
    },
  };
}

/**
 * Streams the live capture to the server's speech stream (the one web uses) while he speaks, publishing his words as
 * they firm up. Resolves with the server's final text, or null when there is no live capture or the stream failed, so
 * the controller uploads the recording instead.
 */
export async function streamLiveCapture(input: {
  readonly url: () => Promise<string>;
  readonly signal: AbortSignal;
  readonly canSend: () => boolean;
}): Promise<string | null> {
  const live = capture;
  if (live === null) return null;
  let failed = false;
  let stream: ReturnType<typeof openSpeechStream> | null = null;
  try {
    stream = openSpeechStream({
      url: await input.url(),
      options: DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
      signal: input.signal,
      canSend: input.canSend,
      onText: (text) => {
        if (capture === live) setLiveWords(text);
      },
      onError: () => {
        failed = true;
      },
    });
  } catch {
    failed = true;
  }
  const feed = (pcm: Int16Array) => stream?.feed(toFloat(pcm));
  if (stream !== null) {
    // What was heard while the socket opened goes first, then each frame as it comes.
    feed(joined(live.frames));
    live.listeners.add(feed);
  }
  await live.ended.promise;
  live.listeners.delete(feed);
  if (failed || stream === null) return null;
  return stream.finish().catch(() => null);
}
