/**
 * Her name heard with no session open: the R1 sends only voiced segments (`voice/wake`, ended on `voice/wake/end`),
 * the desktop's own wake models score them, and a fire is confirmed in text from the clip just before it, as the
 * desktop does. Nothing else from the stream is recognised or kept; a segment is dropped once it ends or fires.
 * @module baton-voice/room/wakeStream
 */
import { wakeTrusted, wakeWordHeard } from "@t3tools/baton-shared/wakeVerify";

import { heldBack } from "./addressing.ts";
import { speechLevel } from "./audio.ts";
import type { WakeCapture } from "./wakeCapture.ts";

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

/** `event/wake/kws`: the R1's on-device wake model on one segment (firmware contract). */
export interface KwsEvent {
  readonly seg?: number;
  readonly score?: number;
  readonly pass?: boolean;
  readonly name?: string;
  readonly best?: number;
  readonly ms?: number;
  readonly n?: number;
}

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
  /** `level`: how loud his name was (dBFS), so the session can tell his voice from a far-off room. */
  readonly onWake: (
    deviceId: string,
    word: string,
    level: number,
    score: number,
    clip: Int16Array,
  ) => void;
  readonly log: (line: string) => void;
  /** Keeps each whole segment for wake training when the host has it switched on. */
  readonly capture?: WakeCapture;
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
      /** Stage 2's verdict on this segment, for the line beside the R1's own wake model (`event/wake/kws`). */
      outcome: string;
      woke: boolean;
      /** The whole segment, for the capture only. */
      seg: Int16Array;
    }
  >();
  /** Per R1 and segment number: the R1's on-device verdict and ours, whichever came first, until both are in. */
  const pairs = new Map<string, { kws?: KwsEvent; ours?: string }>();
  const pair = (id: string, seg: number, half: { kws?: KwsEvent; ours?: string }) => {
    const key = `${id}#${seg}`;
    const both = { ...pairs.get(key), ...half };
    if (both.kws === undefined || both.ours === undefined) {
      pairs.set(key, both);
      // A segment whose other half never comes is not kept for ever.
      if (pairs.size > 64) pairs.delete(pairs.keys().next().value!);
      return;
    }
    pairs.delete(key);
    const k = both.kws;
    deps.log(
      `[${id}] seg ${seg} kws ${k.name ?? "?"} ${Number(k.score ?? 0).toFixed(3)} ${k.pass === true ? "pass" : "no pass"} (best ${k.best ?? "?"}, ${k.ms ?? "?"} ms, n ${k.n ?? "?"}); stage 2: ${both.ours}`,
    );
  };
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
        outcome: "",
        woke: false,
        seg: new Int16Array(0),
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
      d.outcome = `woken by ${word} (${at})`;
      d.woke = true;
      deps.log(`[${id}] woken by ${word} (${at})`);
      deps.onWake(id, word, speechLevel(clip), Math.min(1, output), clip);
    } else {
      d.outcome = `${word} fired (${at}), not confirmed`;
      deps.log(`[${id}] ${word} fired (${at}), not confirmed (${heldBack(text)})`);
    }
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
        if (deps.capture !== undefined && d.seg.length < KEEP_SAMPLES)
          d.seg = join(d.seg, pcm).slice(0, KEEP_SAMPLES);
        if (d.done) return;
        const scorer = await d.scorer;
        d.samples += pcm.length;
        d.heard = join(d.heard, pcm).slice(-KEEP_SAMPLES);
        d.pending = join(d.pending, pcm);
        await scorePending(id, d, scorer);
      });
    },
    /** The R1's own wake model's verdict on segment `seg` (`event/wake/kws`), logged beside stage 2's. */
    kws: (id: string, event: KwsEvent) => {
      if (typeof event.seg === "number") pair(id, event.seg, { kws: event });
      deps.capture?.kws(id, event);
    },
    /** The segment ended (`seg`: the R1's number for it): forget it, and listen afresh on the next one. */
    end: (id: string, seg?: number) => {
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
        const ours =
          d.outcome !== ""
            ? d.outcome
            : `no fire, best ${deps.words.map((w, i) => `${w.word} ${(d.best[i] ?? 0).toFixed(3)}`).join(", ")}`;
        if (deps.capture !== undefined && d.seg.length > 0)
          deps.capture.segment(
            id,
            seg,
            d.seg,
            {
              outcome: ours,
              woke: d.woke,
              best: Object.fromEntries(deps.words.map((w, i) => [w.word, d.best[i] ?? 0])),
            },
            seg === undefined ? undefined : pairs.get(`${id}#${seg}`)?.kws,
          );
        if (seg !== undefined) pair(id, seg, { ours });
        d.outcome = "";
        d.woke = false;
        d.seg = new Int16Array(0);
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
