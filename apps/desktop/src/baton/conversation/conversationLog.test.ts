// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { createConversationLog, createPersonaConversations } from "./conversationLog.ts";

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
});
