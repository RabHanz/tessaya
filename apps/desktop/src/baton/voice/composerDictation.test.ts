import type { ComposerDictationMessage } from "@t3tools/baton-contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { COMMIT_MS, createComposerDictation, routePill } from "./composerDictation.ts";

/** A chat box that answers as `answer` says, or never when it returns null. */
const box = (answer: (m: ComposerDictationMessage) => boolean | null) => {
  const sent: ComposerDictationMessage[] = [];
  const actions: boolean[] = [];
  const composer = createComposerDictation({
    target: () => ({
      send: (m) => {
        sent.push(m);
        const ok = answer(m);
        if (ok === null) return;
        if (m.type === "start") composer.reply({ type: "claimed", id: m.id, ok });
        if (m.type === "commit") composer.reply({ type: "took", id: m.id, ok });
      },
      gone: () => false,
    }),
    onAction: (insert) => actions.push(insert),
  });
  return { composer, sent, actions };
};

describe("dictation into our own chat box", () => {
  it("a claimed dictation streams to the composer and its words are taken, not pasted", async () => {
    const { composer, sent } = box(() => true);
    expect(await composer.start("held")).toBe(true);
    composer.words("can you");
    composer.level(0.2);
    expect(await composer.commit("Can you?")).toBe(true);
    expect(sent.map((m) => m.type)).toEqual(["start", "words", "level", "commit"]);
    expect(composer.active()).toBe(false);
  });

  it("a composer that does not take the words in time leaves them to today's paste", async () => {
    vi.useFakeTimers();
    try {
      const { composer } = box((m) => (m.type === "commit" ? null : true));
      await composer.start("free");
      const took = composer.commit("Hello");
      await vi.advanceTimersByTimeAsync(COMMIT_MS);
      expect(await took).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a window with no composer gets the pill: the claim fails and nothing more is sent", async () => {
    const { composer, sent } = box(() => false);
    expect(await composer.start("held")).toBe(false);
    composer.words("hi");
    expect(composer.active()).toBe(false);
    expect(await composer.commit("Hi")).toBe(false);
    expect(sent.map((m) => m.type)).toEqual(["start"]);
  });

  it("✕ on the chat box acts for this dictation only, and a cancel reaches the composer", async () => {
    const { composer, sent, actions } = box(() => true);
    await composer.start("free");
    composer.reply({ type: "action", id: 99, insert: true });
    composer.reply({ type: "action", id: 1, insert: false });
    composer.cancel();
    expect(actions).toEqual([false]);
    expect(sent.at(-1)).toEqual({ type: "cancel", id: 1 });
  });

  it("the pill holds its dictation states back while the composer has it, and replays the last if not", () => {
    const shown: string[] = [];
    let active = true;
    const pill = routePill(
      {
        on: (e) => shown.push(e.type),
        micLevel: (_value: number) => shown.push("level"),
        words: (t) => shown.push(`pill:${t}`),
      },
      { active: () => active, level: () => undefined, words: () => undefined },
    );
    pill.on({ type: "dictating", caption: null });
    pill.words("hi");
    pill.micLevel(0.1);
    expect(shown).toEqual([]);
    active = false;
    pill.replay();
    expect(shown).toEqual(["dictating"]);
  });
});
