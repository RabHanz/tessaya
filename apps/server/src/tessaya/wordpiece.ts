/**
 * BERT's uncased WordPiece tokenizer, as bge-small-en-v1.5 was trained with it (BertTokenizer, do_lower_case): clean the
 * text, space out CJK characters, lowercase and strip accents, split on punctuation, then greedy longest-match pieces
 * with "##" for the rest of a word. Pure; the vocabulary (vocab.txt, one token per line) is passed in.
 */

export interface WordPiece {
  /** [CLS] ids [SEP], at most `maxTokens` in all; the mask is all ones (one sentence, no padding). */
  readonly encode: (text: string, maxTokens?: number) => ReadonlyArray<number>;
}

const MAX_WORD_CHARS = 100;

const isWhitespace = (ch: string) => /\s/u.test(ch);
const isControl = (ch: string) =>
  ch !== "\t" && ch !== "\n" && ch !== "\r" && /\p{Cc}|\p{Cf}/u.test(ch);
const isPunctuation = (ch: string) => {
  const code = ch.codePointAt(0)!;
  // BERT counts every non-letter, non-digit ASCII symbol as punctuation, as well as Unicode P*.
  if (
    (code >= 33 && code <= 47) ||
    (code >= 58 && code <= 64) ||
    (code >= 91 && code <= 96) ||
    (code >= 123 && code <= 126)
  )
    return true;
  return /\p{P}/u.test(ch);
};
const isCjk = (code: number) =>
  (code >= 0x4e00 && code <= 0x9fff) ||
  (code >= 0x3400 && code <= 0x4dbf) ||
  (code >= 0x20000 && code <= 0x2a6df) ||
  (code >= 0x2a700 && code <= 0x2b73f) ||
  (code >= 0x2b740 && code <= 0x2b81f) ||
  (code >= 0x2b820 && code <= 0x2ceaf) ||
  (code >= 0xf900 && code <= 0xfaff) ||
  (code >= 0x2f800 && code <= 0x2fa1f);

/** BERT's BasicTokenizer: the words and punctuation marks, lowercased and without accents. */
export const basicTokens = (text: string): ReadonlyArray<string> => {
  let cleaned = "";
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code === 0 || code === 0xfffd || isControl(ch)) continue;
    if (isWhitespace(ch)) cleaned += " ";
    else if (isCjk(code)) cleaned += ` ${ch} `;
    else cleaned += ch;
  }
  const out: string[] = [];
  for (const word of cleaned.split(" ")) {
    if (word === "") continue;
    const plain = word
      .toLowerCase()
      .normalize("NFD")
      .replace(/\p{Mn}/gu, "");
    let current = "";
    for (const ch of plain) {
      if (isPunctuation(ch)) {
        if (current !== "") out.push(current);
        out.push(ch);
        current = "";
      } else current += ch;
    }
    if (current !== "") out.push(current);
  }
  return out;
};

export const createWordPiece = (vocabText: string): WordPiece => {
  const vocab = new Map<string, number>();
  vocabText.split(/\r?\n/).forEach((token, id) => {
    if (token !== "" && !vocab.has(token)) vocab.set(token, id);
  });
  const id = (token: string) => {
    const found = vocab.get(token);
    if (found === undefined) throw new Error(`The vocabulary has no ${token}.`);
    return found;
  };
  const cls = id("[CLS]");
  const sep = id("[SEP]");
  const unk = id("[UNK]");
  const pieces = (word: string): ReadonlyArray<number> => {
    const chars = [...word];
    if (chars.length > MAX_WORD_CHARS) return [unk];
    const out: number[] = [];
    let start = 0;
    while (start < chars.length) {
      let end = chars.length;
      let found: number | undefined;
      while (start < end) {
        const piece = (start > 0 ? "##" : "") + chars.slice(start, end).join("");
        found = vocab.get(piece);
        if (found !== undefined) break;
        end -= 1;
      }
      // One unknown piece makes the whole word unknown, as in BERT.
      if (found === undefined) return [unk];
      out.push(found);
      start = end;
    }
    return out;
  };
  return {
    encode: (text, maxTokens = 128) => {
      const ids = basicTokens(text)
        .flatMap(pieces)
        .slice(0, Math.max(0, maxTokens - 2));
      return [cls, ...ids, sep];
    },
  };
};
