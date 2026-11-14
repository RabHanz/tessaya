import { describe, expect, it } from "vite-plus/test";

import {
  expandSnippets,
  exportSnippets,
  formatSnippet,
  importSnippets,
  parseSnippet,
  putSnippet,
  SNIPPETS_MAX,
} from "./snippets.ts";

const snip = (line: string) => parseSnippet(line)!;

describe("snippets", () => {
  it("reads and prints the one-line form, with line breaks and app limits", () => {
    const s = snip("My Email  = me@example.com @Outlook.exe, slack");
    expect(s).toEqual({ cue: "my email", text: "me@example.com", apps: ["outlook", "slack"] });
    expect(formatSnippet(s)).toBe("my email = me@example.com @outlook,slack");
    expect(snip("sign off = Thanks,\\nAnn").text).toBe("Thanks,\nAnn");
    expect(parseSnippet("no equals")).toBeNull();
    expect(parseSnippet(" = x")).toBeNull();
    expect(parseSnippet("cue = ")).toBeNull();
  });

  it("gives the text exactly when the cue is the whole utterance, and replaces in place otherwise", () => {
    const list = [snip("my email = me@example.com"), snip("my email address = home@example.org")];
    expect(expandSnippets("My email address.", list, "code.exe")).toBe("home@example.org");
    expect(expandSnippets("send it to my email, please", list, "code.exe")).toBe(
      "send it to me@example.com, please",
    );
    expect(expandSnippets("nothing here", list, "code.exe")).toBe("nothing here");
    // A cue inside another word is not a cue.
    expect(expandSnippets("my emailing", list, "code.exe")).toBe("my emailing");
  });

  it("does not search an expansion again, and respects the app limit", () => {
    const list = [snip("a = b"), snip("b = a a")];
    expect(expandSnippets("say a then b", list, "x")).toBe("say b then a a");
    const slackOnly = [snip("hi = Hello team @slack")];
    expect(expandSnippets("hi", slackOnly, "slack.exe")).toBe("Hello team");
    expect(expandSnippets("hi", slackOnly, "word.exe")).toBe("hi");
  });

  it("imports JSON, CSV and lines, counting what it skipped, and exports what it reads", () => {
    const json = JSON.stringify([
      { cue: "addr", text: "1 High St" },
      { cue: "", text: "x" },
    ]);
    expect(importSnippets(json)).toMatchObject({ snippets: [{ cue: "addr" }], skipped: 1 });
    const lines = importSnippets('one = 1\n"two","2"\nbroken\n');
    expect(lines.snippets.map((s) => s.cue)).toEqual(["one", "two"]);
    expect(lines.skipped).toBe(1);
    expect(importSnippets(exportSnippets(lines.snippets)).snippets).toEqual(lines.snippets);
  });

  it("replaces by cue and refuses past the limit", () => {
    const one = putSnippet([], snip("a = 1"))!;
    expect(putSnippet(one, snip("a = 2"))!.map((s) => s.text)).toEqual(["2"]);
    const full = Array.from({ length: SNIPPETS_MAX }, (_, i) => snip(`cue${i} = x`));
    expect(putSnippet(full, snip("extra = y"))).toBeNull();
  });
});
