/* oxlint-disable t3code/no-low-value-comments -- Baton file predating upstream's rule (D82) */
/**
 * openWakeWord (wake, pipeline in tessaya-shared/openWakeWord.ts) and Silero (VAD) on onnxruntime-node. Both are
 * synchronous per frame from the pipeline's point of view: ORT's `run` is
 * async, so each provider queues frames and resolves them in order, exposing
 * the latest answer. The pipeline polls `process`/`isSpeech` per frame and
 * tolerates one 80 ms chunk of latency.
 *
 * @module baton-voice/providers/onnx
 */
import type * as Ort from "onnxruntime-node";

import type { VadProvider, WakeProvider } from "../types.ts";
import {
  createOpenWakeWordProvider as createProviderWith,
  createOpenWakeWordScorerWith,
  type OpenWakeWordPaths,
  type OpenWakeWordScorer,
  openSession,
  streamingScorer,
} from "@t3tools/tessaya-shared/openWakeWord";

export * from "@t3tools/tessaya-shared/openWakeWord";

const SILERO_WINDOW = 512;
const SILERO_CONTEXT = 64;

// Loaded on first use, so a missing native binding disables voice instead of crashing the app.
let ortModule: Promise<typeof Ort> | undefined;
const loadOrt = () => (ortModule ??= import("onnxruntime-node"));

const open = async (path: string) => openSession(await loadOrt(), path);

export const createOpenWakeWordScorer = async (paths: OpenWakeWordPaths) =>
  createOpenWakeWordScorerWith(await loadOrt(), paths);

export type SileroScorer = Awaited<ReturnType<typeof createSileroScorer>>;

export const createOpenWakeWordProvider = (
  paths: OpenWakeWordPaths,
  makeScorer: (paths: OpenWakeWordPaths) => Promise<OpenWakeWordScorer> = createOpenWakeWordScorer,
): Promise<
  WakeProvider & { readonly drain: () => Promise<void>; readonly lastWord: () => string | null }
> => createProviderWith(paths, makeScorer);

/**
 * Silero VAD (v5/v6 ONNX): 512-sample windows at 16 kHz with 64 samples of
 * context prepended, recurrent state [2,1,128].
 */
export const createSileroScorer = async (modelPath: string) => {
  const ort = await loadOrt();
  const session = await open(modelPath);
  let state = new Float32Array(2 * 128);
  let context = new Float32Array(SILERO_CONTEXT);
  const sr = new ort.Tensor("int64", BigInt64Array.from([16000n]), []);

  const score = async (chunk: Int16Array): Promise<number> => {
    const x = new Float32Array(SILERO_CONTEXT + SILERO_WINDOW);
    x.set(context);
    for (let i = 0; i < SILERO_WINDOW; i++) x[SILERO_CONTEXT + i] = chunk[i]! / 32768;
    context = x.slice(-SILERO_CONTEXT);
    const out = await session.run({
      input: new ort.Tensor("float32", x, [1, SILERO_CONTEXT + SILERO_WINDOW]),
      state: new ort.Tensor("float32", state, [2, 1, 128]),
      sr,
    });
    state = new Float32Array(out["stateN"]!.data as Float32Array);
    return (out["output"]!.data as Float32Array)[0] ?? 0;
  };
  const reset = () => {
    state = new Float32Array(2 * 128);
    context = new Float32Array(SILERO_CONTEXT);
  };
  return { score, reset, chunkSamples: SILERO_WINDOW };
};

export const createSileroVad = async (
  modelPath: string,
  threshold = 0.5,
  makeScorer: (modelPath: string) => Promise<SileroScorer> = createSileroScorer,
): Promise<VadProvider & { readonly drain: () => Promise<void> }> => {
  const scorer = await makeScorer(modelPath);
  const s = streamingScorer({
    name: "silero",
    chunkSamples: scorer.chunkSamples,
    score: scorer.score,
    reset: scorer.reset,
    threshold,
    refractoryChunks: 0,
  });
  return {
    name: "silero",
    isSpeech: (frame) => {
      s.feed(frame);
      return s.last() >= threshold;
    },
    reset: s.reset,
    drain: s.drain,
    scored: s.scored,
    behind: s.behind,
    probability: s.last,
  };
};
