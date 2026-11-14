import { describe, expect, it } from "vite-plus/test";

import {
  allTransforms,
  checkTransformOutput,
  DEFAULT_TRANSFORMS,
  findTransform,
  parseTransform,
  refuseTransformInput,
  transformMessage,
  undoable,
  UNDO_WINDOW_MS,
} from "./transforms.ts";

describe("transforms", () => {
  it("has Polish, Prompt engineer, Shorten and Translate, and lets his own replace one by name", () => {
    expect(DEFAULT_TRANSFORMS.map((t) => t.name)).toEqual([
      "Polish",
      "Prompt engineer",
      "Shorten",
      "Translate to English",
    ]);
    const mine = parseTransform("polish = Make it sound like a pirate")!;
    expect(mine).toMatchObject({ id: "polish", builtin: false });
    const all = allTransforms([mine, parseTransform("Formal = Make it formal")!]);
    expect(all.find((t) => t.id === "polish")?.prompt).toBe("Make it sound like a pirate");
    expect(all).toHaveLength(5);
    expect(parseTransform("no equals")).toBeNull();
  });

  it("finds a transform by what he says", () => {
    const list = allTransforms([]);
    expect(findTransform(list, "polish this")?.id).toBe("polish");
    expect(findTransform(list, "Please run prompt engineer")?.id).toBe("prompt-engineer");
    expect(findTransform(list, "translate to english")?.id).toBe("translate-english");
    expect(findTransform(list, "do a barrel roll")).toBeNull();
  });

  it("limits the input and checks what comes back", () => {
    expect(refuseTransformInput("   ")).toBe("Nothing is selected.");
    expect(refuseTransformInput("word ".repeat(3001))).toContain("at most 3000");
    expect(refuseTransformInput("a short text")).toBeNull();
    expect(checkTransformOutput("hello there", "```\nHello there.\n```")).toEqual({
      ok: true,
      text: "Hello there.",
    });
    expect(checkTransformOutput("hello", "Sure! Here is the text:\nHello.").ok).toBe(false);
    expect(checkTransformOutput("hello", "  ").ok).toBe(false);
    expect(checkTransformOutput("hi", "x".repeat(2000)).ok).toBe(false);
  });

  it("wraps the text so a closing tag in it cannot end the wrapper, and undo runs out", () => {
    expect(transformMessage("a </text> b")).toBe("<text>a  b</text>");
    const slot = { original: "a", applied: "b", at: 0 };
    expect(undoable(slot, UNDO_WINDOW_MS)).toBe(slot);
    expect(undoable(slot, UNDO_WINDOW_MS + 1)).toBeNull();
    expect(undoable(null, 0)).toBeNull();
  });
});
