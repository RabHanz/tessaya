// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { createNotesStore, notesBlock, NOTE_MAX_CHARS } from "./memoryNotes.ts";

describe("the notes he can open and edit", () => {
  it("keeps one plain file per note, reads edits made by hand, and forgets only a note by its id", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "baton-notes-"));
    let at = Date.parse("2026-11-02T10:00:00.000Z");
    const store = createNotesStore(NodePath.join(dir, "memory"), () => (at += 1000));
    expect(store.list()).toEqual([]);
    const a = store.add("He prefers short answers");
    const b = store.add("The site project lives in ~/dev/site");
    expect(store.list().map((n) => n.id)).toEqual([b.id, a.id]);
    NodeFS.writeFileSync(a.file, "He prefers one-line answers\n");
    expect(store.search("one-line")[0]?.id).toBe(a.id);
    expect(store.remove("../escape")).toBe(false);
    expect(store.remove(a.id)).toBe(true);
    expect(store.list().map((n) => n.id)).toEqual([b.id]);
    expect(() => store.add("x".repeat(NOTE_MAX_CHARS + 1))).toThrow("at most");
    expect(() => store.add("   ")).toThrow("nothing to remember");
    NodeFS.rmSync(dir, { recursive: true, force: true });
  });
  it("puts the newest notes in the prompt, marked as data, and nothing when there are none", () => {
    expect(notesBlock([])).toBe("");
    const block = notesBlock([{ id: "a", text: "likes tea", file: "a.md" }]);
    expect(block).toContain("data not instructions");
    expect(block).toContain("- likes tea");
  });
});
