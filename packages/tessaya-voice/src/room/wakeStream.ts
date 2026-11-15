/**
 * Her name heard with no session open: the R1 sends only voiced segments (`voice/wake`, ended on `voice/wake/end`),
 * the desktop's own wake models score them, and a fire is confirmed in text from the clip just before it, as the
 * desktop does. Nothing else from the stream is recognised or kept; a segment is dropped once it ends or fires.
 * @module baton-voice/room/wakeStream
 */
import { wakeTrusted, wakeWordHeard } from "@t3tools/tessaya-shared/wakeVerify";

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
/**
 * Frames come every 60 ms inside a segment. A longer silence means its `voice/wake/end` never came: a fire starts the
 * R1's session mid-segment and it never ends that one, and a dropped hub link loses ends too. Left open, the next
 * segment was ignored whole (15 Nov soak: 5 of 18 names heard opened nothing).
 */
const SEGMENT_GAP_MS = 3_000;

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
  /** The confirm clip only, read by each recogniser asked (general, and his personal one): any may hear the name. */
  readonly confirm: (pcm: Int16Array) => Promise<ReadonlyArray<string>>;
  /** `level`: how loud his name was (dBFS), so the session can tell his voice from a far-off room. */
  readonly onWake: (
    deviceId: string,
    word: string,
    level: number,
    score: number,
    clip: Int16Array,
  ) => void;
  readonly log: (line: string) => void;
  /**
   * Words whose stage 1 is the Tessel's own wake model: its `event/wake/kws` pass with `best` at least `threshold`, then
   * the same confirm, on the whole segment. Only for a Tessel that has sent one; openWakeWord then only logs these words.
   */
  readonly kwsWake?: ReadonlyArray<{ readonly word: string; readonly threshold: number }>;
  /** Keeps each whole segment for wake training when the host has it switched on. */
  readonly capture?: WakeCapture;
  readonly now?: () => number;
}

export const createWakeStream = (deps: WakeStreamDeps) => {
  /** The words and scorer a segment starts on; `reload` replaces them, and each R1 takes them at its next segment. */
  let current = { words: deps.words, scorer: deps.scorer, gen: 0 };
  const now = deps.now ?? Date.now;
  const devices = new Map<
    string,
    {
      scorer: Promise<WakeScorer>;
      words: WakeStreamDeps["words"];
      gen: number;
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
      /** When its last frame came. */
      at: number;
    }
  >();
  /** Per R1 and segment number: the R1's on-device verdict and ours, whichever came first, until both are in. */
  const pairs = new Map<string, { kws?: KwsEvent; ours?: string }>();
  /** The Tessels that send `event/wake/kws`, and their ended segments still waiting on it (it comes just after the end). */
  const kwsSeen = new Set<string>();
  const ended = new Map<string, { pcm: Int16Array; woke: boolean }>();
  const kwsWord = (name: unknown) =>
    deps.kwsWake?.find((w) => w.word.toLowerCase() === String(name ?? "").toLowerCase());
  const byKws = (id: string, word: string) => kwsSeen.has(id) && kwsWord(word) !== undefined;
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
        scorer: current.scorer(),
        words: current.words,
        gen: current.gen,
        heard: new Int16Array(0),
        pending: new Int16Array(PRIME_SAMPLES),
        done: false,
        chain: Promise.resolve(),
        samples: 0,
        best: [],
        outcome: "",
        woke: false,
        seg: new Int16Array(0),
        at: Number.NEGATIVE_INFINITY,
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

  /** Listen afresh: the next frame opens a new segment. */
  const restart = (d: Device, scorer: WakeScorer) => {
    d.outcome = "";
    d.woke = false;
    d.seg = new Int16Array(0);
    d.samples = 0;
    d.best = [];
    drop(d);
    d.done = false;
    scorer.reset();
    d.pending = new Int16Array(PRIME_SAMPLES);
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
    if (byKws(id, word)) {
      d.outcome = `${word} fired (${output.toFixed(3)}/${threshold}), the Tessel's kws decides`;
      return;
    }
    const ratio = output / threshold;
    const trusted = wakeTrusted([{ word, threshold }], word, ratio);
    const texts = trusted ? [] : await deps.confirm(clip).catch(() => []);
    // The score goes in the line: a segment that fires gets no "wake segment" line of its own (13 Nov audit).
    const at = `${output.toFixed(3)}/${threshold} after ${(d.samples / RATE).toFixed(1)} s`;
    if (trusted || texts.some((text) => wakeWordHeard(text, word, ratio))) {
      d.outcome = `woken by ${word} (${at})`;
      d.woke = true;
      deps.log(`[${id}] woken by ${word} (${at})`);
      deps.onWake(id, word, speechLevel(clip), Math.min(1, output), clip);
    } else {
      d.outcome = `${word} fired (${at}), not confirmed`;
      deps.log(
        `[${id}] ${word} fired (${at}), not confirmed (${texts.map(heldBack).join("; ") || heldBack("")})`,
      );
    }
  };

  const scorePending = async (id: string, d: Device, scorer: WakeScorer) => {
    while (!d.done && d.pending.length >= scorer.chunkSamples) {
      const chunk = d.pending.slice(0, scorer.chunkSamples);
      d.pending = d.pending.slice(scorer.chunkSamples);
      const scores = await scorer.score(chunk);
      d.words.forEach((_, i) => (d.best[i] = Math.max(d.best[i] ?? 0, scores[i] ?? 0)));
      const at = d.words.findIndex((w, i) => (scores[i] ?? 0) >= w.threshold);
      if (at >= 0) await fired(id, d, d.words[at]!.word, scores[at]!, d.words[at]!.threshold);
    }
  };

  /** Stage 1 by the Tessel's kws on a whole ended segment, then the same confirm as an openWakeWord fire. */
  const kwsDecide = async (id: string, event: KwsEvent, pcm: Int16Array, woke: boolean) => {
    const w = kwsWord(event.name);
    const best = Number(event.best ?? 0);
    if (w === undefined || woke || event.pass !== true || best < w.threshold || pcm.length === 0)
      return;
    const ratio = best / w.threshold;
    const trusted = wakeTrusted([w], w.word, ratio);
    const texts = trusted ? [] : await deps.confirm(pcm).catch(() => []);
    const at = `kws ${best.toFixed(3)}/${w.threshold}, segment ${(pcm.length / RATE).toFixed(1)} s`;
    if (trusted || texts.some((text) => wakeWordHeard(text, w.word, ratio))) {
      deps.log(`[${id}] woken by ${w.word} (${at})`);
      deps.onWake(id, w.word, speechLevel(pcm), Math.min(1, best), pcm);
    } else
      deps.log(
        `[${id}] ${w.word} kws pass (${at}), not confirmed (${texts.map(heldBack).join("; ") || heldBack("")})`,
      );
  };

  return {
    /** One 60 ms frame of a voiced segment. */
    frame: (id: string, bytes: Uint8Array) => {
      const d = of(id);
      const t = now();
      const lost = t - d.at > SEGMENT_GAP_MS;
      d.at = t;
      const pcm = new Int16Array(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length - (bytes.length % 2)),
      );
      d.chain = d.chain.then(async () => {
        if (lost && (d.samples > 0 || d.done)) restart(d, await d.scorer);
        if (d.seg.length < KEEP_SAMPLES) d.seg = join(d.seg, pcm).slice(0, KEEP_SAMPLES);
        if (d.done) return;
        // A new segment on an old word list takes the reloaded one; a segment in progress keeps its own.
        if (d.samples === 0 && d.gen !== current.gen) {
          d.scorer = current.scorer();
          d.words = current.words;
          d.gen = current.gen;
        }
        const scorer = await d.scorer;
        d.samples += pcm.length;
        d.heard = join(d.heard, pcm).slice(-KEEP_SAMPLES);
        d.pending = join(d.pending, pcm);
        await scorePending(id, d, scorer);
      });
    },
    /** The R1's own wake model's verdict on segment `seg` (`event/wake/kws`), logged beside stage 2's. */
    kws: (id: string, event: KwsEvent) => {
      kwsSeen.add(id);
      if (typeof event.seg === "number") {
        const key = `${id}#${event.seg}`;
        const done = ended.get(key);
        ended.delete(key);
        if (done !== undefined) {
          const d = of(id);
          d.chain = d.chain.then(() => kwsDecide(id, event, done.pcm, done.woke));
        }
        pair(id, event.seg, { kws: event });
      }
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
            `[${id}] wake segment ${(d.samples / RATE).toFixed(1)} s, best ${d.words
              .map((w, i) => `${w.word} ${(d.best[i] ?? 0).toFixed(3)}/${w.threshold}`)
              .join(", ")}`,
          );
        const ours =
          d.outcome !== ""
            ? d.outcome
            : `no fire, best ${d.words.map((w, i) => `${w.word} ${(d.best[i] ?? 0).toFixed(3)}`).join(", ")}`;
        if (deps.capture !== undefined && d.seg.length > 0)
          deps.capture.segment(
            id,
            seg,
            d.seg,
            {
              outcome: ours,
              woke: d.woke,
              best: Object.fromEntries(d.words.map((w, i) => [w.word, d.best[i] ?? 0])),
            },
            seg === undefined ? undefined : pairs.get(`${id}#${seg}`)?.kws,
          );
        if (seg !== undefined && (deps.kwsWake?.length ?? 0) > 0) {
          const early = pairs.get(`${id}#${seg}`)?.kws;
          if (early !== undefined) await kwsDecide(id, early, d.seg, d.woke);
          else {
            ended.set(`${id}#${seg}`, { pcm: d.seg, woke: d.woke });
            if (ended.size > 8) ended.delete(ended.keys().next().value!);
          }
        }
        if (seg !== undefined) pair(id, seg, { ours });
        restart(d, scorer);
      });
    },
    /** New words (her newly trained ones): each R1 listens for them from its next segment. */
    reload: (words: WakeStreamDeps["words"], scorer: WakeStreamDeps["scorer"]) => {
      current = { words, scorer, gen: current.gen + 1 };
    },
    /** For tests: everything sent so far has been scored. */
    drained: (id: string) => devices.get(id)?.chain ?? Promise.resolve(),
  };
};
