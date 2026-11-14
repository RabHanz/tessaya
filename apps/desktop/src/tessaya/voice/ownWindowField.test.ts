import { describe, expect, it } from "vite-plus/test";

import { takesText } from "./ownWindowField.ts";

describe("a text field in Tessaya's own window", () => {
  it("is a box he can type in, and nothing else on the page", () => {
    expect(takesText({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(takesText({ tagName: "TEXTAREA" })).toBe(true);
    expect(takesText({ tagName: "INPUT", type: "text" })).toBe(true);
    expect(takesText({ tagName: "INPUT", type: "" })).toBe(true);
    // The Browser panel's page is not ours to read: a paste there goes ahead.
    expect(takesText({ tagName: "WEBVIEW" })).toBe(true);
    // No field: the page itself, a button, a checkbox, a read-only or disabled box.
    expect(takesText(null)).toBe(false);
    expect(takesText({ tagName: "BODY", isContentEditable: false })).toBe(false);
    expect(takesText({ tagName: "BUTTON" })).toBe(false);
    expect(takesText({ tagName: "INPUT", type: "checkbox" })).toBe(false);
    expect(takesText({ tagName: "TEXTAREA", readOnly: true })).toBe(false);
    expect(takesText({ tagName: "INPUT", type: "text", disabled: true })).toBe(false);
  });

  it("runs inside the page on its own", () => {
    // ownFieldFocused sends its source to the page: it must need nothing from this module.
    const run = new Function(`return (${takesText.toString()})({ tagName: "TEXTAREA" })`);
    expect(run()).toBe(true);
  });
});
