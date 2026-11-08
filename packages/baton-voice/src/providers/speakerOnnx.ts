/**
 * The speaker-embedding model on onnxruntime-node (VOICE-ID): Kaldi fbank with mean subtraction (fbank.ts),
 * then the model, then length 1. Any model that takes [1, frames, 80] and returns one vector fits; CAM++ is
 * the one shipped (voiceid-bench REPORT 2026-11-08). Runs in the voice model worker, never on the main thread.
 *
 * @module baton-voice/providers/speakerOnnx
 */
import type * as Ort from "onnxruntime-node";

import { fbank } from "../fbank.ts";

let ortModule: Promise<typeof Ort> | undefined;
const loadOrt = () => (ortModule ??= import("onnxruntime-node"));

export interface SpeakerEmbedder {
  /** The model's id, as stamped on profiles made with it. */
  readonly model: string;
  /** One unit vector for the clip, or null when it is under one frame. */
  readonly embed: (pcm: Int16Array) => Promise<Float32Array | null>;
}

export const createSpeakerEmbedder = async (
  path: string,
  model: string,
): Promise<SpeakerEmbedder> => {
  const ort = await loadOrt();
  const session = await ort.InferenceSession.create(path, {
    intraOpNumThreads: 1,
    interOpNumThreads: 1,
    executionMode: "sequential",
  });
  const input = session.inputNames[0]!;
  return {
    model,
    embed: async (pcm) => {
      const { frames, data } = fbank(pcm);
      if (frames === 0) return null;
      const out = await session.run({ [input]: new ort.Tensor("float32", data, [1, frames, 80]) });
      const v = Object.values(out)[0]!.data as Float32Array;
      const n = Math.hypot(...v) || 1;
      return Float32Array.from(v, (x) => x / n);
    },
  };
};
