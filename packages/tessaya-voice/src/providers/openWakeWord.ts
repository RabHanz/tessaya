/**
 * The openWakeWord pipeline with no runtime import, so it runs on onnxruntime-node (desktop, room loop) and
 * onnxruntime-react-native (the Sleeve) alike; the caller passes its runtime in. Ported from openwakeword/utils.py
 * (v0.6.0): 1280-sample chunks, melspectrogram over the chunk plus 480 samples of history (x/10 + 2), embedding over
 * the last 76 mel frames, the wake model over the last 16 embeddings.
 */
import type { WakeProvider } from "../types.ts";

/** The part of an onnxruntime build this uses; onnxruntime-node and onnxruntime-react-native both fit. */
export interface OrtSession {
  readonly inputNames: ReadonlyArray<string>;
  run(feeds: Record<string, unknown>): Promise<Record<string, { readonly data: unknown }>>;
}
export interface OrtRuntime {
  readonly InferenceSession: {
    create(path: string, options?: Record<string, unknown>): Promise<OrtSession>;
  };
  readonly Tensor: new (
    type: "float32",
    data: Float32Array,
    dims: ReadonlyArray<number>,
  ) => unknown;
}

export const openSession = (ort: OrtRuntime, path: string) =>
  ort.InferenceSession.create(path, {
    intraOpNumThreads: 1,
    interOpNumThreads: 1,
    executionMode: "sequential",
  });

export const firstOutput = (output: Record<string, { readonly data: unknown }>): Float32Array => {
  const value = Object.values(output)[0];
  if (value === undefined) throw new Error("model returned no output");
  return value.data as Float32Array;
};

const OWW_CHUNK = 1280;
const MEL_HISTORY = 480;
const MEL_WINDOW = 76;
const EMBED_WINDOW = 16;
/** Quiet audio further behind the newest frame than this is not scored. */
const MAX_BEHIND = 4 * 16_000;
/** Room tone, about -48 dBFS: no name in it. */
const QUIET = 131;
const quiet = (chunk: Int16Array) => {
  let sum = 0;
  for (const v of chunk) sum += v * v;
  return Math.sqrt(sum / Math.max(1, chunk.length)) < QUIET;
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
export const createOpenWakeWordScorerWith = async (ort: OrtRuntime, paths: OpenWakeWordPaths) => {
  const [mel, embed, ...wakes] = await Promise.all([
    openSession(ort, paths.melspectrogram),
    openSession(ort, paths.embedding),
    ...paths.wakes.map((wake) => openSession(ort, wake.path)),
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

    const melOut = firstOutput(
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
    const emb = firstOutput(
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
          firstOutput(
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
export type OpenWakeWordScorer = Awaited<ReturnType<typeof createOpenWakeWordScorerWith>>;

export const createOpenWakeWordProvider = async (
  paths: OpenWakeWordPaths,
  makeScorer: (paths: OpenWakeWordPaths) => Promise<OpenWakeWordScorer>,
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
