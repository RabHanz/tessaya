import type { RecogniserTurn } from "./roomVoice.ts";

/**
 * His recognisers (the same service his dictation uses, on more than one machine): each turn goes to the one that
 * has been answering fastest lately, skipping any that is busy or not answering, as dictation's server choice does.
 */
export interface RecogniserState {
  readonly url: string;
  /** From the last health answer: audio waiting to be decoded. Null when it did not answer. */
  readonly queue: number | null;
  /** Its last few end-of-speech-to-text times and when each was taken (epoch ms), newest last. */
  readonly recent: ReadonlyArray<{ readonly ms: number; readonly at: number }>;
}

/** Times older than this stop counting, so a recogniser that was slow once is tried again rather than never. */
export const STALE_MS = 60_000;

const median = (xs: ReadonlyArray<number>) => {
  if (xs.length === 0) return 0;
  const s = xs.toSorted((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};

/** The recogniser for the next turn: answering ones first, then the least backlog, then the fastest lately. */
export const pickRecogniser = (
  states: ReadonlyArray<RecogniserState>,
  now: number,
): RecogniserState | null => {
  const up = states.filter((s) => s.queue !== null);
  const pool = up.length > 0 ? up : states;
  let best: RecogniserState | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const s of pool) {
    // A queued decode costs about a second each; lately-measured speed decides between idle ones.
    const lately = s.recent.filter((t) => now - t.at < STALE_MS).map((t) => t.ms);
    const score = (s.queue ?? 0) * 1_000 + median(lately);
    if (score < bestScore) {
      best = s;
      bestScore = score;
    }
  }
  return best;
};

/** Keeps the last five times. */
export const noteTime = (
  recent: RecogniserState["recent"],
  ms: number,
  at: number,
): RecogniserState["recent"] => [...recent, { ms, at }].slice(-5);

/** A turn running on one recogniser, and whether that recogniser failed it (refused, unreachable, gone). */
export interface TurnOn {
  readonly url: string;
  readonly turn: RecogniserTurn & { readonly failed: () => boolean };
}

/**
 * One turn across his recognisers: it keeps its audio, so when the one it started on turns it away (his laptop
 * while he dictates) or fails, the next one hears it all and the turn is never lost. `start` opens the turn on the
 * best recogniser not yet tried; `done` hears how each try went.
 */
export const turnAcross = (
  start: (tried: ReadonlySet<string>) => TurnOn | null,
  done: (url: string, ms: number, failed: boolean, next: string | null) => void,
  clock: () => number,
): RecogniserTurn => {
  const fed: Int16Array[] = [];
  const listeners: Array<(text: string) => void> = [];
  const tried = new Set<string>();
  const open = () => {
    const on = start(tried);
    if (on === null) return null;
    tried.add(on.url);
    for (const l of listeners) on.turn.onPartial?.(l);
    return on;
  };
  let active = open();
  /** Every recogniser has been tried: each gets one more go with the whole turn, so his words are not lost. */
  let retried = false;
  return {
    feed: (pcm) => {
      fed.push(pcm);
      active?.turn.feed(pcm);
    },
    cancel: () => active?.turn.cancel(),
    onPartial: (listener) => {
      listeners.push(listener);
      active?.turn.onPartial?.(listener);
    },
    finish: async () => {
      for (;;) {
        if (active === null) return "";
        const started = clock();
        const text = await active.turn.finish();
        const ms = clock() - started;
        if (!active.turn.failed()) {
          done(active.url, ms, false, null);
          return text;
        }
        let next = open();
        // A failure is often the connection, not the recogniser (13 Nov 01:39: the R1's mic went quiet for 2.4 s while she
        // spoke and the recogniser dropped the stream): with nothing else to try, the same one hears it all again.
        if (next === null && !retried) {
          retried = true;
          tried.clear();
          next = open();
        }
        done(active.url, ms, true, next?.url ?? null);
        if (next === null) return text;
        active = next;
        for (const pcm of fed) next.turn.feed(pcm);
      }
    },
  };
};
