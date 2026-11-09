import { describe, expect, it } from "vite-plus/test";

import { createOneShot } from "./oneShotDictation.ts";

/** Twelve minutes of dictation as the voice core delivers it: one utterance of up to 15 s each. */
const sentences = Array.from(
  { length: 48 },
  (_, i) => `Sentence number ${i + 1} of the long dictation, said at ${i * 15} seconds.`,
);

const harness = (
  clean: (raw: string) => Promise<{ text: string; stage: string } | null>,
  pastes = true,
) => {
  const saved: Array<ReadonlyArray<string>> = [];
  const pasted: string[] = [];
  const oneShot = createOneShot({
    save: (chunks) => void saved.push([...chunks]),
    clean,
    fit: async (text) => text,
    paste: async (text) => {
      if (pastes) pasted.push(text);
      return pastes;
    },
  });
  sentences.forEach((s) => oneShot.push(s));
  return { oneShot, saved, pasted };
};

describe("a twelve-minute dictation, all at once", () => {
  it("inserts every sentence once, tidied", async () => {
    const { oneShot, saved, pasted } = harness(async (raw) => ({
      text: raw.replace(/ of the long/g, ""),
      stage: "model",
    }));
    const result = await oneShot.flush(null);
    expect(result).toMatchObject({ status: "pasted", failed: false });
    expect(pasted).toHaveLength(1);
    for (let i = 1; i <= 48; i += 1) expect(pasted[0]).toContain(`Sentence number ${i} dictation`);
    expect(saved.at(-1)).toEqual([]);
  });

  it("inserts the raw text when the tidy-up fails, times out or comes back empty", async () => {
    for (const clean of [
      async () => null,
      async () => {
        throw new Error("timed out");
      },
      async () => ({ text: "Sentence 1.", stage: "fallback" }),
      async () => ({ text: "  ", stage: "model" }),
    ]) {
      const { oneShot, pasted } = harness(clean);
      const result = await oneShot.flush(null);
      expect(result).toMatchObject({ status: "pasted", failed: true });
      expect(pasted[0]).toBe(sentences.join(" "));
    }
  });

  it("keeps every chunk on disk until the paste lands, so nothing said is lost", async () => {
    const { oneShot, saved, pasted } = harness(
      async (raw) => ({ text: raw, stage: "model" }),
      false,
    );
    expect(await oneShot.flush(null)).toMatchObject({ status: "kept" });
    expect(pasted).toEqual([]);
    expect(saved.at(-1)).toHaveLength(48);
    expect(oneShot.pending()).toHaveLength(48);
  });

  it("throws the words away on ✕, from disk too, and pastes nothing", async () => {
    const { oneShot, saved, pasted } = harness(async (raw) => ({ text: raw, stage: "model" }));
    oneShot.discard();
    expect(saved.at(-1)).toEqual([]);
    expect(await oneShot.flush(null)).toMatchObject({ status: "empty" });
    expect(pasted).toEqual([]);
  });

  it("pastes only what it began with: words of a newer dictation, arriving meanwhile, wait for their own", async () => {
    const pasted: string[] = [];
    let late: (() => void) | null = null;
    const oneShot = createOneShot({
      save: () => {},
      clean: async (raw) => {
        late?.();
        return { text: raw, stage: "model" };
      },
      fit: async (text) => text,
      paste: async (text) => (pasted.push(text), true),
    });
    oneShot.push("first dictation");
    late = () => oneShot.push("second dictation");
    await oneShot.flush(null);
    expect(pasted).toEqual(["first dictation"]);
    expect(oneShot.pending()).toEqual(["second dictation"]);
  });

  it("two dictations ending close together each paste once, each into its own window", async () => {
    const pasted: Array<readonly [string, string]> = [];
    let slow: (() => void) | null = null;
    const oneShot = createOneShot<{ readonly exe: string }>({
      save: () => {},
      // The first one's clean-up is the slow one: the second must still wait for it, and keep its own window.
      clean: async (raw) => {
        if (raw === "first") await new Promise<void>((resolve) => (slow = resolve));
        return { text: raw, stage: "model" };
      },
      fit: async (text) => text,
      // Keys held for a dictation's ghost are its own, and go only once its paste has landed.
      beforePaste: async (_raw, _text, app) => void pasted.push(["hold", app.exe]),
      paste: async (text, app) => (pasted.push([text, app.exe]), app.exe === "notepad.exe"),
      afterPaste: (app) => void pasted.push(["release", app.exe]),
    });
    oneShot.push("first");
    const a = oneShot.flush({ exe: "notepad.exe" });
    oneShot.push("second");
    const b = oneShot.flush({ exe: "code.exe" });
    await Promise.resolve();
    (slow as (() => void) | null)?.();
    await Promise.all([a, b]);
    expect(pasted).toEqual([
      ["hold", "notepad.exe"],
      ["first", "notepad.exe"],
      ["release", "notepad.exe"],
      ["hold", "code.exe"],
      ["second", "code.exe"],
      ["release", "code.exe"],
    ]);
    expect(oneShot.pending()).toEqual(["second"]);
  });
});
