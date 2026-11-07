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
 * "Even so." and "I need to." do; so does "plan A.", which is why a lone "a" counts only in lower case.
 */
const DANGLING =
  /(?:^|\s)(?:and|or|but|because|the|an|my|your|of|(?:and|but) then|um+|uh+|er+|(?<!\b(?:need|needs|have|has|had|want|wants|love|like|going|got|ought|used|able)\s)to|(?<!\b(?:think|hope|guess|suppose|believe|said|do|not|so|and|or|even|okay|ok)\s)so)$/i;
const DANGLING_A = /(?:^|\s)a$/;

/** Words a question may end on ("Who is he with?", "What's it like?"); any other open end leaves it open. */
const ASKS_END = /(?:^|\s)(?:with|for|to|of|from|about|that|like|why|where|when)$/i;
/** Except "tell me about?": the subject is still to come. */
const TOLD_ABOUT = /\b(?:tell|ask|show)\s+(?:me|us|him|her|them)\s+about$/i;

/** The words end on one that leaves the sentence open, read by the mark the recogniser closed it with. */
const trailsOff = (t: string): boolean => {
  const bare = t.replace(/[.!?…"')\]]+$/, "");
  const dangling = DANGLING.test(bare) || DANGLING_A.test(bare);
  if (t.endsWith("?"))
    return (dangling || OPEN_END.test(bare)) && (!ASKS_END.test(bare) || TOLD_ABOUT.test(bare));
  return dangling || (OPEN_END.test(bare) && !/[.!]$/.test(t));
};

/** The words stop mid-thought: a joining word, a comma, a lone opener, or a short fragment with no full stop. */
export const isUnfinished = (text: string): boolean => {
  const t = text.trim();
  if (t.length === 0) return false;
  if (/[,;:—-]$/.test(t) || LEAD_ONLY.test(t) || trailsOff(t)) return true;
  return !/[.!?…]$/.test(t) && words(t) <= 6;
};

/** A whole sentence, or a question ("What time?", "Who is he with?"), closed with its own mark. */
export const isComplete = (text: string): boolean => {
  const t = text.trim();
  if (!/[.!?]$/.test(t) || trailsOff(t)) return false;
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
