import { describe, expect, it } from "vite-plus/test";

import type { DictionaryEntry } from "@t3tools/baton-shared/dictationCleanup";

import type { VisionSession } from "../screen/claudeVision.ts";
import { makeRewriter } from "./dictationRewriter.ts";

describe("makeRewriter", () => {
  it("starts a session with the new dictionary as soon as he teaches a word", () => {
    const prompts: string[] = [];
    let dictionary: ReadonlyArray<DictionaryEntry> = [];
    const rewriter = makeRewriter({
      claudeBinary: "claude",
      model: "haiku",
      workDir: "/tmp",
      env: {},
      platform: "linux",
      dictionary: () => dictionary,
      start: (options): VisionSession => {
        prompts.push(options.systemPrompt);
        return { ask: async () => "", alive: () => true, dispose: () => {} };
      },
    });
    rewriter.warm();
    rewriter.warm();
    dictionary = [{ phrase: "Tessaya", replacement: null }];
    rewriter.warm();
    rewriter.dispose();
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("Tessaya");
  });

  /** A session whose answers are released by hand, and which counts what it was asked and how many at once. */
  const held = () => {
    const asked: string[] = [];
    const answers: Array<() => void> = [];
    const waiters: Array<(release: () => void) => void> = [];
    let open = 0;
    let most = 0;
    const rewriter = makeRewriter({
      claudeBinary: "claude",
      model: "haiku",
      workDir: "/tmp",
      env: {},
      platform: "linux",
      dictionary: () => [],
      always: true,
      limitMs: 60_000,
      start: (): VisionSession => ({
        ask: (content) =>
          new Promise<string>((resolve, reject) => {
            const text = content[0]?.type === "text" ? content[0].text : "";
            asked.push(text);
            open += 1;
            most = Math.max(most, open);
            const words = /<dictation>(.*)<\/dictation>/s.exec(text)?.[1] ?? "";
            const release = () => {
              open -= 1;
              if (/fail/i.test(words)) reject(new Error("no answer"));
              else resolve(words.toUpperCase());
            };
            const waiter = waiters.shift();
            if (waiter === undefined) answers.push(release);
            else waiter(release);
          }),
        alive: () => true,
        dispose: () => {},
      }),
    });
    /** Answers the next question, waiting for it to be asked. */
    const answerNext = async () => {
      const release = answers.shift() ?? (await new Promise<() => void>((r) => waiters.push(r)));
      release();
    };
    return { rewriter, asked, answerNext, most: () => most };
  };
  const said = { mode: "default", level: "claude" } as const;

  it("takes the answer cleaned at the pause", async () => {
    const s = held();
    s.rewriter.speculate({ ...said, raw: "we should go " });
    await s.answerNext();
    const cleaned = await s.rewriter.clean({ ...said, raw: "we should go" });
    expect(cleaned).toMatchObject({ text: "WE SHOULD GO", stage: "model", speculated: true });
    expect(s.asked).toHaveLength(1);
    s.rewriter.dispose();
  });

  it("asks one guess at a time, skips the stale ones, and puts the real clean straight after", async () => {
    const s = held();
    s.rewriter.speculate({ ...said, raw: "we" });
    const first = s.answerNext();
    s.rewriter.speculate({ ...said, raw: "we should" });
    s.rewriter.speculate({ ...said, raw: "we should go" });
    await first;
    const cleaned = s.rewriter.clean({ ...said, raw: "we should go home" });
    await s.answerNext();
    expect(await cleaned).toMatchObject({ text: "WE SHOULD GO HOME", speculated: false });
    expect(s.asked).toHaveLength(2);
    expect(s.most()).toBe(1);
    s.rewriter.dispose();
  });

  it("asks again when the guess fell back, and never guesses below the Claude level", async () => {
    const s = held();
    s.rewriter.speculate({ ...said, raw: "fail here" });
    await s.answerNext();
    const cleaned = s.rewriter.clean({ ...said, raw: "fail here" });
    await s.answerNext();
    expect((await cleaned).speculated).toBe(false);
    expect(s.asked).toHaveLength(2);
    s.rewriter.speculate({ mode: "default", level: "local", raw: "we should go" });
    expect(s.asked).toHaveLength(2);
    s.rewriter.dispose();
  });
});
