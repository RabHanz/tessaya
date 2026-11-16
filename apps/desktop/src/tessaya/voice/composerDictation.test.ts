import type { ComposerDictationMessage } from "@t3tools/tessaya-contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { waveEngine } from "@t3tools/tessaya-shared/waveform";

import { CLAIM_MS, COMMIT_MS, createComposerDictation, routePill } from "./composerDictation.ts";

/** A chat box that answers as `answer` says, or never when it returns null. */
const box = (
  answer: (m: ComposerDictationMessage) => boolean | null,
  focused = true,
  said: { readonly prior?: string; readonly replyingTo?: string } = {},
) => {
  const sent: ComposerDictationMessage[] = [];
  const actions: boolean[] = [];
  const sends: Array<readonly [string, string]> = [];
  const composer = createComposerDictation({
    target: () => ({
      focused: () => focused,
      send: (m) => {
        sent.push(m);
        const ok = answer(m);
        if (ok === null) return;
        if (m.type === "start") composer.reply({ type: "claimed", id: m.id, ok, ...said });
        if (m.type === "commit") composer.reply({ type: "took", id: m.id, ok });
      },
      gone: () => false,
    }),
    onAction: (insert) => actions.push(insert),
    onSent: (written, kept) => sends.push([written, kept]),
  });
  return { composer, sent, actions, sends };
};

describe("dictation into our own chat box", () => {
  it("a claimed dictation streams to the composer and its words are taken, not pasted", async () => {
    const { composer, sent, sends } = box(() => true, true, { prior: "Hi.", replyingTo: "Done?" });
    expect(await composer.start("held")).toBe(true);
    // What the box said as it claimed is the clean-up's: his message so far and the reply he answers.
    expect(composer.said()).toEqual({ prior: "Hi.", replyingTo: "Done?" });
    composer.words("can you");
    composer.level(0.2);
    expect(await composer.commit("Hi. Can you?", { prior: "Hi.", alone: "Can you?" })).toBe(true);
    expect(sent.map((m) => m.type)).toEqual(["start", "words", "level", "commit"]);
    expect(sent.at(-1)).toMatchObject({ text: "Hi. Can you?", replace: "Hi.", alone: "Can you?" });
    expect(composer.active()).toBe(false);
    composer.reply({ type: "sent", id: 0, written: "Hi. Can you?", kept: "Hi. Can we?" });
    expect(sends).toEqual([["Hi. Can you?", "Hi. Can we?"]]);
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

  it("a chat box he left for another field lets the dictation go: the pill shows it and the words paste there", async () => {
    const released: number[] = [];
    const sent: ComposerDictationMessage[] = [];
    const composer = createComposerDictation({
      target: () => ({
        focused: () => true,
        send: (m) => {
          sent.push(m);
          if (m.type === "start") composer.reply({ type: "claimed", id: m.id, ok: true });
        },
        gone: () => false,
      }),
      onAction: () => undefined,
      onRelease: () => released.push(1),
    });
    expect(await composer.start("free")).toBe(true);
    const id = sent[0]!.id;
    composer.reply({ type: "released", id: id + 1 });
    expect(composer.active()).toBe(true);
    composer.reply({ type: "released", id });
    expect(released).toEqual([1]);
    expect(composer.active()).toBe(false);
    composer.words("more words");
    expect(await composer.commit("More words.")).toBe(false);
    expect(sent.map((m) => m.type)).toEqual(["start"]);
  });

  it("a claim that comes too late is let go, so the chat box's pill never stays up while the words paste", async () => {
    vi.useFakeTimers();
    try {
      const { composer, sent } = box(() => null);
      const claim = composer.start("free");
      await vi.advanceTimersByTimeAsync(CLAIM_MS);
      expect(await claim).toBe(false);
      expect(sent).toEqual([
        { type: "start", id: 1, mode: "free" },
        { type: "cancel", id: 1 },
      ]);
      expect(await composer.commit("Hello")).toBe(false);
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

  it("anywhere else the pill shows at once: no claim is asked of a window whose chat box is not focused", async () => {
    const { composer, sent } = box(() => true, false);
    expect(await composer.start("held")).toBe(false);
    expect(composer.active()).toBe(false);
    expect(sent).toEqual([]);
  });

  it("the press and the recording that follows are one dictation, its mode told, never restarted", async () => {
    const { composer, sent } = box(() => true);
    void composer.start("held");
    expect(await composer.start("free")).toBe(true);
    expect(sent.map((m) => m.type)).toEqual(["start", "mode"]);
  });

  it("the composer's waveform gets the frame's RMS in dBFS, as the pill's does", () => {
    const levels: number[] = [];
    const pill = routePill(
      {
        on: () => undefined,
        micLevel: (_value: number, _shown?: number, _frame?: Int16Array) => undefined,
        words: () => undefined,
      },
      { active: () => true, level: (db) => levels.push(db), words: () => undefined },
    );
    const frame = new Int16Array(640).fill(3277);
    pill.micLevel(0.5, 0.5, frame);
    expect(levels).toEqual([waveEngine().frameDb(frame)]);
  });
});
