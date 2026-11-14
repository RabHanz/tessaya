import { describe, expect, it } from "vite-plus/test";

import { hasDirection, speechPieces, withoutDirections } from "./interjections.ts";
import {
  rmsOf,
  SPLICE_GAP_MS,
  SPLICE_RATE,
  spliceSpeech,
  streamingWavHeader,
} from "./speechSplice.ts";

const texts = (pieces: ReturnType<typeof speechPieces>) =>
  pieces.map((p) => (p.kind === "text" ? p.text : `[${p.nonverbal}:${p.sound.kind}]`));

describe("interjections before the voice", () => {
  it.each([
    ["Hmmmm, let me check.", "Hmm, let me check."],
    ["Hmm. That failed.", "Hmm. That failed."],
    ["Ugh, the build broke again.", "Uhhgh, the build broke again."],
    ["Mm hmm, done.", "Mm hm, done."],
    ["uh-huh", "Uh huh"],
    ["Uh oh.", "Uh oh."],
    ["Tsk tsk.", "Tut tut."],
    ["Hahaha, good one.", "Ha ha, good one."],
    ["Whoa, that was quick.", "Whoah, that was quick."],
    // Ordinary words that start the same stay themselves.
    ["Oh, the hmmer and ahead.", "Oh, the hmmer and ahead."],
    ["Huge umbrella, mehndi.", "Huge umbrella, mehndi."],
  ])("%s", (said, spoken) => {
    expect(texts(speechPieces(said, "anna"))).toEqual([spoken]);
  });

  it("leaves a word on his own pronounce list for pronounce to say his way", () => {
    expect(texts(speechPieces("Hmm, yes.", "anna", { his: { hmm: "Hmmmmm" } }))).toEqual([
      "Hmm, yes.",
    ]);
  });

  it("never reads a stage direction aloud, in any bracket", () => {
    for (const said of [
      "*sighs* Fine, I'll redo it.",
      "(sighs) Fine, I'll redo it.",
      "[sighs] Fine, I'll redo it.",
      "<sigh> Fine, I'll redo it.",
      "_sighs heavily_ Fine, I'll redo it.",
    ]) {
      const pieces = speechPieces(said, "anna");
      expect(texts(pieces)).toEqual(["[sigh:breath]", "Fine, I'll redo it."]);
      expect(pieces.some((p) => p.kind === "text" && /sigh|\*/i.test(p.text))).toBe(false);
      expect(withoutDirections(said)).toBe("Fine, I'll redo it.");
      expect(hasDirection(said)).toBe(true);
    }
    expect(texts(speechPieces("That's funny *laughs* really.", "anna"))).toEqual([
      "That's funny",
      "[laugh:say]",
      "really.",
    ]);
    expect(texts(speechPieces("*nods* *shrugs*", "anna"))).toEqual([
      "[gesture:pause]",
      "[gesture:pause]",
    ]);
  });

  it("keeps emphasis and asides that are not directions", () => {
    expect(texts(speechPieces("This is *really* important (see below).", "anna"))).toEqual([
      "This is *really* important (see below).",
    ]);
    expect(hasDirection("This is *really* important.")).toBe(false);
  });

  it("gives a Gemini voice its own tags and leaves interjections as written", () => {
    expect(
      texts(speechPieces("Ugh. *sighs* Fine.", "en-gb-assistant-1", { engine: "gemini" })),
    ).toEqual(["Ugh. <sigh> Fine."]);
  });
});

const wav = (samples: number, value: number) => {
  const pcm = new Int16Array(samples).fill(value);
  return (async function* () {
    yield streamingWavHeader().slice(0, 30);
    yield streamingWavHeader().slice(30);
    yield new Uint8Array(pcm.buffer);
  })();
};
const collect = async (stream: AsyncIterable<Uint8Array>) => {
  const parts: Uint8Array[] = [];
  for await (const part of stream) parts.push(part);
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.length;
  }
  return new Int16Array(all.buffer.slice(44));
};

describe("splicing sounds between words", () => {
  it("puts the sound after the words before it, with a gap each side, at a quieter level", async () => {
    const pieces = speechPieces("Right. *sighs* Done.", "anna");
    const said: string[] = [];
    const pcm = await collect(
      spliceSpeech(pieces, (text) => {
        said.push(text);
        return wav(1000, 8000);
      }),
    );
    expect(said).toEqual(["Right.", "Done."]);
    const gap = (SPLICE_GAP_MS / 1000) * SPLICE_RATE;
    const breathLength = (520 / 1000) * SPLICE_RATE;
    expect(pcm.length).toBe(1000 + gap + breathLength + gap + 1000);
    // The words, then silence, then the breath, then silence, then the words.
    expect(pcm[999]).toBe(8000);
    expect(pcm.slice(1000, 1000 + gap).every((v) => v === 0)).toBe(true);
    const sigh = pcm.slice(1000 + gap, 1000 + gap + breathLength);
    expect(rmsOf(sigh)).toBeGreaterThan(0);
    expect(rmsOf(sigh)).toBeLessThan(rmsOf(new Int16Array(10).fill(8000)) * 0.35);
    expect(pcm[1000 + gap + breathLength + gap]).toBe(8000);
  });

  it("streams a line's samples however its chunks split the header and the bytes", async () => {
    const pcm = new Int16Array([1, -2, 300, -400, 5000]);
    const bytes = new Uint8Array([...streamingWavHeader(), ...new Uint8Array(pcm.buffer)]);
    const odd = (async function* () {
      for (const [a, b] of [
        [0, 20],
        [20, 45],
        [45, 48],
        [48, 53],
        [53, bytes.length],
      ])
        yield bytes.slice(a, b);
    })();
    const out = await collect(spliceSpeech(speechPieces("Fine.", "anna"), () => odd));
    expect([...out]).toEqual([...pcm]);
  });

  it("says a laugh in the same voice at its own gain", async () => {
    const pieces = speechPieces("*laughs*", "anna");
    const pcm = await collect(spliceSpeech(pieces, () => wav(100, 10000)));
    expect(pcm.length).toBe(100);
    expect(pcm[0]).toBe(7500);
  });
});
