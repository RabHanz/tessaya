import { describe, expect, it } from "vite-plus/test";

import { NOT_HERE, askHistory, parseLearnings } from "./historyIndex.ts";

describe("askHistory", () => {
  it("says plainly when there is no index here", async () => {
    expect(await askHistory({}, { query: "pricing" })).toEqual({ ok: false, why: NOT_HERE });
  });
  it("passes words and a session as separate arguments, never through a shell, and refuses odd ones", async () => {
    const calls: Array<ReadonlyArray<string>> = [];
    const env = { BATON_HISTORY_SEARCH: "/x/search.sh" };
    const run = async (_f: string, args: ReadonlyArray<string>) => (calls.push(args), "result");
    expect(await askHistory(env, { query: "price; rm -rf --all page" }, run)).toEqual({
      ok: true,
      text: "result",
    });
    expect(calls[0]).toEqual(["price;", "rm", "-rf", "page"].filter((w) => w !== "-rf"));
    await askHistory(env, { session: "cc828d1b" }, run);
    expect(calls[1]).toEqual(["show", "cc828d1b"]);
    expect((await askHistory(env, { session: "x; ls" }, run)).ok).toBe(false);
    expect((await askHistory(env, { query: "  " }, run)).ok).toBe(false);
    expect(
      await askHistory(env, { query: "a" }, async () => Promise.reject(new Error("boom"))),
    ).toEqual({
      ok: false,
      why: "The history search did not answer.",
    });
  });
});

describe("parseLearnings", () => {
  it("takes a short quote and the session id from each line, with the venture when it is tagged", () => {
    const out = parseLearnings(
      [
        "cc828d1b  venture: shopfront  Learned that the supplier needs the invoice before shipping starts",
        "no id on this line at all, so it is skipped completely",
        "deadbeef short",
        "cc828d1b  venture: shopfront  Learned that the supplier needs the invoice before shipping starts",
      ].join("\n"),
    );
    expect(out).toEqual([
      {
        sessionId: "cc828d1b",
        quote:
          "venture: shopfront Learned that the supplier needs the invoice before shipping starts",
        venture: "shopfront",
      },
    ]);
  });
  it("reads the index's real header-then-snippet output, skipping tool dumps and naming the venture", () => {
    // Shape captured from history-index.py search (2026-11-02), names and words replaced.
    const real = [
      "4 hit(s)",
      "2026-09-29T00:23  tool_result -home-user-shopfront  29e8e17a-6302-457b-812d-467dd26646cc agent a362ef05accb7d07b",
      '    [tool_result] components/voice/settings.tsx:45: ? "Cloud voice has no monthly limit on this plan." components/voice/settings.tsx:84:…',
      "",
      "2026-11-01T11:54  director    -mnt-Data-Volume-42-dev-t3code  5ab4ae0c-3cf4-4d50-aae3-94117d982204",
      "    Director on voice storage, for the History page. Today no dictation audio is kept. Wanted: 1) Text, raw and cleaned…",
      "",
      "2026-11-01T11:54  director    prompts  5ab4ae0c-3cf4-4d50-aae3-94117d982204",
      "    …in /work/t3code] Director on voice storage, for the History page. Today no dictation audio is kept. Wanted: 1) Te…",
      "",
      "2026-10-04T13:55  assistant   -home-user-shop-two  29e8e17a-6302-457b-812d-467dd26646cc agent a83fb26c24526e059",
      '    …eld, className, label = "Dictate", }: { field: DictationField className?: string /** Names the field for a screen reader',
    ].join("\n");
    const out = parseLearnings(real);
    expect(out.map((o) => [o.sessionId, o.venture])).toEqual([
      ["5ab4ae0c-3cf4-4d50-aae3-94117d982204", "t3code"],
      ["5ab4ae0c-3cf4-4d50-aae3-94117d982204", null],
      ["29e8e17a-6302-457b-812d-467dd26646cc", "shop-two"],
    ]);
    expect(out[0]!.quote.startsWith("Director on voice storage")).toBe(true);
  });
  it("never returns more than asked or longer than a quote", () => {
    const lines = Array.from(
      { length: 40 },
      (_, i) => `abcdef${String(i).padStart(2, "0")} ${"x".repeat(900)}`,
    ).join("\n");
    const out = parseLearnings(lines, 5);
    expect(out).toHaveLength(5);
    expect(out[0]!.quote.length).toBeLessThanOrEqual(300);
  });
});
