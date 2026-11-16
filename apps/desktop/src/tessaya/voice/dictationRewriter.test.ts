import { describe, expect, it, vi } from "vite-plus/test";

import type { DictionaryEntry } from "@t3tools/tessaya-shared/dictationCleanup";

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

  it("with his plan first, the plan answers; at its limit his key does until the plan has rested", async () => {
    let limited = false;
    let now = 1_000_000;
    using _now = vi.spyOn(Date, "now").mockImplementation(() => now);
    const asked: string[] = [];
    const results: unknown[] = [];
    const rewriter = makeRewriter({
      claudeBinary: "claude",
      model: () => "sonnet",
      workDir: "/tmp",
      env: {},
      platform: "linux",
      dictionary: () => [],
      always: true,
      route: () => "subscription",
      onSessionResult: (event) => results.push(event),
      start: (options): VisionSession => ({
        ask: async () => {
          asked.push(`plan ${options.model} ${options.effort}`);
          if (limited) throw new Error("You've hit your limit");
          options.onResult?.({ type: "result", usage: { output_tokens: 9 } });
          return "from the plan";
        },
        alive: () => true,
        dispose: () => {},
      }),
      api: async () => {
        asked.push("key");
        return "from the key";
      },
    });
    const said = { raw: "we should go home now please", mode: "default", level: "claude" } as const;
    expect((await rewriter.clean(said)).text).toBe("from the plan");
    expect(results).toHaveLength(1);
    limited = true;
    expect((await rewriter.clean(said)).text).toBe("from the key");
    // Resting: the next one goes straight to the key.
    expect((await rewriter.clean(said)).text).toBe("from the key");
    limited = false;
    now += 5 * 60_000;
    expect((await rewriter.clean(said)).text).toBe("from the plan");
    expect(asked).toEqual(["plan sonnet low", "plan sonnet low", "key", "key", "plan sonnet low"]);
    rewriter.dispose();
  });

  it("cleans the very first dictation through his key: no guess waits on a cold or limited subscription", async () => {
    vi.useFakeTimers();
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
      // A session that never answers: Claude Code still starting, or his plan at its limit (14 Nov).
      start: (): VisionSession => ({
        ask: (content) => {
          sessionAsked.push(content[0]?.type === "text" ? content[0].text : "");
          return new Promise(() => {});
        },
        alive: () => true,
        dispose: () => {},
      }),
      api: async (_system, message) => {
        apiAsked.push(message);
        return "from the api";
      },
    });
    const said = {
      raw: "we should go home. And then eat",
      mode: "default",
      level: "claude",
    } as const;
    rewriter.warm();
    rewriter.speculate({ ...said, pause: false });
    const cleaned = rewriter.clean(said);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await cleaned).toMatchObject({ stage: "model" });
    expect(sessionAsked).toHaveLength(0);
    expect(apiAsked.length).toBeGreaterThan(0);
    rewriter.dispose();
    vi.useRealTimers();
  });

  it("with a key saved, a failed key inserts the local text and never falls back to the subscription", async () => {
    let refuse = false;
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
      api: async (_system, message) => {
        apiAsked.push(message);
        if (refuse) throw new Error("rate-limit");
        return "from the api";
      },
    });
    const said = { raw: "we should go home now please", mode: "default", level: "claude" } as const;
    // His guesses while he speaks go through the key too.
    rewriter.speculate({ ...said, raw: "we should go home." });
    await vi.waitFor(() => expect(apiAsked).toHaveLength(1));
    expect((await rewriter.clean({ ...said, raw: "we should go home." })).text).toBe(
      "from the api",
    );
    expect(apiAsked).toHaveLength(1);
    refuse = true;
    expect(await rewriter.clean(said)).toMatchObject({ stage: "fallback", why: "key rate-limit" });
    // No rest: the next dictation asks the key again.
    refuse = false;
    expect((await rewriter.clean(said)).text).toBe("from the api");
    expect(apiAsked).toHaveLength(3);
    expect(sessionAsked).toHaveLength(0);
    rewriter.dispose();
  });

  it("cleans a dictation of several sentences whole with his key, and pastes the pieces if the whole fails", async () => {
    const said = {
      raw: "They are mainly from content providers sorry content makers. Sorry creators. And I need to make I need to start.",
      mode: "default",
      level: "claude",
    } as const;
    const settle = (wholeFails: boolean) =>
      makeRewriter({
        claudeBinary: "claude",
        model: "haiku",
        workDir: "/tmp",
        env: {},
        platform: "linux",
        dictionary: () => [],
        always: true,
        api: async (_system, message) => {
          const text = message.match(/<dictation>([\s\S]*)<\/dictation>/)?.[1] ?? "";
          if (!text.includes("creators") || !text.includes("start")) return text;
          if (wholeFails) throw new Error("timeout");
          return "They are mainly from creators. And I need to start.";
        },
      });
    const whole = settle(false);
    expect(await whole.clean(said)).toMatchObject({
      stage: "model",
      text: "They are mainly from creators. And I need to start.",
    });
    whole.dispose();
    const pieces = settle(true);
    expect((await pieces.clean(said)).text).toBe(
      "They are mainly from content providers sorry content makers. Sorry creators. And I need to make I need to start.",
    );
    pieces.dispose();
  });

  it("cleans his message so far with each press as one, and says so when only the new words went in", async () => {
    const said = {
      prior: "Which settings are still off?",
      raw: "Set to off. Set to off.",
      mode: "default",
      level: "claude",
    } as const;
    const asked: string[] = [];
    const settle = (messageFails: boolean) =>
      makeRewriter({
        claudeBinary: "claude",
        model: "haiku",
        workDir: "/tmp",
        env: {},
        platform: "linux",
        dictionary: () => [],
        always: true,
        api: async (_system, message) => {
          const text = message.match(/<dictation>([\s\S]*)<\/dictation>/)?.[1] ?? "";
          asked.push(text);
          if (text.startsWith("Which")) {
            if (messageFails) throw new Error("timeout");
            return "Which settings are still set to off?";
          }
          return "Set to off.";
        },
      });
    const whole = settle(false);
    expect(await whole.clean(said)).toMatchObject({
      text: "Which settings are still set to off?",
      stage: "model",
      message: true,
    });
    expect(asked).toContain("Which settings are still off? Set to off. Set to off.");
    whole.dispose();
    // A guess at his pause is the message too, and release takes it without asking again.
    asked.length = 0;
    const guessed = settle(false);
    guessed.speculate(said);
    await vi.waitFor(() => expect(asked).toHaveLength(1));
    expect(await guessed.clean(said)).toMatchObject({ message: true, speculated: true });
    expect(asked).toHaveLength(1);
    guessed.dispose();
    const alone = settle(true);
    expect(await alone.clean(said)).toMatchObject({
      text: "Set to off.",
      message: false,
      why: "message pass key timeout",
    });
    alone.dispose();
  });

  it("with his key, warms at the start and takes the whole guessed at his last pause", async () => {
    const asked: Array<{ readonly text: string; readonly maxTokens: number }> = [];
    let answer: (() => void) | null = null;
    const rewriter = makeRewriter({
      claudeBinary: "claude",
      model: "haiku",
      workDir: "/tmp",
      env: {},
      platform: "linux",
      dictionary: () => [],
      always: true,
      api: (_system, message, maxTokens) => {
        const text = message.match(/<dictation>([\s\S]*)<\/dictation>/)?.[1] ?? "";
        asked.push({ text, maxTokens });
        if (maxTokens === 0) return Promise.resolve("");
        return new Promise((resolve) => {
          answer = () => resolve(text.toUpperCase());
        });
      },
    });
    const said = { mode: "default", level: "claude" } as const;
    rewriter.warm();
    rewriter.warm();
    expect(asked).toEqual([{ text: "", maxTokens: 0 }]);
    // Still talking: nothing is guessed; at the pause the whole so far is, in one call.
    rewriter.speculate({ ...said, raw: "We should go now. Then we", pause: false });
    rewriter.speculate({ ...said, raw: "We should go now. Then we eat." });
    await vi.waitFor(() =>
      expect(asked.map((a) => a.text)).toEqual(["", "We should go now. Then we eat."]),
    );
    // Released while that guess is on its way: it is waited for, not asked again.
    const cleaned = rewriter.clean({ ...said, raw: "We should go now. Then we eat." });
    await vi.waitFor(() => expect(answer).not.toBeNull());
    answer!();
    expect(await cleaned).toMatchObject({
      text: "WE SHOULD GO NOW. THEN WE EAT.",
      stage: "model",
      speculated: true,
    });
    expect(asked).toHaveLength(2);
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

  it("waits for his key's usual 1.3 s answer at release, and says why when it gives up", async () => {
    vi.useFakeTimers();
    let answer: ((text: string) => void) | null = null;
    let refuse = false;
    const rewriter = makeRewriter({
      claudeBinary: "claude",
      model: "haiku",
      workDir: "/tmp",
      env: {},
      platform: "linux",
      dictionary: () => [],
      always: true,
      start: (): VisionSession => ({
        ask: () => new Promise(() => {}),
        alive: () => true,
        dispose: () => {},
      }),
      api: (): Promise<string> =>
        refuse
          ? Promise.reject(new Error("timeout"))
          : new Promise((resolve) => {
              answer = resolve;
            }),
    });
    const said = { raw: "we should go home now please", mode: "default", level: "claude" } as const;
    // His key answers 1.3 s after release, as it did on 0.1.107.
    const clean = async () => {
      const cleaned = rewriter.clean(said);
      await vi.advanceTimersByTimeAsync(1_300);
      answer?.("from the api");
      await vi.advanceTimersByTimeAsync(5_000);
      return cleaned;
    };
    expect((await clean()).text).toBe("from the api");
    // 0.1.107 cut this one at 0.9 s and pasted the local text (2026-11-12).
    expect(await clean()).toMatchObject({ stage: "model", text: "from the api" });
    refuse = true;
    expect(await clean()).toMatchObject({ stage: "fallback", why: "key timeout" });
    rewriter.dispose();
    vi.useRealTimers();
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
          // Each answer passes, so a clean is one turn.
          ask: async (content) =>
            content[0]?.type === "text"
              ? (/<dictation>(.*)<\/dictation>/.exec(content[0].text)?.[1] ?? "")
              : "",
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
    // A sentence that takes back the last one's words is cleaned with it (15 Nov: "…content makers. Sorry creators.").
    expect(
      dictationPieces(
        "Venture OS has a register of videos. They are mainly from content providers sorry content makers. Sorry creators. So that is it.",
        "default",
      ),
    ).toEqual([
      "Venture OS has a register of videos.",
      "They are mainly from content providers sorry content makers. Sorry creators.",
      "So that is it.",
    ]);
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
