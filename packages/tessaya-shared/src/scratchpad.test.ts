import { describe, expect, it } from "vite-plus/test";

import { addNote, NOTES_MAX, previewOf, removeNote, searchNotes } from "./scratchpad.ts";

describe("scratchpad", () => {
  it("adds newest first, refuses empty and huge, and drops the oldest past the limit", () => {
    let list = addNote([], " buy milk ", 1, "a");
    list = addNote(list, "call Sam about the invoice", 2, "b");
    expect(list.map((n) => n.id)).toEqual(["b", "a"]);
    expect(list[1]?.text).toBe("buy milk");
    expect(() => addNote(list, "  ", 3, "c")).toThrow("nothing to note");
    expect(() => addNote(list, "x".repeat(20_001), 3, "c")).toThrow("too long");
    const full = Array.from({ length: NOTES_MAX }, (_, i) => ({ id: `n${i}`, at: i, text: "t" }));
    const more = addNote(full, "new", 9, "z");
    expect(more).toHaveLength(NOTES_MAX);
    expect(more[0]?.id).toBe("z");
  });
  it("finds a note when every word is in it, in any case", () => {
    const list = addNote(addNote([], "Buy MILK and eggs", 1, "a"), "call Sam", 2, "b");
    expect(searchNotes(list, "milk eggs").map((n) => n.id)).toEqual(["a"]);
    expect(searchNotes(list, "milk sam")).toEqual([]);
    expect(searchNotes(list, "  ")).toHaveLength(2);
    expect(removeNote(list, "a").map((n) => n.id)).toEqual(["b"]);
  });
  it("previews on one line", () => {
    expect(previewOf("one\ntwo   three")).toBe("one two three");
    expect(previewOf("word ".repeat(100)).endsWith("...")).toBe(true);
  });
});
