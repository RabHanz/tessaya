import { describe, expect, it } from "vite-plus/test";

import {
  applyStyle,
  categoryForApp,
  cleanupChoiceOf,
  cleanupSettingOf,
  STYLE_EXAMPLES,
} from "./writingStyle.ts";

describe("writing style", () => {
  it("sorts a window into his four kinds of writing, a browser by its title", () => {
    expect(categoryForApp({ exe: "WhatsApp.exe", title: "" })).toBe("personal");
    expect(categoryForApp({ exe: "slack.exe", title: "" })).toBe("work");
    expect(categoryForApp({ exe: "OUTLOOK.EXE", title: "" })).toBe("email");
    expect(categoryForApp({ exe: "chrome.exe", title: "Inbox - Gmail" })).toBe("email");
    expect(categoryForApp({ exe: "chrome.exe", title: "Discord | #general" })).toBe("personal");
    expect(categoryForApp({ exe: "code.exe", title: "x.ts" })).toBe("other");
  });

  it("changes only capitals and the closing mark, and only for a short message", () => {
    const said = "Hey, are you free for lunch tomorrow?";
    expect(applyStyle("Hey, I'm free at 5 PM.", "casual")).toBe("Hey, I'm free at 5 PM");
    expect(applyStyle("Hey, I'm free at 5 PM.", "very-casual")).toBe("hey, I'm free at 5 PM");
    expect(applyStyle("See you at 5.", "excited")).toBe("See you at 5!");
    expect(applyStyle(said, "excited")).toBe(said);
    expect(applyStyle("Done.", "formal")).toBe("Done.");
    expect(applyStyle("Done.", "default")).toBe("Done.");
    const long = "First line.\nSecond line.";
    expect(applyStyle(long, "very-casual")).toBe(long);
    expect(STYLE_EXAMPLES.casual.endsWith("tomorrow")).toBe(true);
  });

  it("names the three cleanup levels over the existing setting", () => {
    expect(cleanupChoiceOf("off")).toBe("none");
    expect(cleanupChoiceOf("local")).toBe("light");
    expect(cleanupChoiceOf("claude")).toBe("medium");
    expect(cleanupSettingOf("medium")).toBe("claude");
    expect(cleanupSettingOf("none")).toBe("off");
  });
});
