import { describe, expect, it } from "vite-plus/test";

import { hasDirection, speechPieces, withoutDirections } from "./interjections.ts";
import { voiceClips } from "./voiceClips.ts";
import {
  breath,
  rmsOf,
  SPLICE_GAP_MS,
  SPLICE_RATE,
  pocketSpeech,
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
    // A smile is heard (a soft amused "hmh"), a nod is not.
    expect(texts(speechPieces("*smiles*", "anna"))).toEqual(["[smile:say]"]);
  });

  it("gives a persona voice its own clip for a sound Pocket reads as silence, and others what they had", () => {
    for (const said of ["*coughs*", "*yawns*", "*sniffs*", "*gasps*", "*sighs*"])
      expect(texts(speechPieces(said, "eve"))[0]).toMatch(/:clip]$/);
    expect(texts(speechPieces("*coughs* *gasps* *sighs*", "anna"))).toEqual([
      "[cough:pause]",
      "[gasp:breath]",
      "[sigh:breath]",
    ]);
    expect(texts(speechPieces("*deep breath*", "eve"))).toEqual(["[breath:breath]"]);
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

  it("never hands a Pocket voice the tag word, and streams plain words untouched", async () => {
    const said: string[] = [];
    const say = (text: string) => {
      said.push(text);
      return wav(10, 100);
    };
    for (const line of [
      "[laughter] That's brilliant.",
      "That's brilliant. <laugh>",
      "[sigh] Fine.",
    ])
      await collect(pocketSpeech(line, "anna", say));
    expect(said.some((t) => /laugh|sigh|[[\]<>]/i.test(t))).toBe(false);
    expect(said).toEqual(["Ha ha.", "That's brilliant.", "That's brilliant.", "Ha ha.", "Fine."]);
    const plain = wav(10, 100);
    const out = pocketSpeech("Done.", "anna", (text) => {
      said.push(text);
      return plain;
    });
    expect(out).toBe(plain);
    expect(said.at(-1)).toBe("Done.");
  });

  it("plays a voice's clip at its share of her level, a different take each time, never clipped", async () => {
    const set = voiceClips("eve", "cough");
    if (set?.kind !== "sound") throw new Error("eve has her own cough");
    const [one, two] = set.variants.map((v) => Math.round((v.length * SPLICE_RATE) / set.rate));
    const pcm = await collect(
      spliceSpeech(speechPieces("Right. *coughs* *coughs*", "eve"), () => wav(1000, 3000)),
    );
    const gap = (SPLICE_GAP_MS / 1000) * SPLICE_RATE;
    // The words, a gap, her first cough, a gap each side of the next, then her second, a different take.
    expect(pcm.length).toBe(1000 + gap + one! + 2 * gap + two!);
    const first = pcm.slice(1000 + gap, 1000 + gap + one!);
    const second = pcm.slice(pcm.length - two!);
    expect(first.length === second.length && first.every((v, i) => v === second[i])).toBe(false);
    expect(rmsOf(first)).toBeCloseTo((3000 / 32768) * 0.8, 2);
    expect(Math.max(...first.map(Math.abs))).toBeLessThan(32767);
  });

  it("makes a gasp a sharp bright inhale, not the sigh's soft breath at another length", () => {
    const crossings = (pcm: Int16Array) =>
      pcm.reduce((n, v, i) => n + (i > 0 && Math.sign(v) !== Math.sign(pcm[i - 1]!) ? 1 : 0), 0);
    const soft = breath(260, 0.05);
    const inhale = breath(260, 0.05, SPLICE_RATE, 7, true);
    expect(crossings(inhale)).toBeGreaterThan(crossings(soft) * 1.5);
    // It is near full strength a fifth of the way in, where the soft breath is still rising.
    const at = (pcm: Int16Array) => rmsOf(pcm.slice(pcm.length / 5 - 240, pcm.length / 5 + 240));
    expect(at(inhale) / rmsOf(inhale)).toBeGreaterThan(at(soft) / rmsOf(soft));
  });

  it("says a laugh in the same voice at its own gain", async () => {
    const pieces = speechPieces("*laughs*", "anna");
    const pcm = await collect(spliceSpeech(pieces, () => wav(100, 10000)));
    expect(pcm.length).toBe(100);
    expect(pcm[0]).toBe(7500);
  });
});
