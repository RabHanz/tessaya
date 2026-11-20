// @effect-diagnostics globalTimers:off
/**
 * Her name heard with no session open: the R1 sends only voiced segments (`voice/wake`, ended on `voice/wake/end`),
 * the desktop's own wake models score them, and a fire is confirmed in text from the clip just before it, as the
 * desktop does. Only a segment that woke her is recognised whole (his request in the same breath); nothing else is kept.
 * @module baton-voice/room/wakeStream
 */
import { wakeTrusted, wakeWordHeard, wakeWordLead } from "@t3tools/tessaya-shared/wakeVerify";

import { stripWake } from "../modeMachine.ts";
import type { SpeakerIdentity } from "../speaker.ts";
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
/**
 * A Tessel kws pass this close under the loop's bar wakes her only when her name leads the segment's words. Of the 22
 * kept passes at 0.80-0.89 (to 17 Nov), one was his wake (16 Nov seg 172, "Tessaya, what time is it?", 0.89), and none
 * of the other 21 began with her name.
 */
const NEAR_KWS = 0.8;
/** What the confirm hears: the name and a little before it. */
const CONFIRM_SAMPLES = 2 * RATE;
/**
 * Frames come every 60 ms inside a segment. A longer silence means its `voice/wake/end` never came: a fire starts the
 * R1's session mid-segment and it never ends that one, and a dropped hub link loses ends too. Left open, the next
 * segment was ignored whole (15 Nov soak: 5 of 18 names heard opened nothing).
 */
const SEGMENT_GAP_MS = 3_000;
/** The Tessel's wake frames are 60 ms each, so `sent` on `voice/wake/end` says how much of the stream is the segment. */
export const FRAME_SAMPLES = 960;
/** The silence the Tessel waits before it ends a segment: his last word came this long before `voice/wake/end`. */
const END_SILENCE_MS = 480;
/**
 * Another name this near its own bar in the same segment: the models cannot tell which he said, so neither wakes her.
 * 16 Nov 12:35Z his repeated "Tessaya" scored Freya 1.05x and Tessaya 0.99x and opened Freya; no other of 217 fires
 * in 1,745 kept segments had a second name over 0.3x.
 */
const RIVAL_SHARE = 0.5;
/**
 * How long a near-certain fire waits for any recogniser before it wakes her on its score alone. They answer in 0.3-0.7 s;
 * 20 Nov 13:26, with the box loaded, 2.9 s and 5.3 s, and she woke 5 s after his "Freya". A false fire scores this high
 * too (12 of 41 such fires in 16-20 Nov were not her name), so it only decides when no recogniser has answered at all.
 */
export const CONFIRM_BUDGET_MS = 1_500;
/** A model output this high may wake her on its own once the budget is spent. */
const SURE_OUTPUT = 0.995;

/** What he asked in the same breath as her name ("Tessaya, what time is it?"), said from `startedAt` to `endedAt`. */
export interface WakeRequest {
  readonly text: string;
  readonly startedAt: number;
  readonly endedAt: number;
}

/** His words after her name leading `texts` (one per recogniser), or null for her name alone or a name not leading. */
export const requestAfterName = (texts: ReadonlyArray<string>, word: string): string | null => {
  for (const text of texts) {
    const rest = stripWake(text, [word]).trim();
    if (
      rest !== text.trim() &&
      /[\p{L}\p{N}]/u.test(rest) &&
      !/^(?:um+|uh+|er+|hm+|mm+|ah+|oh)[.,!?]*$/i.test(rest)
    )
      return rest;
  }
  return null;
};

/** The Tessel's wake segment gate: max(min, x10 / 10 times the room's noise floor), in raw RMS (firmware 0.3.146+). */
export interface WakeGate {
  readonly min: number;
  readonly x10: number;
}

/** `R1_WAKE_GATE=min=64,x=2.5` (the firmware's own range: min 32-450, x 1.5-6), or null to keep the firmware's. */
export const parseWakeGate = (text: string | undefined): WakeGate | null => {
  const m = /^\s*min=(\d+)\s*,\s*x=(\d+(?:\.\d+)?)\s*$/.exec(text ?? "");
  if (m === null) return null;
  const gate = { min: Number(m[1]), x10: Math.round(Number(m[2]) * 10) };
  return gate.min >= 32 && gate.min <= 450 && gate.x10 >= 15 && gate.x10 <= 60 ? gate : null;
};

/**
 * The `cmd/voice/kws` that sets the Tessel's early kws threshold and wake gate, for its retained `state/voice/kws`
 * (early in thousandths), or null when it already holds them. The Tessel saves neither, so each boot gets them again.
 */
export const kwsSettingsCommand = (
  state: { readonly early?: unknown; readonly gate_min?: unknown; readonly gate_x10?: unknown },
  kwsWake: ReadonlyArray<{ readonly threshold: number }>,
  gate: WakeGate | null,
): string | null => {
  const send: { early?: number; gate_min?: number; gate_x10?: number } = {};
  if (kwsWake.length > 0) {
    const early = Math.min(...kwsWake.map((w) => w.threshold));
    if (state.early !== Math.round(early * 1000)) send.early = early;
  }
  // Only firmware that reports a gate takes one; an older Tessel's reply would never match, so it would be asked forever.
  if (gate !== null && typeof state.gate_min === "number") {
    if (state.gate_min !== gate.min) send.gate_min = gate.min;
    if (state.gate_x10 !== gate.x10) send.gate_x10 = gate.x10;
  }
  return Object.keys(send).length === 0 ? null : JSON.stringify(send);
};

/**
 * A Tessel's segment numbers start again at 1 when it reboots, so a verdict belongs to segment `seg` only when that one
 * ended this recently (it comes ~0.2 s after the end): 18 Nov 03:48, a reboot's scores landed on segments from 03:45.
 */
export const KWS_LATE_MS = 10_000;
/** `event/wake/kws`: the R1's on-device wake model on one segment (firmware contract). */
export interface KwsEvent {
  readonly seg?: number;
  readonly score?: number;
  readonly pass?: boolean;
  readonly name?: string;
  readonly best?: number;
  readonly ms?: number;
  readonly n?: number;
  /** The 20 ms feature frame (from the segment start) where its first scored window ends; windows are 15 apart. */
  readonly first?: number;
  /** Sent at the first window over the early threshold (`cmd/voice/kws {"early"}`), before the segment ends. */
  readonly early?: boolean;
}

/** What the confirm heard; `late`: no recogniser answered within CONFIRM_BUDGET_MS. */
interface Confirmed {
  readonly texts: ReadonlyArray<string>;
  readonly late?: true;
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
  /**
   * The confirm clip only, read by each recogniser asked (general, and his personal one): any may hear the name.
   * `each` hears every recogniser's text as it comes, so the first to hear her name need not wait for the rest.
   */
  readonly confirm: (
    pcm: Int16Array,
    each?: (text: string) => void,
  ) => Promise<ReadonlyArray<string>>;
  /**
   * `level`: how loud his name was (dBFS), so the session can tell his voice from a far-off room. `request`: on a kws
   * wake, what he said after her name in the same segment (null for her name alone), still being recognised.
   */
  readonly onWake: (
    deviceId: string,
    word: string,
    level: number,
    score: number,
    clip: Int16Array,
    request?: Promise<WakeRequest | null>,
    voice?: Promise<SpeakerIdentity | undefined>,
  ) => void;
  /**
   * Voice ID on a kws-passed segment, begun the moment it ends, beside the confirm and the request's recognition: the
   * verdict is then ready about when her brain starts, not a whole embedding after (16 Nov).
   */
  readonly voice?: (pcm: Int16Array) => Promise<SpeakerIdentity | undefined>;
  readonly log: (line: string) => void;
  /**
   * Words whose stage 1 is the Tessel's own wake model: its `event/wake/kws` pass with `best` at least `threshold`, then
   * the same confirm, on the whole segment. Only for a Tessel that has sent one; openWakeWord then only logs these words.
   * `also`: the pass is a second way in beside openWakeWord's own fire, and is always confirmed in text.
   */
  readonly kwsWake?: ReadonlyArray<{
    readonly word: string;
    readonly threshold: number;
    readonly also?: boolean;
  }>;
  /**
   * The Tessel says its kws scorer is ready (`state/voice/kws`, retained). Its first kws event cannot teach this: after
   * a restart openWakeWord's fire started every session before any came (16 Nov, 01:18).
   */
  readonly kwsReady?: (deviceId: string) => boolean;
  /** Each ended segment, for ambient presence (who is near, never the words). */
  readonly ambient?: (deviceId: string, pcm: Int16Array) => void;
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
  const ended = new Map<string, { pcm: Int16Array; woke: boolean; at: number }>();
  /** The Tessels whose `voice/wake/end` says how many frames it sent: their segments are cut to that, not to gaps. */
  const sentSeen = new Set<string>();
  /** An early kws pass's confirm, begun when it came, before the segment ended. */
  const earlyConfirm = new Map<string, Promise<Confirmed>>();
  const kwsWord = (name: unknown) =>
    deps.kwsWake?.find((w) => w.word.toLowerCase() === String(name ?? "").toLowerCase());
  const byKws = (id: string, word: string) => {
    const w = kwsWord(word);
    return (kwsSeen.has(id) || deps.kwsReady?.(id) === true) && w !== undefined && w.also !== true;
  };
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

  /**
   * The confirm, answered by the first recogniser whose text `heard` takes; with none, all their texts. `sure`: past
   * CONFIRM_BUDGET_MS with no recogniser answered, it resolves `late` instead of waiting on them.
   */
  const confirmFirst = (pcm: Int16Array, heard: (text: string) => boolean, sure = false) =>
    new Promise<Confirmed>((resolve) => {
      let answered = 0;
      const budget = sure
        ? setTimeout(() => answered === 0 && resolve({ texts: [], late: true }), CONFIRM_BUDGET_MS)
        : undefined;
      const done = (texts: ReadonlyArray<string>) => {
        clearTimeout(budget);
        resolve({ texts });
      };
      deps
        .confirm(pcm, (text) => {
          answered += 1;
          if (heard(text)) done([text]);
        })
        .then(done, () => done([]));
    });

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
    // The score goes in the line: a segment that fires gets no "wake segment" line of its own (13 Nov audit).
    const at = `${output.toFixed(3)}/${threshold} after ${(d.samples / RATE).toFixed(1)} s`;
    const rival = d.words.findIndex(
      (w, i) => w.word !== word && (d.best[i] ?? 0) >= RIVAL_SHARE * w.threshold,
    );
    if (rival >= 0) {
      const other = `${d.words[rival]!.word} ${(d.best[rival] ?? 0).toFixed(3)}/${d.words[rival]!.threshold}`;
      d.outcome = `${word} fired (${at}) with ${other}, not a wake`;
      deps.log(`[${id}] ${word} fired (${at}) but ${other} too: not sure which name, not a wake`);
      return;
    }
    const ratio = output / threshold;
    const trusted = wakeTrusted([{ word, threshold }], word, ratio);
    const heard = (text: string) => wakeWordHeard(text, word, ratio);
    const { texts, late }: Confirmed = trusted
      ? { texts: [] }
      : await confirmFirst(clip, heard, output >= SURE_OUTPUT);
    if (trusted || late === true || texts.some(heard)) {
      const how = late === true ? `${at}, recognisers over ${CONFIRM_BUDGET_MS} ms` : at;
      d.outcome = `woken by ${word} (${how})`;
      d.woke = true;
      deps.log(`[${id}] woken by ${word} (${how})`);
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

  /** The 2 s up to the passing window (the last one scored), as an openWakeWord fire's clip: the name ends it. */
  const kwsClipEnd = (event: KwsEvent, length: number) =>
    typeof event.first === "number"
      ? Math.min(length, (event.first + 15 * Math.max(0, (event.n ?? 1) - 1) + 1) * 320)
      : length;
  const kwsPass = (event: KwsEvent) => {
    const w = kwsWord(event.name);
    const best = Number(event.best ?? 0);
    if (w === undefined || event.pass !== true || best < Math.min(w.threshold, NEAR_KWS))
      return undefined;
    const near = best < w.threshold;
    // The Tessel's Alfred and Freya pass 0.99+ on his other talk (16-18 Nov), so an `also` pass is never taken unheard.
    const trusted = !near && w.also !== true && wakeTrusted([w], w.word, best / w.threshold);
    return { w, best, near, trusted };
  };
  /** What hears a kws pass's name: it said plainly, or leading his words ("Tessaya, are you there?"). */
  const hears = (word: string, ratio: number) => (text: string) =>
    wakeWordHeard(text, word, ratio) ||
    wakeWordLead(text.trim().split(/\s+/).filter(Boolean), [word]) > 0;
  const confirmClip = (
    event: KwsEvent,
    pcm: Int16Array,
    pass: NonNullable<ReturnType<typeof kwsPass>>,
  ): Promise<Confirmed> => {
    const end = kwsClipEnd(event, pcm.length);
    return pass.trusted
      ? Promise.resolve({ texts: [] })
      : confirmFirst(
          pcm.slice(Math.max(0, end - CONFIRM_SAMPLES), end),
          hears(pass.w.word, pass.best / pass.w.threshold),
          pass.w.also !== true && pass.best >= SURE_OUTPUT,
        );
  };

  /** Stage 1 by the Tessel's kws on a whole ended segment, then the same confirm as an openWakeWord fire. */
  const kwsDecide = async (
    id: string,
    event: KwsEvent,
    pcm: Int16Array,
    woke: boolean,
    endedAt: number,
  ) => {
    const pass = kwsPass(event);
    const early = earlyConfirm.get(`${id}#${event.seg}`);
    earlyConfirm.delete(`${id}#${event.seg}`);
    if (pass === undefined && event.pass === true && !woke && kwsWord(event.name) !== undefined)
      // The Tessel passes at its own lower threshold; say so, or an audit reads it as a missed wake (16 Nov seg 244).
      deps.log(
        `[${id}] seg ${event.seg} kws ${Number(event.best ?? 0).toFixed(3)} under the loop's ${kwsWord(event.name)!.threshold}; not a wake`,
      );
    if (pass === undefined || woke || pcm.length === 0) return;
    const { w, best, near, trusted } = pass;
    const voice = deps.voice?.(pcm).catch(() => undefined);
    const ratio = best / w.threshold;
    // The whole segment, for his request after her name; it also confirms a name the 2 s clip cut into.
    const whole = deps.confirm(pcm).catch((): ReadonlyArray<string> => []);
    // Under the bar, only her name leading the whole segment's words will do.
    const { texts, late }: Confirmed = near
      ? { texts: [] }
      : await (early ?? confirmClip(event, pcm, pass));
    const at = `kws ${best.toFixed(3)}/${w.threshold}, segment ${(pcm.length / RATE).toFixed(1)} s`;
    // His name then his request in one breath ("Tessaya, are you there?") leads the text instead of ending it.
    const leads = (text: string) =>
      wakeWordLead(text.trim().split(/\s+/).filter(Boolean), [w.word]) > 0;
    const heard = hears(w.word, ratio);
    if (trusted || late === true || texts.some(heard) || (await whole).some(leads)) {
      deps.log(
        `[${id}] woken by ${w.word} (${late === true ? `${at}, recognisers over ${CONFIRM_BUDGET_MS} ms` : at})`,
      );
      const request = whole.then((all) => {
        const text = requestAfterName(all, w.word);
        if (text !== null)
          deps.log(`[${id}] her name and a request in one breath (${heldBack(text)})`);
        return text === null
          ? null
          : {
              text,
              startedAt: endedAt - (pcm.length / RATE) * 1000,
              endedAt: endedAt - END_SILENCE_MS,
            };
      });
      deps.onWake(id, w.word, speechLevel(pcm), Math.min(1, best), pcm, request, voice);
    } else if (near)
      deps.log(
        `[${id}] seg ${event.seg} kws ${best.toFixed(3)} under the loop's ${w.threshold}; not a wake (her name does not lead: ${(await whole).map(heldBack).join("; ") || heldBack("")})`,
      );
    else
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
        // A Tessel that counts its frames: a gap inside a segment is a stalled link, not a lost end (16 Nov: 2.5 s
        // segments heard as 0.1-0.4 s after a 10 s hole), and the end's count drops what came before it.
        if (lost && (d.done || (d.samples > 0 && !sentSeen.has(id)))) restart(d, await d.scorer);
        d.seg = join(d.seg, pcm).slice(-KEEP_SAMPLES);
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
        const stale = ended.get(key);
        ended.delete(key);
        const done = stale !== undefined && now() - stale.at < KWS_LATE_MS ? stale : undefined;
        if (done !== undefined) {
          const d = of(id);
          d.chain = d.chain.then(() => kwsDecide(id, event, done.pcm, done.woke, done.at));
        } else if (event.early === true) {
          // At the first window over the early threshold, mid-segment: the confirm starts now, not at its end.
          const pass = kwsPass(event);
          const d = devices.get(id);
          if (pass !== undefined && !pass.near && d !== undefined)
            d.chain = d.chain.then(() => {
              if (d.seg.length >= kwsClipEnd(event, Number.POSITIVE_INFINITY))
                earlyConfirm.set(key, confirmClip(event, d.seg, pass));
              if (earlyConfirm.size > 8) earlyConfirm.delete(earlyConfirm.keys().next().value!);
            });
        }
        pair(id, event.seg, { kws: event });
      }
      deps.capture?.kws(id, event);
    },
    /**
     * The segment ended (`seg`: the R1's number for it, `sent`: its frame count): forget it, and listen afresh on the
     * next one.
     */
    end: (id: string, seg?: number, sent?: number) => {
      const d = devices.get(id);
      if (d === undefined) return;
      const endedAt = now();
      if (typeof sent === "number") sentSeen.add(id);
      d.chain = d.chain.then(async () => {
        if (typeof sent === "number" && sent > 0) d.seg = d.seg.slice(-sent * FRAME_SAMPLES);
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
            sent,
          );
        if (seg !== undefined && (deps.kwsWake?.length ?? 0) > 0) {
          const early = pairs.get(`${id}#${seg}`)?.kws;
          if (early !== undefined) await kwsDecide(id, early, d.seg, d.woke, endedAt);
          else {
            ended.set(`${id}#${seg}`, { pcm: d.seg, woke: d.woke, at: endedAt });
            if (ended.size > 8) ended.delete(ended.keys().next().value!);
          }
        }
        if (seg !== undefined) pair(id, seg, { ours });
        if (d.seg.length > 0) deps.ambient?.(id, d.seg);
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
