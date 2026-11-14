/* oxlint-disable t3code/no-low-value-comments -- Baton file predating upstream's rule (D82) */
/**
 * openWakeWord (wake) and Silero (VAD) on onnxruntime-node. Both are
 * synchronous per frame from the pipeline's point of view: ORT's `run` is
 * async, so each provider queues frames and resolves them in order, exposing
 * the latest answer. The pipeline polls `process`/`isSpeech` per frame and
 * tolerates one 80 ms chunk of latency.
 *
 * openWakeWord's streaming feature extraction is ported from
 * openwakeword/utils.py (v0.6.0): 1280-sample chunks → melspectrogram over the
 * chunk plus 480 samples of history (x/10 + 2) → embedding over the last 76
 * mel frames → the wake model over the last 16 embeddings.
 *
 * @module baton-voice/providers/onnx
 */
import type * as Ort from "onnxruntime-node";

import type { VadProvider, WakeProvider } from "../types.ts";

const OWW_CHUNK = 1280;
const MEL_HISTORY = 480;
const MEL_WINDOW = 76;
const EMBED_WINDOW = 16;
const SILERO_WINDOW = 512;
const SILERO_CONTEXT = 64;
/** Quiet audio further behind the newest frame than this is not scored. */
const MAX_BEHIND = 4 * 16_000;
/** Room tone, about -48 dBFS: no name in it. */
const QUIET = 131;
const quiet = (chunk: Int16Array) => {
  let sum = 0;
  for (const v of chunk) sum += v * v;
  return Math.sqrt(sum / Math.max(1, chunk.length)) < QUIET;
};

// Loaded on first use, so a missing native binding disables voice instead of crashing the app.
let ortModule: Promise<typeof Ort> | undefined;
const loadOrt = () => (ortModule ??= import("onnxruntime-node"));

const open = async (path: string) =>
  (await loadOrt()).InferenceSession.create(path, {
    intraOpNumThreads: 1,
    interOpNumThreads: 1,
    executionMode: "sequential",
  });

const first = (output: Ort.InferenceSession.OnnxValueMapType): Float32Array => {
  const value = Object.values(output)[0];
  if (value === undefined) throw new Error("model returned no output");
  return value.data as Float32Array;
};

export interface WakeWordModel {
  /** What the person says: "sebastian". */
  readonly word: string;
  readonly path: string;
  readonly threshold: number;
}

export interface OpenWakeWordPaths {
  readonly melspectrogram: string;
  readonly embedding: string;
  /** Every word listens at once; the features are computed once per chunk and shared. */
  readonly wakes: ReadonlyArray<WakeWordModel>;
}

/**
 * Feature pipeline as an async step function, testable on its own. Returns one
 * score per wake word (in `paths.wakes` order) for each 1280-sample chunk fed in.
 */
export const createOpenWakeWordScorer = async (paths: OpenWakeWordPaths) => {
  const ort = await loadOrt();
  const [mel, embed, ...wakes] = await Promise.all([
    open(paths.melspectrogram),
    open(paths.embedding),
    ...paths.wakes.map((wake) => open(wake.path)),
  ]);
  const melIn = mel!.inputNames[0]!;
  const embedIn = embed!.inputNames[0]!;

  let raw = new Float32Array(0);
  let melFrames: Float32Array[] = [];
  let embeddings: Float32Array[] = [];

  const reset = () => {
    raw = new Float32Array(0);
    melFrames = Array.from({ length: MEL_WINDOW }, () => new Float32Array(32).fill(1));
    embeddings = [];
  };
  reset();

  const score = async (chunk: Int16Array): Promise<ReadonlyArray<number>> => {
    const joined = new Float32Array(raw.length + chunk.length);
    joined.set(raw);
    for (let i = 0; i < chunk.length; i++) joined[raw.length + i] = chunk[i]!;
    raw = joined.slice(-(OWW_CHUNK + MEL_HISTORY));

    const melOut = first(
      await mel!.run({ [melIn]: new ort.Tensor("float32", raw, [1, raw.length]) }),
    );
    const frames = melOut.length / 32;
    // The newest 8 frames belong to this chunk; earlier ones overlap history.
    for (let f = Math.max(0, frames - 8); f < frames; f++) {
      const row = new Float32Array(32);
      for (let b = 0; b < 32; b++) row[b] = melOut[f * 32 + b]! / 10 + 2;
      melFrames.push(row);
    }
    melFrames = melFrames.slice(-MEL_WINDOW * 2);

    const window = new Float32Array(MEL_WINDOW * 32);
    melFrames.slice(-MEL_WINDOW).forEach((row, i) => window.set(row, i * 32));
    const emb = first(
      await embed!.run({ [embedIn]: new ort.Tensor("float32", window, [1, MEL_WINDOW, 32, 1]) }),
    );
    embeddings.push(emb.slice(0, 96));
    if (embeddings.length > EMBED_WINDOW) embeddings.shift();
    if (embeddings.length < EMBED_WINDOW) return wakes.map(() => 0);

    const feats = new Float32Array(EMBED_WINDOW * 96);
    embeddings.forEach((e, i) => feats.set(e, i * 96));
    return Promise.all(
      wakes.map(
        async (wake) =>
          first(
            await wake.run({
              [wake.inputNames[0]!]: new ort.Tensor("float32", feats, [1, EMBED_WINDOW, 96]),
            }),
          )[0] ?? 0,
      ),
    );
  };

  return { score, reset, chunkSamples: OWW_CHUNK };
};

/**
 * Wrap a streaming async scorer so the pipeline can feed it frame by frame.
 * Frames are buffered into the scorer's chunk size and scored in order; a
 * fire is reported on the next frame after the score crosses `threshold`, then
 * suppressed for `refractoryChunks` so one phrase fires once.
 */
export const streamingScorer = (input: {
  readonly name: string;
  readonly chunkSamples: number;
  readonly score: (chunk: Int16Array) => Promise<number>;
  readonly reset: () => void;
  readonly threshold: number;
  readonly refractoryChunks?: number;
}) => {
  let pending = new Int16Array(0);
  let queue: Promise<void> = Promise.resolve();
  let fired: number | null = null;
  let fed = 0;
  let firedEnd = 0;
  let cooldown = 0;
  let last = 0;
  let stale = false;
  let speechScored = 0;
  let quietRun = 0;
  /** Where the last scored chunk ended, in samples fed. */
  let scoredEnd = 0;
  /** Bumped by reset(): a chunk queued before it is about audio that no longer counts. */
  let generation = 0;
  const feed = (frame: Int16Array) => {
    fed += frame.length;
    const joined = new Int16Array(pending.length + frame.length);
    joined.set(pending);
    joined.set(frame, pending.length);
    pending = joined;
    while (pending.length >= input.chunkSamples) {
      const chunk = pending.slice(0, input.chunkSamples);
      pending = pending.slice(input.chunkSamples);
      const end = fed - pending.length;
      const gen = generation;
      queue = queue.then(async () => {
        if (gen !== generation) return;
        // Behind after a stall (launch, a busy computer), old quiet audio is skipped and the scorer starts fresh,
        // so it catches up with the microphone. Old speech is still scored: a name said at launch may be in it.
        if (fed - end > MAX_BEHIND && quiet(chunk)) {
          stale = true;
          quietRun += chunk.length;
          scoredEnd = end;
          return;
        }
        if (stale) {
          stale = false;
          input.reset();
        }
        const s = await input.score(chunk);
        if (gen !== generation) return;
        last = s;
        scoredEnd = end;
        if (s >= input.threshold) {
          speechScored += chunk.length;
          quietRun = 0;
        } else quietRun += chunk.length;
        if (cooldown > 0) {
          cooldown -= 1;
          return;
        }
        if (s >= input.threshold) {
          fired = s;
          firedEnd = end;
          cooldown = input.refractoryChunks ?? 12;
        }
      });
    }
  };
  return {
    feed,
    /** Wait for every queued chunk — tests and end-of-file use this. */
    drain: () => queue,
    take: (): number | null => {
      const f = fired;
      fired = null;
      return f;
    },
    last: () => last,
    firedAgo: () => fed - firedEnd,
    scored: () => ({ speech: speechScored, quiet: quietRun }),
    behind: () => Math.max(0, fed - scoredEnd),
    reset: () => {
      generation += 1;
      pending = new Int16Array(0);
      fired = null;
      cooldown = 0;
      quietRun = 0;
      last = 0;
      input.reset();
    },
  };
};

/** What a wake scorer is behind the provider: in this process, or in a worker that owns the ONNX sessions. */
export type OpenWakeWordScorer = Awaited<ReturnType<typeof createOpenWakeWordScorer>>;
export type SileroScorer = Awaited<ReturnType<typeof createSileroScorer>>;

export const createOpenWakeWordProvider = async (
  paths: OpenWakeWordPaths,
  makeScorer: (paths: OpenWakeWordPaths) => Promise<OpenWakeWordScorer> = createOpenWakeWordScorer,
): Promise<
  WakeProvider & {
    readonly drain: () => Promise<void>;
    /** The word behind the last fire. */
    readonly lastWord: () => string | null;
  }
> => {
  const scorer = await makeScorer(paths);
  let word: string | null = null;
  // Each word has its own threshold; scored as a fraction of it, 1 means that word fired.
  const s = streamingScorer({
    name: "openwakeword",
    chunkSamples: scorer.chunkSamples,
    reset: scorer.reset,
    threshold: 1,
    score: async (chunk) => {
      const scores = await scorer.score(chunk);
      let best = 0;
      scores.forEach((value, i) => {
        const wake = paths.wakes[i]!;
        const ratio = value / wake.threshold;
        if (ratio > best) {
          best = ratio;
          if (ratio >= 1) word = wake.word;
        }
      });
      return best;
    },
  });
  return {
    name: "openwakeword",
    process: (frame) => {
      s.feed(frame);
      return s.take();
    },
    reset: s.reset,
    drain: s.drain,
    lastWord: () => word,
    firedAgo: s.firedAgo,
  };
};

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
