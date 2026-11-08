// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  answerConversationSearch,
  createConversationLog,
  createPersonaConversations,
} from "./conversationLog.ts";

describe("the conversation file", () => {
  it("survives a restart, in full, and finds older turns by their words", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "baton-conv-"));
    const file = NodePath.join(dir, "c.ndjson");
    const first = createConversationLog({ file });
    const long = `${"A long careful answer. ".repeat(60)}And that is the end.`;
    first.add({ route: "answer", said: "explain the Focusrite gain", reply: long });
    for (let i = 0; i < 7; i += 1)
      first.add({ route: "answer", said: `chatter ${i}`, reply: `reply ${i}` });
    first.add({ route: "dictation", said: "(dictated 40 characters)", reply: "" });

    // The latest answer is in full, however long.
    first.add({ route: "answer", said: "read me the whole plan", reply: long });
    const second = createConversationLog({ file });
    expect(second.recent(2).map((t) => t.said)).toEqual(["chatter 6", "read me the whole plan"]);
    expect(second.recent(1)[0]?.reply).toContain("And that is the end.");
    expect(second.recent(20).map((t) => t.route)).not.toContain("dictation");
    expect(second.search("the Focusrite gain")[0]?.said).toBe("explain the Focusrite gain");
    NodeFS.rmSync(dir, { recursive: true, force: true });
  });
});

describe("a conversation per persona (P2)", () => {
  it("moves the old shared file to the lead's, once, and keeps each persona's turns in its own file", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "baton-conv-"));
    const legacy = NodePath.join(dir, "baton-conversation.ndjson");
    createConversationLog({ file: legacy, now: () => new Date("2026-01-01T00:00:00Z") }).add({
      route: "answer",
      said: "old one",
      reply: "old reply",
    });
    const first = createPersonaConversations({
      dir: NodePath.join(dir, "conversation"),
      legacy,
      lead: "executive",
    });
    expect(NodeFS.existsSync(legacy)).toBe(false);
    expect(
      first
        .of("executive")
        .recent(5)
        .map((t) => t.said),
    ).toEqual(["old one"]);
    expect(first.of("freya").recent(5)).toEqual([]);
    first
      .of("freya")
      .add({ route: "answer", said: "deploy day?", reply: "Thursday.", persona: "freya" });
    first
      .of("freya")
      .add({ route: "answer", said: "what time is it", reply: "Ten.", persona: "freya" });
    // A restart reads the same files; the lead's is never migrated twice.
    const again = createPersonaConversations({
      dir: NodePath.join(dir, "conversation"),
      legacy,
      lead: "executive",
    });
    expect(
      again
        .of("freya")
        .recent(5)
        .map((t) => t.reply),
    ).toEqual(["Thursday.", "Ten."]);
    expect(
      again
        .of(undefined)
        .recent(5)
        .map((t) => t.said),
    ).toEqual(["old one"]);
    // After a restart, who he spoke to last.
    expect(again.latest()).toBe("freya");
    // Found by words in the persona named, since a time when given.
    expect(again.search("freya", "deploy")[0]?.reply).toBe("Thursday.");
    expect(again.search("freya", "deploy", { since: "2999-01-01" })).toEqual([]);
    // The shared view writes and reads the persona that is speaking now.
    again.setCurrent("freya");
    again.current.add({ route: "act", said: "(noted)", reply: "the shop" });
    expect(
      again
        .of("freya")
        .recent(5)
        .map((t) => t.reply),
    ).toEqual(["Thursday.", "Ten.", "the shop"]);
    // Persona ids only: a name or a path in the id never becomes a file outside the folder.
    expect(() => again.of("../secrets")).toThrow();
    NodeFS.rmSync(dir, { recursive: true, force: true });
  });

  it("a move that fails keeps the old file in use this run and moves it next start, .1 and all", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "baton-conv-"));
    const legacy = NodePath.join(dir, "baton-conversation.ndjson");
    const lead = NodePath.join(dir, "conversation", "executive.ndjson");
    const put = (file: string, said: string) =>
      createConversationLog({ file }).add({ route: "answer", said, reply: "ok" });
    put(`${legacy}.1`, "oldest");
    put(legacy, "older");
    const at = { dir: NodePath.join(dir, "conversation"), legacy, lead: "executive" };
    const saids = (c: ReturnType<typeof createPersonaConversations>) =>
      c
        .of("executive")
        .recent(9)
        .map((t) => t.said);
    const failing = createPersonaConversations({
      ...at,
      rename: () => {
        throw new Error("EBUSY");
      },
    });
    expect(saids(failing)).toEqual(["oldest", "older"]);
    failing.of("executive").add({ route: "answer", said: "this run", reply: "ok" });
    expect(NodeFS.existsSync(lead)).toBe(false);
    expect(failing.latest()).toBe("executive");

    // Only the .1 fails: the main file moves, and the .1 is still read where it is and moved next time.
    const split = createPersonaConversations({
      ...at,
      rename: (from, to) => {
        if (from.endsWith(".1")) throw new Error("EBUSY");
        NodeFS.renameSync(from, to);
      },
    });
    expect(NodeFS.existsSync(legacy)).toBe(false);
    expect(NodeFS.existsSync(`${legacy}.1`)).toBe(true);
    expect(saids(split)).toEqual(["oldest", "older", "this run"]);

    const next = createPersonaConversations(at);
    expect(NodeFS.existsSync(`${legacy}.1`)).toBe(false);
    expect(NodeFS.existsSync(`${lead}.1`)).toBe(true);
    expect(saids(next)).toEqual(["oldest", "older", "this run"]);

    // A restore that wrote the lead's file before the first start: that file wins over a stale old one.
    put(legacy, "stale");
    const restored = createPersonaConversations(at);
    expect(saids(restored)).toEqual(["oldest", "older", "this run"]);
    NodeFS.rmSync(dir, { recursive: true, force: true });
  });

  it("what he may ask typed back: the speaker's turns and every persona's that is not private", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "baton-conv-"));
    const c = createPersonaConversations({
      dir,
      legacy: NodePath.join(dir, "none.ndjson"),
      lead: "executive",
    });
    c.of("assistant").add({
      route: "answer",
      said: "venue?",
      reply: "From six.",
      persona: "assistant",
    });
    c.of("coach").add({ route: "answer", said: "plan?", reply: "Run at five.", persona: "coach" });
    c.setCurrent("executive");
    const replies = (isPrivate: (p: string) => boolean) =>
      c
        .heard(12, isPrivate)
        .map((t) => t.reply)
        .toSorted();
    expect(replies(() => false)).toEqual(["From six.", "Run at five."]);
    expect(replies((p) => p === "coach")).toEqual(["From six."]);
    // A private persona still hears its own.
    c.setCurrent("coach");
    expect(replies((p) => p === "coach")).toEqual(["From six.", "Run at five."]);
    NodeFS.rmSync(dir, { recursive: true, force: true });
  });

  it("conversation_search: by name, private refused, since a date with or without words", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "baton-conv-"));
    let clock = new Date("2026-11-05T09:00:00Z");
    const conversations = createPersonaConversations({
      dir,
      legacy: NodePath.join(dir, "none.ndjson"),
      lead: "executive",
      now: () => clock,
    });
    const freya = conversations.of("assistant");
    freya.add({ route: "answer", said: "venue?", reply: "Room from six.", persona: "assistant" });
    clock = new Date("2026-11-07T09:00:00Z");
    freya.add({ route: "answer", said: "dinner?", reply: "Book for eight.", persona: "assistant" });
    // A turn of Freya's migrated into the lead's file is hers, not "you".
    conversations.of("executive").add({
      route: "answer",
      said: "seating plan?",
      reply: "Freya has it.",
      persona: "assistant",
    });
    conversations
      .of("executive")
      .add({ route: "answer", said: "seating chart?", reply: "Done.", persona: "executive" });
    const personas = [
      { id: "executive", name: "Alfred" },
      { id: "assistant", name: "Freya" },
    ];
    const secret = new Set<string>();
    const ask = (
      q: { persona?: string; words?: string; since?: string },
      speaking = personas[0]!,
    ) =>
      answerConversationSearch(
        { conversations, personas, speaking, isPrivate: (p) => secret.has(p) },
        q,
      );
    expect(ask({ persona: "freya", words: "venue" })).toContain("Freya replied: Room from six.");
    expect(ask({ persona: "Nobody" })).toContain("The personas are Alfred, Freya");
    expect(ask({ persona: "freya", since: "2026-11-06" })).not.toContain("Room from six.");
    expect(ask({ persona: "freya", since: "2026-11-06" })).toContain("Book for eight.");
    expect(ask({ persona: "freya", since: "2026-11-01" })).toContain("Room from six.");
    expect(ask({ persona: "freya", since: "last tuesday" })).toContain("can't read the date");
    expect(ask({ words: "seating plan" })).toContain("Freya replied: Freya has it.");
    expect(ask({ words: "chart" })).toContain("you replied: Done.");
    secret.add("assistant");
    expect(ask({ persona: "Freya" })).toBe(
      "That's private to Freya; you can share it in Settings.",
    );
    expect(ask({ persona: "Freya" }, personas[1])).toContain("you replied: Book for eight.");
    NodeFS.rmSync(dir, { recursive: true, force: true });
  });
});
