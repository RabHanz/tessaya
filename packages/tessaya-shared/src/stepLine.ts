/**
 * The one line a lesson or a drive says and shows for a step (teach design, "Speech"): the card's sentence
 * and the spoken sentence are the same short sentence, never a paragraph read aloud. What the model wrote
 * at length stays in the turn log. Also the plain words for a failure, so nobody hears or reads a raw error.
 */
const FILLER = /^(?:okay|ok|alright|all right|sure|great|now|so|right|well)[,.!]?\s+/i;

export const STEP_WORDS = 14;

/** The first sentence, without a filler opening, cut at a word boundary to at most `maxWords` words. */
export const stepLine = (text: string, maxWords: number = STEP_WORDS): string => {
  const flat = text.replace(/\s+/g, " ").trim().replace(FILLER, "");
  if (flat === "") return "";
  const first = /^.*?[.!?](?=\s|$)/.exec(flat)?.[0] ?? flat;
  const words = first.split(" ");
  if (words.length <= maxWords) return first;
  // Cut at the last comma inside the limit when there is one, else at the limit.
  const head = words.slice(0, maxWords).join(" ");
  const comma = head.lastIndexOf(",");
  const cut = comma > head.length / 2 ? head.slice(0, comma) : head.replace(/[,;:]$/, "");
  return `${cut}.`;
};

const SOUNDS_RAW =
  /\b(?:E[A-Z]{3,}|at\s+\S+\s+\(|stack|exception|undefined|\[object|TypeError|SyntaxError|exit code|spawn|JSON)\b|[{}<>]|\bnode:/i;

/** The kind of failure, for diagnostics that must carry no message text. */
export const errorCode = (
  message: string,
): "claude_missing" | "timeout" | "claude_stopped" | "other" => {
  const m = message.trim();
  if (/ENOENT|not found|is not recognized|cannot find/i.test(m) && /claude|codex/i.test(m))
    return "claude_missing";
  if (/time(?:d)? ?out|took too long|ETIMEDOUT/i.test(m)) return "timeout";
  if (/^claude stopped/i.test(m)) return "claude_stopped";
  return "other";
};

/** A failure in plain words. A message that already reads like a sentence for a person passes through. */
export const plainError = (message: string): string => {
  const m = message.trim();
  if (/ENOENT|not found|is not recognized|cannot find/i.test(m) && /claude|codex/i.test(m)) {
    return "Claude isn't installed or isn't signed in on this computer, so I couldn't do that.";
  }
  if (/time(?:d)? ?out|took too long|ETIMEDOUT/i.test(m))
    return "That took too long, so I stopped. Nothing else was changed.";
  if (/^claude stopped/i.test(m))
    return "Claude stopped before it answered. Say it again if you want to try once more.";
  if (m === "" || m.length > 160 || SOUNDS_RAW.test(m)) {
    return "Something went wrong with that, so I stopped. Nothing was changed. Say it again, or tell me to stop.";
  }
  return m;
};
