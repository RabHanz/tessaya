import { describe, expect, it } from "vite-plus/test";

import {
  conversationBlock,
  textIsFromConversation,
  currentTarget,
  followUpSession,
  parseTurn,
  searchTurns,
  withConversation,
  type ConversationTurn,
} from "./conversation.ts";

const turn = (
  id: number,
  said: string,
  reply: string,
  route: ConversationTurn["route"] = "answer",
): ConversationTurn => ({
  id,
  at: `2026-11-01T10:0${id}:00.000Z`,
  route,
  said,
  reply,
});

describe("the shared conversation", () => {
  it("puts the last replies in full in front of a request", () => {
    const long = `Here is the plan. ${"Step. ".repeat(100)}Finally, ship it on Friday.`;
    const block = conversationBlock({ recent: [turn(1, "what is the plan", long)], earlier: [] });
    expect(block).toContain("Finally, ship it on Friday.");
    expect(withConversation("type what you just said into the chat box", block)).toMatch(
      /his request now:\ntype what/,
    );
    expect(withConversation("hello", "")).toBe("hello");
  });

  it("shows old replies without the persona intro the model would copy", () => {
    const block = conversationBlock({
      recent: [turn(1, "what time is it", "Freya here. It's ten past four.")],
      earlier: [],
    });
    expect(block).toContain("you replied (answer): It's ten past four.");
    expect(block).not.toContain("Freya here");
    // Who answered survives a new session: "what did Freya tell me" has a turn to find.
    const saved = parseTurn(
      JSON.stringify({
        ...turn(2, "and the weather", "Dry."),
        persona: "assistant",
        speaker: "saved:sam",
      }),
    );
    expect(saved).toMatchObject({ persona: "assistant", speaker: "saved:sam" });
    expect(
      parseTurn(JSON.stringify({ ...turn(3, "hi", "Hello."), speaker: "boss" }))?.speaker,
    ).toBe(undefined);
    // Another persona's turns, handed to this one: hers, not "you replied".
    expect(conversationBlock({ recent: [saved!], earlier: [], by: "Freya" })).toContain(
      "Freya replied (answer): Dry.",
    );
    // The lead's file still holds the shared file's turns: each is labelled by who answered it.
    const mixed = conversationBlock({
      recent: [saved!, turn(4, "and you?", "Fine.")],
      earlier: [],
      self: "executive",
      nameOf: (id) => (id === "assistant" ? "Freya" : undefined),
    });
    expect(mixed).toContain("Freya replied (answer): Dry.");
    expect(mixed).toContain("you replied (answer): Fine.");
  });
  it("finds an older turn by its words, and not one already in the recent window", () => {
    const turns = [
      turn(
        1,
        "how do I reset the Scarlett gain",
        "Open the Focusrite Control app and lower the gain knob.",
      ),
      turn(2, "what is the weather", "Sunny, 22 degrees."),
      turn(3, "what time is it", "Ten past ten."),
    ];
    const hits = searchTurns(turns, "the Focusrite gain again", { exclude: new Set([3]) });
    expect(hits.map((t) => t.id)).toEqual([1]);
    expect(searchTurns(turns, "the Focusrite gain", { exclude: new Set([1]) })).toEqual([]);
    expect(searchTurns(turns, "the and of", { exclude: new Set() })).toEqual([]);
  });
  it("reads a saved line without trusting it", () => {
    expect(parseTurn('{"id":1,"at":"x","route":"answer","said":"a","reply":"b"}')).toMatchObject({
      id: 1,
    });
    expect(parseTurn('{"id":"1"}')).toBeNull();
    expect(parseTurn("garbage")).toBeNull();
  });
  it("carries what the last turn was about, so 'show it' and 'tell it' follow", () => {
    const turns: ConversationTurn[] = [
      {
        ...turn(1, "what is Scheduler doing", "Claude is running the tests."),
        route: "act",
        target: { label: "Claude on Scheduler", workSessionId: "ws-1" },
      },
      turn(2, "what time is it", "Ten past ten."),
    ];
    expect(currentTarget(turns)).toEqual({ label: "Claude on Scheduler", workSessionId: "ws-1" });
    expect(followUpSession("show it", currentTarget(turns))).toBe("ws-1");
    expect(followUpSession("tell it to rerun the tests", currentTarget(turns))).toBe("ws-1");
    expect(followUpSession("show the one on Harbour", currentTarget(turns))).toBeNull();
    expect(conversationBlock({ recent: turns, earlier: [] })).toContain("Claude on Scheduler");
    expect(parseTurn(JSON.stringify(turns[0]))?.target?.workSessionId).toBe("ws-1");
  });
  it("knows text that came from the conversation, whole or in part", () => {
    const turns = [turn(1, "say hello", "Hello there.  How can I help today?")];
    expect(textIsFromConversation("hello there. how can i help today?", turns)).toBe(true);
    expect(textIsFromConversation("How can I help", turns)).toBe(true);
    expect(textIsFromConversation("transfer the money", turns)).toBe(false);
    expect(textIsFromConversation("hi", turns)).toBe(false);
    expect(textIsFromConversation("HELLO, there!", turns)).toBe(true);
  });
});
