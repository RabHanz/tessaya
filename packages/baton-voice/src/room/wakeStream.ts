/**
 * Her name heard with no session open: the R1 sends only voiced segments (`voice/wake`, ended on `voice/wake/end`),
 * the desktop's own wake models score them, and a fire is confirmed in text from the clip just before it, as the
 * desktop does. Nothing else from the stream is recognised or kept; a segment is dropped once it ends or fires.
 * @module baton-voice/room/wakeStream
 */
import { wakeTrusted, wakeWordHeard } from "@t3tools/baton-shared/wakeVerify";

const RATE = 16_000;
/** The R1 caps a wake segment at 6 s; a little more never needs keeping. */
const KEEP_SAMPLES = 7 * RATE;
/**
 * openWakeWord scores nothing until it has 16 embeddings (1.28 s). The R1's segments are often shorter (his name alone
 * with 300 ms before and 480 ms after is 1.0-1.3 s), so each starts after this much silence, and ends with a little
 * more, or the name is over before the model can score it (13 Nov: 1 of 7 names woke her unprimed, 7 of 7 primed).
 */
const PRIME_SAMPLES = 1.3 * RATE;
const TAIL_SAMPLES = 0.5 * RATE;
/** What the confirm hears: the name and a little before it. */
const CONFIRM_SAMPLES = 2 * RATE;

export interface WakeScorer {
  /** One score per word (in `words` order) for a chunk of `chunkSamples`. */
  readonly score: (chunk: Int16Array) => Promise<ReadonlyArray<number>>;
  readonly reset: () => void;
  readonly chunkSamples: number;
}

export interface WakeStreamDeps {
  readonly words: ReadonlyArray<{ readonly word: string; readonly threshold: number }>;
  /** A fresh scorer per R1 (openWakeWord is stateful). */
  readonly scorer: () => Promise<WakeScorer>;
  /** The recogniser on the confirm clip only. */
  readonly confirm: (pcm: Int16Array) => Promise<string>;
  readonly onWake: (deviceId: string, word: string) => void;
  readonly log: (line: string) => void;
}

export const createWakeStream = (deps: WakeStreamDeps) => {
  const devices = new Map<
    string,
    {
      scorer: Promise<WakeScorer>;
      heard: Int16Array;
      pending: Int16Array;
      done: boolean;
      chain: Promise<void>;
      /** This segment's samples and each word's best score, for one log line when it ends. */
      samples: number;
      best: number[];
    }
  >();
  const of = (id: string) => {
    let d = devices.get(id);
    if (d === undefined) {
      d = {
        scorer: deps.scorer(),
        heard: new Int16Array(0),
        pending: new Int16Array(PRIME_SAMPLES),
        done: false,
        chain: Promise.resolve(),
        samples: 0,
        best: [],
      };
      devices.set(id, d);
    }
    return d;
  };
  const join = (a: Int16Array, b: Int16Array) => {
    const out = new Int16Array(a.length + b.length);
    out.set(a);
    out.set(b, a.length);
    return out;
  };
  type Device = ReturnType<typeof of>;
  const drop = (d: Device) => {
    d.heard = new Int16Array(0);
    d.pending = new Int16Array(0);
  };

  const fired = async (
    id: string,
    d: ReturnType<typeof of>,
    word: string,
    output: number,
    threshold: number,
  ) => {
    d.done = true;
    const clip = d.heard.slice(-CONFIRM_SAMPLES);
    drop(d);
    const ratio = output / threshold;
    const trusted = wakeTrusted([{ word, threshold }], word, ratio);
    const text = trusted ? "" : await deps.confirm(clip).catch(() => "");
    // The score goes in the line: a segment that fires gets no "wake segment" line of its own (13 Nov audit).
    const at = `${output.toFixed(3)}/${threshold} after ${(d.samples / RATE).toFixed(1)} s`;
    if (trusted || wakeWordHeard(text, word, ratio)) {
      deps.log(`[${id}] woken by ${word} (${at})`);
      deps.onWake(id, word);
    } else deps.log(`[${id}] ${word} fired (${at}), not confirmed`);
  };

  const scorePending = async (id: string, d: Device, scorer: WakeScorer) => {
    while (!d.done && d.pending.length >= scorer.chunkSamples) {
      const chunk = d.pending.slice(0, scorer.chunkSamples);
      d.pending = d.pending.slice(scorer.chunkSamples);
      const scores = await scorer.score(chunk);
      deps.words.forEach((_, i) => (d.best[i] = Math.max(d.best[i] ?? 0, scores[i] ?? 0)));
      const at = deps.words.findIndex((w, i) => (scores[i] ?? 0) >= w.threshold);
      if (at >= 0) await fired(id, d, deps.words[at]!.word, scores[at]!, deps.words[at]!.threshold);
    }
  };

  return {
    /** One 60 ms frame of a voiced segment. */
    frame: (id: string, bytes: Uint8Array) => {
      const d = of(id);
      const pcm = new Int16Array(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length - (bytes.length % 2)),
      );
      d.chain = d.chain.then(async () => {
        if (d.done) return;
        const scorer = await d.scorer;
        d.samples += pcm.length;
        d.heard = join(d.heard, pcm).slice(-KEEP_SAMPLES);
        d.pending = join(d.pending, pcm);
        await scorePending(id, d, scorer);
      });
    },
    /** The segment ended: forget it, and listen afresh on the next one. */
    end: (id: string) => {
      const d = devices.get(id);
      if (d === undefined) return;
      d.chain = d.chain.then(async () => {
        const scorer = await d.scorer;
        // The name at the very end of a segment still gets scored.
        if (!d.done && d.samples > 0) {
          d.pending = join(d.pending, new Int16Array(TAIL_SAMPLES));
          await scorePending(id, d, scorer);
        }
        // One line a segment, so a name that did not wake her can be audited against the thresholds.
        if (!d.done && d.samples > 0)
          deps.log(
            `[${id}] wake segment ${(d.samples / RATE).toFixed(1)} s, best ${deps.words
              .map((w, i) => `${w.word} ${(d.best[i] ?? 0).toFixed(3)}/${w.threshold}`)
              .join(", ")}`,
          );
        d.samples = 0;
        d.best = [];
        drop(d);
        d.done = false;
        scorer.reset();
        d.pending = new Int16Array(PRIME_SAMPLES);
      });
    },
    /** For tests: everything sent so far has been scored. */
    drained: (id: string) => devices.get(id)?.chain ?? Promise.resolve(),
  };
};
