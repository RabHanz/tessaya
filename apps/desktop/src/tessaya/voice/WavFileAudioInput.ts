// @effect-diagnostics nodeBuiltinImport:off
/**
 * WAV files as microphones: the headless proof of the capture → core loop,
 * and a way to replay a recorded utterance on a box with no audio device.
 * Each file is one "device"; switching device plays the next recording.
 */
import * as NodeFSP from "node:fs/promises";

import { makeFramer, parseWav, toVoicePcm } from "./pcm.ts";
import type { AudioInputProvider } from "./voiceTypes.ts";

export const wavDeviceId = (path: string): string => `wav:${path}`;

export const makeWavFileAudioInput = (
  paths: ReadonlyArray<string>,
  options?: {
    /**
     * Awaited after every frame. The ONNX wake/VAD providers score frames
     * asynchronously; a live mic gives them 20 ms per frame, and a file read
     * faster than real time has to wait for them the same way.
     */
    readonly afterFrame?: () => Promise<void>;
  },
): AudioInputProvider => {
  let stopped = false;
  return {
    listDevices: async () => paths.map((path) => ({ deviceId: wavDeviceId(path), label: path })),
    start: async ({ deviceId, onFrame }) => {
      stopped = false;
      const path = paths.find((p) => wavDeviceId(p) === deviceId) ?? paths[0];
      if (path === undefined) throw new Error("No WAV file to play.");
      const wav = parseWav(new Uint8Array(await NodeFSP.readFile(path)));
      const frames: Int16Array[] = [];
      makeFramer((frame) => frames.push(frame))(
        toVoicePcm(wav.samples, wav.channels, wav.sampleRate),
      );
      for (const frame of frames) {
        if (stopped) return;
        onFrame(frame);
        await options?.afterFrame?.();
      }
    },
    stop: async () => {
      stopped = true;
    },
  };
};
