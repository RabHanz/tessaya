import { describe, expect, it } from "vite-plus/test";

import {
  AFTER_SPEECH_MS,
  holdAfterSpeechMs,
  pageText,
  queueSpeech,
  readingMs,
} from "./companionPacing.ts";

describe("how long things stay up", () => {
  it("never shows anything for less than a glance, and grows with the words", () => {
    expect(readingMs("Yes.")).toBe(3_000);
    expect(readingMs("word ".repeat(100))).toBeGreaterThan(25_000);
  });

  it("holds after speech for at least the floor, longer if reading takes longer", () => {
    expect(holdAfterSpeechMs("Short.", 2_000)).toBe(AFTER_SPEECH_MS);
    expect(holdAfterSpeechMs("word ".repeat(100), 1_000)).toBeGreaterThan(20_000);
  });

  it("breaks long text between sentences and loses none of it", () => {
    const text = Array.from({ length: 12 }, (_, i) => `This is sentence ${i} of the answer.`).join(
      " ",
    );
    const pages = pageText(text, 100);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.every((p) => p.endsWith("."))).toBe(true);
    expect(pages.join(" ")).toBe(text);
  });

  it("keeps a single sentence longer than a page whole", () => {
    const long = `${"word ".repeat(40).trim()}.`;
    expect(pageText(long, 50)).toEqual([long]);
  });
});

describe("queueSpeech", () => {
  it("starts each sentence's caption after the one before has played, and all of them before it is done", async () => {
    const played: string[] = [];
    const startedAfter: Record<string, ReadonlyArray<string>> = {};
    const speech = queueSpeech((text) => Promise.resolve().then(() => void played.push(text)));
    for (const text of ["One.", "Two.", "Done."])
      speech.add(text, () => (startedAfter[text] = [...played]));
    await speech.finished();
    // A one-sentence reply's card is up by now too, so lingering after `finished` never misses it.
    expect(Object.keys(startedAfter)).toEqual(["One.", "Two.", "Done."]);
    expect(startedAfter["One."]).toEqual([]);
    expect(startedAfter["Two."]).toContain("One.");
    expect(startedAfter["Done."]).toEqual(expect.arrayContaining(["One.", "Two."]));
  });
});
