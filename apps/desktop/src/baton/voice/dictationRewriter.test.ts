import { describe, expect, it, vi } from "vite-plus/test";

import type { DictionaryEntry } from "@t3tools/baton-shared/dictationCleanup";

import type { VisionSession } from "../screen/claudeVision.ts";
import { dictationPieces, makeRewriter } from "./dictationRewriter.ts";

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

  it("cleans through his API key when one is saved, and through the subscription session when not", async () => {
    let saved = true;
    const sessionAsked: string[] = [];
    const apiAsked: string[] = [];
    const rewriter = makeRewriter({
      claudeBinary: "claude",
      model: "haiku",
      workDir: "/tmp",
      env: {},
      platform: "linux",
      dictionary: () => [],
      always: true,
      start: (): VisionSession => ({
        ask: async (content) => {
          sessionAsked.push(content[0]?.type === "text" ? content[0].text : "");
          return "from the session";
        },
        alive: () => true,
        dispose: () => {},
      }),
      api: async (system, message, maxTokens) => {
        apiAsked.push(message);
        expect(system.length).toBeGreaterThan(0);
        expect(maxTokens).toBeGreaterThan(64);
        return saved ? "from the api" : null;
      },
    });
    const said = { raw: "we should go home now please", mode: "default", level: "claude" } as const;
    expect((await rewriter.clean(said)).text).toBe("from the api");
    expect(sessionAsked).toHaveLength(0);
    saved = false;
    expect((await rewriter.clean(said)).text).toBe("from the session");
    expect(apiAsked).toHaveLength(2);
    rewriter.dispose();
  });

  it("sends only the final clean to the paid API, and rests it a minute after a refused key", async () => {
    let now = 1_000_000;
    using _now = vi.spyOn(Date, "now").mockImplementation(() => now);
    let refuse = false;
    let failWith: string | null = null;
    const apiAsked: string[] = [];
    const rewriter = makeRewriter({
      claudeBinary: "claude",
      model: "haiku",
      workDir: "/tmp",
      env: {},
      platform: "linux",
      dictionary: () => [],
      always: true,
      start: (): VisionSession => ({
        ask: async () => "from the session",
        alive: () => true,
        dispose: () => {},
      }),
      api: async (_system, message) => {
        apiAsked.push(message);
        if (refuse) throw new Error("invalid-key");
        if (failWith !== null) throw new Error(failWith);
        return "from the api";
      },
    });
    const said = { raw: "we should go home now please", mode: "default", level: "claude" } as const;
    // Until his key has answered, a guess while he speaks goes to the subscription session.
    rewriter.speculate({ ...said, raw: "we should go home" });
    await vi.waitFor(() => expect(apiAsked).toHaveLength(0));
    expect((await rewriter.clean(said)).text).toBe("from the api");
    expect(apiAsked).toHaveLength(1);
    // Once it has, his finished sentences are cleaned through it while he speaks, so release has only the rest.
    rewriter.speculate({ ...said, raw: "we should go home. And then eat", pause: false });
    await vi.waitFor(() => expect(apiAsked).toHaveLength(2));
    expect((await rewriter.clean({ ...said, raw: "we should go home." })).text).toBe(
      "from the api",
    );
    expect(apiAsked).toHaveLength(2);
    apiAsked.length = 1;
    // A refused key: this dictation and the next minute's go through the session, with no paid try.
    refuse = true;
    expect((await rewriter.clean(said)).text).toBe("from the session");
    expect((await rewriter.clean(said)).text).toBe("from the session");
    expect(apiAsked).toHaveLength(2);
    now += 61_000;
    refuse = false;
    expect((await rewriter.clean(said)).text).toBe("from the api");
    // A timeout rests it for 15 s only.
    failWith = "timeout";
    expect((await rewriter.clean(said)).text).toBe("from the session");
    now += 16_000;
    failWith = null;
    expect((await rewriter.clean(said)).text).toBe("from the api");
    rewriter.dispose();
  });

  it("never holds release past its budget once his key answers: the local text goes in", async () => {
    const rewriter = makeRewriter({
      claudeBinary: "claude",
      model: "haiku",
      workDir: "/tmp",
      env: {},
      platform: "linux",
      dictionary: () => [],
      always: true,
      releaseBudgetMs: 0,
      start: (): VisionSession => ({
        ask: async () => "from the session",
        alive: () => true,
        dispose: () => {},
      }),
      api: async () => "from the api",
    });
    const said = {
      raw: "um we should go home now please",
      mode: "default",
      level: "claude",
    } as const;
    // The first answer is waited for in full: until his key has answered, nothing says it is fast.
    expect((await rewriter.clean(said)).text).toBe("from the api");
    const late = await rewriter.clean(said);
    expect(late).toMatchObject({ stage: "fallback", text: "We should go home now please" });
    rewriter.dispose();
  });

  it("keeps a session up while it should stay warm: a used-up or dead one is replaced at once", async () => {
    let started = 0;
    let alive = true;
    let warmNow = true;
    const rewriter = makeRewriter({
      claudeBinary: "claude",
      model: "haiku",
      workDir: "/tmp",
      env: {},
      platform: "linux",
      dictionary: () => [],
      always: true,
      keepWarm: () => warmNow,
      start: (): VisionSession => {
        started += 1;
        return {
          ask: async (content) => (content[0]?.type === "text" ? content[0].text : ""),
          alive: () => alive,
          dispose: () => {},
        };
      },
    });
    rewriter.warm();
    for (let i = 0; i < 20; i += 1)
      await rewriter.clean({
        raw: `note number ${i} for the team`,
        mode: "default",
        level: "claude",
      });
    // The twentieth answer used the session up; the next is already starting, before he speaks again.
    expect(started).toBe(2);
    alive = false;
    rewriter.warm();
    expect(started).toBe(3);
    warmNow = false;
    alive = true;
    for (let i = 0; i < 20; i += 1)
      await rewriter.clean({
        raw: `note number ${i} for the team`,
        mode: "default",
        level: "claude",
      });
    expect(started).toBe(3);
    rewriter.dispose();
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

  it("cleans each finished sentence while he speaks, so release cleans only the last", async () => {
    const s = held();
    // Mid-speech: the finished sentence is guessed, the growing one is not.
    s.rewriter.speculate({ ...said, raw: "we should go now. then we", pause: false });
    await s.answerNext();
    expect(s.asked).toHaveLength(1);
    const cleaned = s.rewriter.clean({ ...said, raw: "we should go now. then we eat at home." });
    await s.answerNext();
    expect(await cleaned).toMatchObject({
      text: "WE SHOULD GO NOW. THEN WE EAT AT HOME.",
      stage: "model",
      speculated: false,
    });
    // Two turns in all: the first sentence while he spoke, the last one after release.
    expect(s.asked).toHaveLength(2);
    expect(s.asked[1]).toContain("Then we eat at home.");
    expect(s.asked[1]).not.toContain("should go now");
    s.rewriter.dispose();
  });

  it("splits after a full stop, never after a question or inside an email", () => {
    expect(
      dictationPieces("Go now. Then eat! Can you check? And also send it.", "default"),
    ).toEqual(["Go now.", "Then eat!", "Can you check? And also send it."]);
    expect(dictationPieces("Hi Sam. Thanks.", "email")).toEqual(["Hi Sam. Thanks."]);
    // A list spans its sentences, so it is cleaned whole: pieces cleaned apart could never become one.
    for (const listed of [
      "I want you to pick up a few things from the store. Bread, potato chips, ice cream.",
      "There are two problems. The login is stuck. The currency is wrong.",
      "Firstly we will try. Secondly we will learn.",
    ])
      expect(dictationPieces(listed, "default")).toEqual([listed]);
    expect(dictationPieces("Two of them came. Then they left.", "default")).toHaveLength(2);
    expect(dictationPieces("  ", "default")).toEqual([]);
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
