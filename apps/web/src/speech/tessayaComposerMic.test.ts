import { describe, expect, it } from "vite-plus/test";

import { insertAtSelection } from "./tessayaComposerMic";

describe("Tessaya's words in the composer", () => {
  it("replace the selection and leave the caret after them", () => {
    expect(
      insertAtSelection({ text: "Fix the bug", selection: { start: 4, end: 7 } }, "login"),
    ).toEqual({
      text: "Fix login bug",
      selection: { start: 9, end: 9 },
    });
    expect(insertAtSelection({ text: "Hi ", selection: { start: 9, end: 2 } }, "there")).toEqual({
      text: "Hi there",
      selection: { start: 8, end: 8 },
    });
  });
});
