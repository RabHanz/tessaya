import { describe, expect, it } from "vite-plus/test";

import { deleteLastUnit, parseTextCommand } from "./textCommand.ts";

describe("text commands", () => {
  it("hears navigation and selection as keys, a last word as a sequence", () => {
    expect(parseTextCommand("Select the previous paragraph.")).toMatchObject({
      kind: "keys",
      keys: ["ctrl", "shift", "up"],
    });
    expect(parseTextCommand("select the last word")).toMatchObject({
      keys: ["ctrl", "shift", "left"],
    });
    expect(parseTextCommand("please delete the last word")).toMatchObject({ kind: "sequence" });
    expect(parseTextCommand("delete that")).toMatchObject({ keys: ["delete"] });
    expect(parseTextCommand("go to the end of the document")).toMatchObject({
      keys: ["ctrl", "end"],
    });
  });

  it("hears a sentence, line or paragraph to delete, and a rewrite for the model", () => {
    expect(parseTextCommand("delete the last sentence")).toEqual({
      kind: "delete",
      unit: "sentence",
    });
    expect(parseTextCommand("remove the previous paragraph")).toEqual({
      kind: "delete",
      unit: "paragraph",
    });
    expect(parseTextCommand("make this more concise")).toEqual({
      kind: "rewrite",
      instruction: "make this more concise",
    });
    expect(parseTextCommand("Translate this to French.")).toMatchObject({ kind: "rewrite" });
    expect(parseTextCommand("fix the grammar")).toMatchObject({ kind: "rewrite" });
  });

  it("does not take an ordinary sentence for an edit", () => {
    expect(parseTextCommand("I will make this work tomorrow if the build passes")).toBeNull();
    expect(parseTextCommand("what is the weather")).toBeNull();
    expect(parseTextCommand("")).toBeNull();
  });

  it("takes out the last sentence, line or paragraph and keeps the rest", () => {
    expect(deleteLastUnit("One. Two. Three.", "sentence")).toBe("One. Two.");
    expect(deleteLastUnit("One. Two. Three. ", "sentence")).toBe("One. Two.");
    expect(deleteLastUnit("Only one.", "sentence")).toBe("");
    expect(deleteLastUnit("a\nb\nc", "line")).toBe("a\nb");
    expect(deleteLastUnit("first para\n\nsecond para", "paragraph")).toBe("first para");
    expect(deleteLastUnit("   ", "sentence")).toBeNull();
  });
});
