/**
 * When has he finished? The microphone only knows about silence; the words say more. A sentence
 * that ends on "and" or "the" is not over after a breath, a finished question is.
 */

/** Speech that resumes this soon after a turn ended belongs to the same turn. */
export const JOIN_WITHIN_MS = 2_500;
export const WAIT_DEFAULT_MS = 1_500;
export const WAIT_MIN_MS = 800;
export const WAIT_MAX_MS = 3_000;

const OPEN_END =
  /(?:^|\s)(?:and|the|an|to|of|because|but|or|so|that|which|with|if|when|like|i|my|um+|uh+|er+|for|in|on|at|is|are|was|then|as|than|about|what's|whats|how|where|why)$/i;

export const clampWait = (ms: number): number =>
  Math.min(WAIT_MAX_MS, Math.max(WAIT_MIN_MS, Number.isFinite(ms) ? ms : WAIT_DEFAULT_MS));

const words = (text: string): number => text.trim().split(/\s+/).filter(Boolean).length;

/**
 * "Look," or "so," and a pause: what he means comes next, however the recogniser punctuated it ("Look. What?").
 * Not "okay" or "right": those are whole replies.
 */
const LEAD_ONLY =
  /^(?!so what\?$)(?:look|so|well|listen|anyway|um+|uh+)\b[\s,.!?…]*(?:\S+[\s.!?…]*)?$/i;

/**
 * No sentence ends here, whatever full stop the recogniser added ("Open the.", "and then."). "I think so.",
 * "Even so." and "I need to." do; so do "plan A." and "plan a.".
 */
const DANGLING =
  /(?:^|\s)(?:and|or|but|because|the|an|my|your|of|(?:and|but) then|um+|uh+|er+|(?<!\b(?:need|needs|have|has|had|want|wants|love|like|going|got|ought|used|able)\s)to|(?<!\b(?:think|hope|guess|suppose|believe|said|do|not|so|and|or|even|okay|ok|that)\s)so)$/i;
/** A lone article, in lower case and not naming a choice ("plan a", "option A"). */
const DANGLING_A = /(?:^|(?<!\b(?:plan|option|vitamin|type|grade|class|section|part|point))\s)a$/;

/** Words a question may end on ("Who is he with?", "What's it like?"); any other open end leaves it open. */
const ASKS_END = /(?:^|\s)(?:with|for|to|of|from|about|that|like|why|where|when)$/i;
/** A question cut off before what it compares or depends on ("Is it bigger than?", "Can you check if?"). */
const ASKS_MORE = /(?:^|\s)(?:than|if|as)$/i;
/** "Can you tell me about?": the subject is still to come. */
const TOLD_ABOUT = /\b(?:tell|ask|show)\s+(?:me|us|him|her|them)\s+about$/i;

/** "Can you", "could you please": a request whose verb is still to come. */
const OPEN_REQUEST = /(?:^|\s)(?:can|could|would|will)\s+(?:you|we|i)(?:\s+please)?$/i;

const bareOf = (t: string): string => t.replace(/[.!?…"')\]]+$/, "");

/** The words end on one that leaves the sentence open, read by the mark the recogniser closed it with. */
const trailsOff = (t: string): boolean => {
  const bare = bareOf(t);
  const dangling = DANGLING.test(bare) || DANGLING_A.test(bare);
  if (t.endsWith("?"))
    return (dangling && !ASKS_END.test(bare)) || ASKS_MORE.test(bare) || TOLD_ABOUT.test(bare);
  return dangling || OPEN_REQUEST.test(bare) || (OPEN_END.test(bare) && !/[.!]$/.test(t));
};

/** "What's going on?", "Where am I?": a whole question, but one that often goes on, so it gets the usual wait. */
const mayGoOn = (t: string): boolean =>
  t.endsWith("?") &&
  ((OPEN_END.test(bareOf(t)) && !ASKS_END.test(bareOf(t))) || OPEN_REQUEST.test(bareOf(t)));

/**
 * The words stop mid-thought: a joining word, a comma, a lone opener, or a last sentence that is a short fragment
 * with no full stop ("…the dictation feature. Can you").
 */
export const isUnfinished = (text: string): boolean => {
  const t = text.trim();
  if (t.length === 0) return false;
  if (/[,;:—-]$/.test(t) || LEAD_ONLY.test(t) || trailsOff(t)) return true;
  return !/[.!?…]$/.test(t) && words(t.split(/[.!?…]\s+/).at(-1) ?? t) <= 6;
};

/** A whole sentence, or a question ("What time?", "Who is he with?"), closed with its own mark. */
export const isComplete = (text: string): boolean => {
  const t = text.trim();
  if (!/[.!?]$/.test(t) || trailsOff(t) || mayGoOn(t)) return false;
  return t.endsWith("?") ? words(t) >= 2 : words(t) >= 3 && !OPEN_END.test(t.replace(/[.!]+$/, ""));
};

/**
 * Silence, from the end of his last word, after which this turn is final. `base` is his setting.
 */
export const commitMs = (base: number, text: string): number => {
  const b = clampWait(base);
  if (isUnfinished(text)) return Math.min(b * 2, WAIT_MAX_MS + 1_500);
  if (isComplete(text)) return Math.max(WAIT_MIN_MS, b * 0.55);
  return b;
};

/**
 * Silence after his last word at which the reply is thought out ahead (read only, nothing said or done):
 * at once when the words read as finished, after his usual pause when they trail off.
 */
export const thinkAheadMs = (base: number, text: string): number =>
  isUnfinished(text) ? clampWait(base) : 0;

/** A sentence of hers as it plays: when its audio started and how far the audio sent so far reaches. */
export interface Playing {
  readonly text: string;
  readonly from: number | null;
  readonly until: number;
}

/** What she had said when he talked over her, and the wake word of the persona who was saying it. */
export interface CutIn {
  readonly said: string;
  readonly by: string | null;
}

/** A slow speaking pace: a sentence lasts at least this long a word, however little of its audio has arrived. */
const MS_PER_WORD = 380;

/**
 * What she had said when he cut in at `at`: the sentences played, and the one playing cut at the word its audio
 * had reached. Its length is the audio sent so far or its words at a slow pace, whichever is longer, since the
 * audio streams in while it plays. Without audio times (the system voice), the whole of it.
 * shortcut: assumes even speech through a sentence; upgrade to word timings if the voice ever reports them.
 */
export const heardUntil = (
  played: ReadonlyArray<string>,
  playing: Playing | null,
  at: number,
): string => {
  if (playing === null) return played.join(" ");
  const all = playing.text.trim().split(/\s+/).filter(Boolean);
  const length = Math.max(playing.until - (playing.from ?? 0), all.length * MS_PER_WORD);
  const share = playing.from === null ? 1 : Math.min(1, Math.max(0, (at - playing.from) / length));
  const n = Math.ceil(share * all.length);
  const part = n >= all.length ? all.join(" ") : n === 0 ? "" : `${all.slice(0, n).join(" ")}…`;
  return [...played, part].filter((s) => s !== "").join(" ");
};

/**
 * The line before his words when he cut her off, so the turn carries on from where she was. Her words are
 * quoted as data: they may hold text read out from an email or a page. `by` names another persona who was speaking.
 */
export const cutInLine = (said: string, by: string | null): string =>
  `he cut in while ${by === null ? "you were" : `${by} was`} saying: ${JSON.stringify(said)}`;
