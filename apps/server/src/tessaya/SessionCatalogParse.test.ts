import { describe, expect, it } from "vite-plus/test";

import { isBackgroundRun, parseHistoryHits, readTranscriptHead } from "./SessionCatalogParse.ts";

const line = (o: unknown) => JSON.stringify(o);

describe("reading a transcript's first lines", () => {
  it("takes the folder and the first thing he asked, skipping wrappers and meta lines", () => {
    const head = [
      line({
        type: "user",
        isMeta: true,
        cwd: "/work/shop",
        message: { content: "Caveat: ignore" },
      }),
      line({
        type: "user",
        cwd: "/work/shop",
        message: { content: "<system-reminder>x</system-reminder>" },
      }),
      line({
        type: "user",
        cwd: "/work/shop",
        message: { content: [{ type: "text", text: "Fix the checkout\n\nit breaks on tax" }] },
      }),
      '{"type":"assistant","message":{"con',
    ].join("\n");
    expect(readTranscriptHead(head)).toEqual({
      cwd: "/work/shop",
      entrypoint: null,
      title: "Fix the checkout it breaks on tax",
    });
  });

  it("prefers the conversation's own summary and cuts a long title", () => {
    expect(
      readTranscriptHead(
        `${line({ type: "summary", summary: "Checkout fix" })}\n${line({ type: "user", cwd: "/a", message: { content: "x" } })}`,
      ).title,
    ).toBe("Checkout fix");
    expect(
      readTranscriptHead(line({ type: "user", cwd: "/a", message: { content: "w".repeat(200) } }))
        .title,
    ).toHaveLength(90);
  });

  it("still gives something readable for an empty or unreadable head", () => {
    expect(readTranscriptHead("")).toEqual({
      cwd: null,
      entrypoint: null,
      title: "Untitled conversation",
    });
    expect(readTranscriptHead("not json\n{broken")).toEqual({
      cwd: null,
      entrypoint: null,
      title: "Untitled conversation",
    });
  });
});

describe("reading the history index", () => {
  it("makes one row per session from the header lines, ignoring tool output", () => {
    const text = [
      "2026-10-04T13:55  user  -home-ann-books  aaaaaaaa-1111-2222-3333-444444444444",
      "    the invoice for March",
      "2026-10-04T13:56  tool_result  -home-ann-books  bbbbbbbb-1111-2222-3333-444444444444",
      "    dump",
      "2026-10-05T08:00  assistant  -home-ann-books  aaaaaaaa-1111-2222-3333-444444444444",
    ].join("\n");
    expect(parseHistoryHits(text)).toEqual([
      {
        sessionId: "aaaaaaaa-1111-2222-3333-444444444444",
        project: "-home-ann-books",
        at: "2026-10-04T13:55:00.000Z",
      },
    ]);
  });
});

describe("background runs", () => {
  it("are told apart from conversations: SDK and print entrypoints, Tessaya's own folders, and the clean-up prompts", () => {
    const cli = { cwd: "/work/shop", entrypoint: "cli", title: "Fix it" };
    expect(isBackgroundRun(cli)).toBe(false);
    expect(isBackgroundRun({ ...cli, entrypoint: null })).toBe(false);
    expect(isBackgroundRun({ ...cli, entrypoint: "sdk-cli" })).toBe(true);
    expect(isBackgroundRun({ ...cli, cwd: "C:\\Users\\a\\.t3\\userdata" })).toBe(true);
    expect(
      isBackgroundRun({ ...cli, title: "Add sentence punctuation and capitals to the text" }),
    ).toBe(true);
    expect(
      readTranscriptHead(
        line({ type: "user", entrypoint: "sdk-cli", cwd: "/a", message: { content: "x" } }),
      ).entrypoint,
    ).toBe("sdk-cli");
  });
});
