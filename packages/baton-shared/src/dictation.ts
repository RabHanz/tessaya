/* oxlint-disable t3code/no-low-value-comments -- Baton file predating upstream's rule (D82) */
/**
 * Dictation: the one thing that never reaches the environment.
 *
 * §12.3 keeps dictation and agent routing as different intents, and §18 makes
 * dictation a local act — text goes into whatever field the user is looking
 * at. Putting the two together gives a rule this module exists to enforce:
 *
 * > **Dictated words are resolved on the client and are never sent to an
 * > environment.**
 *
 * The reason is not architectural tidiness. "Dictate: thanks, I'll send the
 * revised contract tomorrow" is an email to someone else; it is not work, it
 * is not a prompt, and a Baton environment has no business receiving it,
 * logging it, or keeping it in an intent log. So the client runs this pass
 * first and only forwards what is left.
 *
 * The grammar is the same shape as the rest of §13: deterministic, refuses by
 * name, no model.
 *
 * @module batonDictation
 */

export type DictationCommand =
  | {
      readonly kind: "start";
      /** Text said in the same breath — "dictate: thanks, I'll send it". */
      readonly text: string | null;
    }
  /** `text` is what he said in the same breath, before the stop phrase. */
  | { readonly kind: "stop"; readonly text?: string | null }
  /** Ordinary speech while dictation mode is on. */
  | { readonly kind: "text"; readonly text: string }
  /** Not a dictation sentence at all; the caller sends it to the environment. */
  | { readonly kind: "not_dictation" };

const normalise = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();

// Words in the same breath only after a colon or a full stop ("dictate: thanks, see you"). "Dictation
// apps, which is best?" is a question for the assistant, which has dictation_start.
const START =
  /^(?:(?:i want to|i'd like to|i would like to|i need to|let me|let's|can i|start)\s+)?dictat(?:e|ing|ion)\s*(?:[:.;—]|\s-)\s*(.*)$/;
// The whole utterance or its very end, and never a bare "stop" or "done": those are words he may
// be dictating. Anything before the phrase is still text.
const STOP =
  /^(.*?)[\s,;:-]*\b(?:i'm |i am )?(?:stop|end|finish|finished|quit|done)\s+(?:with\s+)?dictat(?:e|ing|ion)(?:\s+(?:please|now|thanks))?[\s.!?]*$/;

/** A bare stop and nothing else: "stop", "cancel", "never mind", "be quiet", with please. Wake word stripped. */
export const isBareStop = (utterance: string): boolean =>
  /^(?:please\s+)?(?:stop|cancel|never ?mind|be quiet|quiet|that'?s enough)(?:\s+please)?[\s.!?]*$/i.test(
    utterance.trim(),
  );

const INTENT_PREFIX =
  /^(?:(?:i meant to|i mean to|i want to|i'd like to|i would like to|i need to|let me|let's|lets|can you|could you|would you|please|start|take|go into|go to|switch to|enter|begin|time to)\s+)+/;
const DICTATE_FORMS = new Set([
  "dictate",
  "dictates",
  "dictated",
  "dictator",
  "dictating",
  "dictation",
]);
const TAIL = new Set(["this", "now", "please", "mode", "thanks", "for", "me"]);

const withinOne = (a: string, b: string): boolean => {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
    } else {
      edits += 1;
      if (edits > 1) return false;
      if (a.length > b.length) i += 1;
      else if (b.length > a.length) j += 1;
      else {
        i += 1;
        j += 1;
      }
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
};

/**
 * The whole utterance is a wish to dictate, however it was heard: "dictator", "I meant to dictate",
 * "start dictation", "dick tate". Never inside a longer sentence, so "the dictator of Rome" is not.
 */
const wantsToDictate = (text: string): boolean => {
  const intent = text.replace(/[.!?,]+$/g, "").replace(/\bdick tate\b/g, "dictate");
  const rest = intent.replace(INTENT_PREFIX, "");
  const words = rest.split(" ").filter((word) => word.length > 0);
  const [head, ...tail] = words;
  if (head === undefined) return false;
  if (!(DICTATE_FORMS.has(head) || withinOne(head, "dictate"))) return false;
  return tail.every((word) => TAIL.has(word));
};

/**
 * Classify one utterance.
 *
 * `dictating` is the mode the client is already in, and it changes the answer:
 * while dictation is on, ordinary words are text rather than instructions.
 * That is §12.3's conversation-mode rule, and it is why the caller owns the
 * mode and this function only reads it.
 */
export const classifyDictation = (
  utterance: string,
  input: { readonly dictating: boolean },
): DictationCommand => {
  const raw = utterance.trim();
  const text = normalise(raw);
  if (text.length === 0) {
    return input.dictating ? { kind: "text", text: raw } : { kind: "not_dictation" };
  }

  // "Stop dictating" is checked first and works in both modes: a user who says
  // it when dictation is already off has still made themselves clear.
  const stop = STOP.exec(text);
  if (stop !== null) {
    const head = (stop[1] ?? "").trim();
    return { kind: "stop", ...(head.length === 0 ? {} : { text: restoreCase(raw, head) }) };
  }

  const start = START.exec(text);
  if (start !== null) {
    const tail = (start[1] ?? "").trim();
    // Give the tail its original characters back: this text is going into
    // somebody's email, and lower-casing it would be rude.
    const onlyFiller = tail.split(/\s+/).every((word) => TAIL.has(word.replace(/[.!?,]+$/g, "")));
    const spoken = tail.length === 0 || onlyFiller ? null : restoreCase(raw, tail);
    return { kind: "start", text: spoken };
  }

  if (!input.dictating && wantsToDictate(text)) return { kind: "start", text: null };

  return input.dictating ? { kind: "text", text: raw } : { kind: "not_dictation" };
};

/**
 * Give a lower-cased fragment its original characters back.
 *
 * The grammar works on normalised text; what reaches the field should be what
 * the user actually said.
 */
const restoreCase = (source: string, fragment: string): string => {
  // The fragment is in `normalise`'s form: walk the source the same way, keeping where each character came from, so
  // curly apostrophes, line breaks and double spaces still find their place and his case comes back.
  let norm = "";
  const from: number[] = [];
  let space = false;
  for (let i = 0; i < source.length; i += 1) {
    const c = source[i]!;
    if (/\s/.test(c)) {
      if (norm !== "" && !space) {
        norm += " ";
        from.push(i);
      }
      space = true;
      continue;
    }
    space = false;
    norm += (c === "‘" || c === "’" ? "'" : c).toLowerCase();
    from.push(i);
  }
  const index = norm.indexOf(fragment.toLowerCase());
  if (index === -1 || fragment.length === 0) return fragment;
  return source.slice(from[index]!, from[index + fragment.length - 1]! + 1).trim();
};

/**
 * The one spoken command while a key or button dictation records: a whole "stop dictation", said on its own. Nothing
 * spoken discards (only ✕ or Esc twice): "cancel", "scratch that" and "no wait" are his words or a self-correction,
 * which the clean-up resolves.
 */
export const keyDictationCommand = (utterance: string): "stop" | null => {
  if (normalise(utterance) === "") return null;
  const d = classifyDictation(utterance, { dictating: true });
  return d.kind === "stop" && d.text === undefined ? "stop" : null;
};

/** The words before the last "stop dictation": the helper wrote it down too, and what came after it. */
export const beforeSpokenStop = (text: string): string => {
  const said = /[\s,;:-]*\b(?:stop|end|finish)\s+dictat(?:e|ing|ion)\b/gi;
  let last = -1;
  for (const m of text.matchAll(said)) last = m.index;
  return last === -1 ? text : text.slice(0, last).trim();
};

/**
 * True when this utterance must be handled locally and must not be sent to an
 * environment. The caller's gate, in one function, so the rule is enforced in
 * one place rather than remembered in several.
 */
export const staysLocal = (command: DictationCommand): boolean => command.kind !== "not_dictation";
