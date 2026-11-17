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
  /** Runs his own fine-tuned model: it hears only his held voice, since it writes words from faint or other voices. */
  readonly personal?: boolean;
}

/** The recognisers a turn may use: his personal ones when it is his voice and one answers, else the general ones. */
export const recognisersFor = (
  states: ReadonlyArray<RecogniserState>,
  owner: boolean,
): ReadonlyArray<RecogniserState> => {
  const general = states.filter((s) => s.personal !== true);
  const mine = owner ? states.filter((s) => s.personal === true && s.queue !== null) : [];
  return mine.length > 0 ? mine : general;
};

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

/** How long his turn waits on his personal model once it ends, before the general words will do. */
export const PERSONAL_BUDGET_MS = 700;

/** The first of these to bring words; null once all came back empty. */
const firstWords = <W>(tries: ReadonlyArray<Promise<W | null>>) =>
  new Promise<W | null>((resolve) => {
    let left = tries.length;
    for (const t of tries)
      void t.then((w) => (w !== null ? resolve(w) : --left === 0 && resolve(null)));
  });

/**
 * His turn on his personal model and a general one at once (23:30, 17 Nov: his took 5.3 s, a general one 0.6 s): his
 * words when they come within `budget`, else whichever answers first. Partials come from the general one.
 */
export const hedge = (
  personal: RecogniserTurn,
  general: RecogniserTurn,
  budget: () => Promise<void>,
  won: (who: "personal" | "general") => void,
): RecogniserTurn => {
  let taken: "personal" | "general" | null = null;
  return {
    feed: (pcm) => {
      personal.feed(pcm);
      general.feed(pcm);
    },
    cancel: () => {
      personal.cancel();
      general.cancel();
    },
    onPartial: (listener) => general.onPartial?.(listener),
    by: () =>
      taken === null
        ? null
        : { host: (taken === "personal" ? personal : general).by?.()?.host ?? null, hedge: taken },
    finish: async () => {
      const heard = (who: "personal" | "general", turn: RecogniserTurn) =>
        turn.finish().then(
          (text) => (text.trim() === "" ? null : { who, text }),
          () => null,
        );
      const mine = heard("personal", personal);
      const theirs = heard("general", general);
      const best =
        (await Promise.race([mine, budget().then(() => null)])) ??
        (await firstWords([mine, theirs]));
      if (best === null) return "";
      taken = best.who;
      won(best.who);
      return best.text;
    },
  };
};

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
  let answered: string | null = null;
  return {
    feed: (pcm) => {
      fed.push(pcm);
      active?.turn.feed(pcm);
    },
    by: () => (answered === null ? null : { host: answered.replace(/^wss?:\/\//, "") }),
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
          answered = active.url;
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
