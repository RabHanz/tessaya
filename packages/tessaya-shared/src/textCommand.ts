/**
 * Command mode (Wispr parity): spoken edits on the text around the caret or the selection in the
 * focused app. "Delete the last word", "select the previous paragraph", "make this more concise".
 * Pure: what a sentence means, and the text surgery that keys cannot do. The desktop does the
 * keys, the clipboard and the model.
 */
export type TextUnit = "word" | "sentence" | "line" | "paragraph";

export type TextCommand =
  /** Keys that do it in any editor; the description is what is said back. */
  | { readonly kind: "keys"; readonly keys: ReadonlyArray<string>; readonly done: string }
  /** Several presses, in order. */
  | {
      readonly kind: "sequence";
      readonly steps: ReadonlyArray<ReadonlyArray<string>>;
      readonly done: string;
    }
  /** Remove the last sentence, line or paragraph before the caret (or in the selection). */
  | { readonly kind: "delete"; readonly unit: "sentence" | "line" | "paragraph" }
  /** Anything else about the text: the model does it. */
  | { readonly kind: "rewrite"; readonly instruction: string };

const norm = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:please |can you |could you |just )+/, "")
    .replace(/ (?:please|thanks|now)$/, "");

const UNIT = "(word|sentence|line|paragraph)";

/** What a spoken edit means; null when it is not an edit of the text. */
export const parseTextCommand = (said: string): TextCommand | null => {
  const t = norm(said);
  if (t === "") return null;
  const del = new RegExp(
    `^(?:delete|remove|erase|scratch) (?:the |that )?(?:last|previous) ${UNIT}$`,
  ).exec(t);
  if (del !== null) {
    const unit = del[1] as TextUnit;
    return unit === "word"
      ? {
          kind: "sequence",
          steps: [["ctrl", "shift", "left"], ["backspace"]],
          done: "Deleted the last word.",
        }
      : { kind: "delete", unit };
  }
  const sel = new RegExp(`^select (?:the )?(last|previous) ${UNIT}$`).exec(t);
  if (sel !== null) {
    const unit = sel[2] as TextUnit;
    return {
      kind: "keys",
      keys:
        unit === "word"
          ? ["ctrl", "shift", "left"]
          : unit === "line"
            ? ["shift", "home"]
            : ["ctrl", "shift", "up"],
      done: `Selected the ${sel[1]} ${unit}.`,
    };
  }
  const simple: Array<[RegExp, TextCommand]> = [
    [/^select all$/, { kind: "keys", keys: ["ctrl", "a"], done: "Selected everything." }],
    [
      /^(?:delete|remove|clear) (?:that|this|it|the selection|the selected text)$/,
      { kind: "keys", keys: ["delete"], done: "Deleted the selection." },
    ],
    [
      /^(?:copy) (?:that|this|it|the selection)$/,
      { kind: "keys", keys: ["ctrl", "c"], done: "Copied." },
    ],
    [
      /^(?:cut) (?:that|this|it|the selection)$/,
      { kind: "keys", keys: ["ctrl", "x"], done: "Cut." },
    ],
    [
      /^(?:go to |jump to )?(?:the )?end of (?:the )?(?:line)$/,
      { kind: "keys", keys: ["end"], done: "At the end of the line." },
    ],
    [
      /^(?:go to |jump to )?(?:the )?(?:start|beginning) of (?:the )?(?:line)$/,
      { kind: "keys", keys: ["home"], done: "At the start of the line." },
    ],
    [
      /^(?:go to |jump to )?(?:the )?end of (?:the )?(?:document|text|page)$/,
      { kind: "keys", keys: ["ctrl", "end"], done: "At the end." },
    ],
    [
      /^(?:go to |jump to )?(?:the )?(?:start|beginning|top) of (?:the )?(?:document|text|page)$/,
      { kind: "keys", keys: ["ctrl", "home"], done: "At the start." },
    ],
  ];
  for (const [re, cmd] of simple) if (re.test(t)) return cmd;
  const rewrite =
    /^(?:make (?:this|it|that|the selection)\b.+|rewrite\b.+|rephrase\b.+|reword\b.+|fix (?:the |this |its )?(?:grammar|spelling|typos?|punctuation)\b.*|turn (?:this|it|that) into\b.+|translate (?:this|it|that)?\s*(?:to|into)\b.+|change (?:this|it|that)\b.+|shorten (?:this|it|that)\b.*|expand (?:this|it|that)\b.*|summari[sz]e (?:this|it|that)\b.*|simplify (?:this|it|that)\b.*|add\b.+ to (?:this|it|that)|remove\b.+ from (?:this|it|that))$/.test(
      t,
    );
  return rewrite ? { kind: "rewrite", instruction: said.trim().replace(/[.!?]+$/, "") } : null;
};

/** Sentences with their trailing space, so joining them gives the text back. */
export const sentencesOf = (text: string): ReadonlyArray<string> =>
  text.match(/[^.!?\n]+[.!?]*["')\]]*\s*|\n+/g) ?? (text === "" ? [] : [text]);

/**
 * The text with its last sentence, line or paragraph taken out. Null when there is nothing to take:
 * the caller then leaves the text alone.
 */
export const deleteLastUnit = (
  text: string,
  unit: "sentence" | "line" | "paragraph",
): string | null => {
  const body = text.replace(/\s+$/, "");
  const tail = text.slice(body.length);
  if (body === "") return null;
  if (unit === "paragraph") {
    const at = body.lastIndexOf("\n\n");
    return at < 0 ? "" : body.slice(0, at) + tail.replace(/^[^\n]*/, "");
  }
  if (unit === "line") {
    const at = body.lastIndexOf("\n");
    return at < 0 ? "" : body.slice(0, at);
  }
  const parts = sentencesOf(body).filter((p) => !/^\n+$/.test(p) || true);
  const last = parts.at(-1);
  if (last === undefined) return null;
  const kept = body.slice(0, body.length - last.length);
  return kept.replace(/[ \t]+$/, "");
};
