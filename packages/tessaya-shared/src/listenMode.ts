/**
 * Listen mode (M-135, 21 Nov): he thinks out loud, she only listens, then answers the whole thought once. It starts on
 * a phrase ("just listen") or her `listen_start` tool, and ends on an end phrase ("over to you"), after a silence he
 * sets, or at a hard limit. Phrases and what she does after are data; a member's preferences extend them. Pure, so the
 * room loop and the desktop's mode machine decide the same way.
 */
import { isCancelPhrase } from "./voiceTurn.ts";
import { stopIntent } from "./stopPhrases.ts";

export const LISTEN_STARTS: ReadonlyArray<string> = [
  "just listen",
  "listen for a bit",
  "listen for a minute",
  "listen for a while",
  "let me think out loud",
  "let me think aloud",
  "i'm going to think out loud",
  "i want to think out loud",
  "let me brainstorm",
  "let me brainstorm out loud",
  "don't answer yet",
  "don't reply yet",
  "hold your answer",
  "bear with me",
];

export const LISTEN_ENDS: ReadonlyArray<string> = [
  "over to you",
  "that's it",
  "that's the thought",
  "that's my thought",
  "your turn",
  "what do you think",
  "go ahead",
];

/** What she does with the whole thought, one line each to the brain. A new behaviour is a new row. */
export const LISTEN_AFTER: ReadonlyArray<{ readonly id: string; readonly line: string }> = [
  { id: "summarise", line: "Say the thought back in a sentence or two, in his own words." },
  {
    id: "ask",
    line: "Then ask the one question that matters most, if there is one; never several.",
  },
  {
    id: "start",
    line: "If he asked for the work to begin, start it as you would any job, and say so.",
  },
];

export const LISTEN_WAIT_DEFAULT_S = 20;
const WAIT_MIN_S = 5;
const WAIT_MAX_S = 120;
/** However long the silences, a thought ends here. */
export const LISTEN_LIMIT_MS = 20 * 60_000;

/** His silence setting ("30", "30 seconds", "a minute") as milliseconds, kept within 5 s and 2 min. */
export const listenWaitMs = (pref: string | undefined): number => {
  const p = (pref ?? "").toLowerCase();
  const n = /\bminute\b/.test(p) && !/\d/.test(p) ? 60 : Number.parseFloat(p);
  const s = Number.isFinite(n)
    ? /\bmin/.test(p) && /\d/.test(p)
      ? n * 60
      : n
    : LISTEN_WAIT_DEFAULT_S;
  return Math.round(Math.min(WAIT_MAX_S, Math.max(WAIT_MIN_S, s)) * 1000);
};

/** His own phrases from a preference ("your turn, done thinking"): comma or semicolon separated. */
export const listenPhrases = (pref: string | undefined): ReadonlyArray<string> =>
  (pref ?? "")
    .split(/[,;\n]/)
    .map((p) => plain(p))
    .filter((p) => p !== "")
    .slice(0, 10);

const plain = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^a-z0-9' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A phrase's words with anything that is not a letter between them, as the recogniser punctuates them. */
const alts = (phrases: ReadonlyArray<string>) =>
  [...new Set(phrases.map(plain).filter((p) => p !== ""))]
    .toSorted((a, b) => b.length - a.length)
    .map((p) => p.split(" ").map(escape).join("[^a-z0-9']+"))
    .join("|");

const GAP = "[^a-z0-9']+";
const LEAD = `(?:(?:okay|ok|so|hey|right|alright|and|now|please|well|um+|uh+)${GAP})*`;
const TAIL_WORDS =
  "please|now|then|for a bit|for a minute|for a moment|for a second|for a sec|a sec|okay|ok|thanks|thank you";
const TAIL = `(?:${GAP}(?:${TAIL_WORDS}))*`;
const ONLY_TAIL = new RegExp(`^(?:(?:${TAIL_WORDS})(?: |$))*$`);

export type ListenWords =
  | { readonly kind: "start"; readonly text: string }
  | { readonly kind: "end"; readonly text: string }
  | { readonly kind: "cancel" }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "none" };

export interface ListenOptions {
  readonly listening: boolean;
  /** His own phrases, beside the built-in ones. */
  readonly starts?: ReadonlyArray<string>;
  readonly ends?: ReadonlyArray<string>;
  /** Her names, which may lead the line ("Freya, just listen"). */
  readonly names?: ReadonlyArray<string>;
}

const norm = (t: string) => t.toLowerCase().replace(/[’‘]/g, "'");

/**
 * One line, read for listen mode. Not listening: a start only when the line opens with a start phrase and stops there
 * or goes on after a mark ("Just listen. So I've been thinking…"), never inside a sentence ("you never just listen").
 * Listening: an end phrase closing the line keeps the words before it; a cancel drops the thought; anything else is
 * his thought.
 */
export const classifyListen = (text: string, options: ListenOptions): ListenWords => {
  const raw = text.trim();
  const said = norm(raw);
  if (!options.listening) {
    const names = (options.names ?? []).map(plain).filter((n) => n !== "");
    const name = names.length === 0 ? "" : `(?:(?:${alts(names)})${GAP})?`;
    const start = new RegExp(
      `^[^a-z0-9']*${LEAD}${name}${LEAD}(?:${alts([...LISTEN_STARTS, ...(options.starts ?? [])])})${TAIL}(?:[^a-z0-9'\\s]*\\s*$|\\s*[.:;,!?…\\u2014-]+\\s*([\\s\\S]+)$)`,
    );
    const m = start.exec(said);
    if (m === null) return { kind: "none" };
    const rest = m[1] === undefined ? "" : raw.slice(raw.length - m[1].length).trim();
    return { kind: "start", text: ONLY_TAIL.test(plain(rest)) ? "" : rest };
  }
  const words = plain(raw);
  if (words === "") return { kind: "none" };
  if (isCancelPhrase(raw) || stopIntent(raw) === "dismiss") return { kind: "cancel" };
  const end = new RegExp(
    `(?:^|(?<=[.!?;,…\\u2014-])\\s*|\\b(?:okay|ok|so|right|alright|anyway|and)${GAP})(?:${alts([...LISTEN_ENDS, ...(options.ends ?? [])])})${TAIL}[^a-z0-9']*$`,
  );
  const m = end.exec(said);
  if (m === null) return { kind: "text", text: raw };
  return {
    kind: "end",
    text: raw
      .slice(0, m.index)
      .replace(/[\s,;:\u2014-]+$/, "")
      .trim(),
  };
};

export interface ListenState {
  readonly lines: ReadonlyArray<string>;
  readonly startedAt: number;
  readonly lastAt: number;
}

export type ListenEvent =
  | { readonly type: "start"; readonly at: number; readonly text?: string }
  | { readonly type: "utterance"; readonly text: string; readonly at: number }
  | { readonly type: "tick"; readonly at: number }
  | { readonly type: "cancel" };

export type ListenOutput =
  /** Listening began. */
  | { readonly kind: "started" }
  /** A line kept: a soft cue, no words. */
  | { readonly kind: "ack" }
  /** The thought is whole: one turn with these words. */
  | { readonly kind: "done"; readonly text: string; readonly why: "end" | "silence" | "limit" }
  /** Dropped on his cancel, or a silence with nothing said. */
  | { readonly kind: "cancelled"; readonly lines: ReadonlyArray<string> }
  /** Not for listen mode: the caller goes on as usual. */
  | { readonly kind: "pass" };

export interface ListenConfig extends Omit<ListenOptions, "listening"> {
  readonly waitMs: number;
  readonly after?: ReadonlyArray<{ readonly id: string; readonly line: string }>;
}

/** The turn the brain gets: one framing line, then his whole thought in order. */
export const listenTurn = (
  lines: ReadonlyArray<string>,
  ms: number,
  after: ReadonlyArray<{ readonly line: string }> = LISTEN_AFTER,
): string => {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return `[He asked you to only listen while he thought out loud (about ${minutes} minute${minutes === 1 ? "" : "s"}); here is all of it, in order. Answer the whole thought, not its last line, in under 60 spoken words. ${after.map((a) => a.line).join(" ")}]\n\n${lines.join(" ")}`;
};

const finish = (
  s: ListenState,
  at: number,
  why: "end" | "silence" | "limit",
  config: ListenConfig,
): { readonly state: null; readonly out: ListenOutput } =>
  s.lines.length === 0
    ? { state: null, out: { kind: "cancelled", lines: [] } }
    : {
        state: null,
        out: { kind: "done", text: listenTurn(s.lines, at - s.startedAt, config.after), why },
      };

/** One step of listen mode. `null` is not listening. */
export const listenStep = (
  state: ListenState | null,
  event: ListenEvent,
  config: ListenConfig,
): { readonly state: ListenState | null; readonly out: ListenOutput } => {
  switch (event.type) {
    case "start": {
      const text = event.text?.trim() ?? "";
      return {
        state: { lines: text === "" ? [] : [text], startedAt: event.at, lastAt: event.at },
        out: { kind: "started" },
      };
    }
    case "cancel":
      return state === null
        ? { state, out: { kind: "pass" } }
        : { state: null, out: { kind: "cancelled", lines: state.lines } };
    case "tick":
      if (state === null) return { state, out: { kind: "pass" } };
      if (event.at - state.startedAt >= LISTEN_LIMIT_MS)
        return finish(state, event.at, "limit", config);
      if (event.at - state.lastAt >= config.waitMs)
        return finish(state, event.at, "silence", config);
      return { state, out: { kind: "pass" } };
    case "utterance": {
      const words = classifyListen(event.text, { ...config, listening: state !== null });
      if (state === null)
        return words.kind === "start"
          ? listenStep(null, { type: "start", at: event.at, text: words.text }, config)
          : { state, out: { kind: "pass" } };
      if (words.kind === "cancel")
        return { state: null, out: { kind: "cancelled", lines: state.lines } };
      if (words.kind === "none") return { state, out: { kind: "ack" } };
      const next = {
        ...state,
        lines: words.text === "" ? state.lines : [...state.lines, words.text],
        lastAt: event.at,
      };
      if (words.kind === "end") return finish(next, event.at, "end", config);
      return event.at - state.startedAt >= LISTEN_LIMIT_MS
        ? finish(next, event.at, "limit", config)
        : { state: next, out: { kind: "ack" } };
    }
  }
};
