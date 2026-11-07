// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import { basicTokens, createWordPiece } from "./wordpiece.ts";

const vocab = NodeFS.readFileSync(
  new URL("../../resources/memory-model/vocab.txt", import.meta.url),
  "utf8",
);

describe("BERT's uncased WordPiece, as bge-small-en-v1.5 reads text", () => {
  // Reference ids from Hugging Face `tokenizers` with the model's own tokenizer.json (padding removed).
  it.each<[string, ReadonlyArray<number>]>([
    ["Hello, world!", [101, 7592, 1010, 2088, 999, 102]],
    [
      "The shop's README needs tidying before Friday.",
      [101, 1996, 4497, 1005, 1055, 3191, 4168, 3791, 29369, 2075, 2077, 5958, 1012, 102],
    ],
    [
      "Réserve le train pour vendredi à 9h30.",
      [101, 3914, 3393, 3345, 10364, 2310, 4859, 5596, 2072, 1037, 1023, 2232, 14142, 1012, 102],
    ],
    [
      "unaffable tokenization of  EMAIL-addresses like rab@example.com",
      [
        101, 14477, 20961, 3468, 19204, 3989, 1997, 10373, 1011, 11596, 2066, 10958, 2497, 1030,
        2742, 1012, 4012, 102,
      ],
    ],
    ["我喜欢 coffee", [101, 1855, 100, 100, 4157, 102]],
    [
      "what did we decide about pricing???",
      [101, 2054, 2106, 2057, 5630, 2055, 20874, 1029, 1029, 1029, 102],
    ],
  ])("%s", (text, ids) => {
    expect(createWordPiece(vocab).encode(text)).toEqual(ids);
  });

  it("keeps [CLS] and [SEP] when it cuts a long text to the limit", () => {
    const ids = createWordPiece(vocab).encode("word ".repeat(500), 16);
    expect(ids).toHaveLength(16);
    expect([ids[0], ids.at(-1)]).toEqual([101, 102]);
  });

  it("drops control characters and splits punctuation off words", () => {
    expect(basicTokens("He\u0000llo\tthere,FRIEND")).toEqual(["hello", "there", ",", "friend"]);
  });
});
