import { describe, expect, it } from "vite-plus/test";

import { REDACTED } from "@t3tools/baton-shared/memory";

import { openHistory } from "./history.ts";

describe("history", () => {
  it("keeps raw and cleaned text, searches both, retries, and deletes", () => {
    let n = 0;
    const history = openHistory(":memory:", () => `t${(n += 1)}`);
    const a = history.add({
      at: "2026-11-01T10:00:00.000Z",
      kind: "dictation",
      app: "notepad.exe",
      raw: "um hello sam",
      cleaned: "Hello Sam.",
      status: "ok",
      model: "haiku",
      delivery: "oneshot",
      error: null,
    });
    const b = history.add({
      at: "2026-11-01T11:00:00.000Z",
      kind: "dictation",
      app: "chrome.exe",
      raw: "what is 50% of 80",
      cleaned: null,
      status: "failed",
      model: null,
      delivery: "oneshot",
      error: "timed out",
    });
    expect(history.list().map((t) => t.id)).toEqual([b, a]);
    expect(history.list({ query: "sam" }).map((t) => t.id)).toEqual([a]);
    expect(history.list({ query: "50%" }).map((t) => t.id)).toEqual([b]);
    expect(history.list({ before: "2026-11-01T11:00:00.000Z" }).map((t) => t.id)).toEqual([a]);
    const kept = [{ at: "t", raw: "what is fifty percent of eighty", cleaned: null, model: null }];
    history.update(a, { versions: kept });
    expect(history.get(a)?.versions).toEqual(kept);
    expect(history.get(b)?.versions).toEqual([]);
    history.update(b, { cleaned: "What is 50% of 80?", status: "ok", error: null });
    expect(history.get(b)).toMatchObject({
      cleaned: "What is 50% of 80?",
      status: "ok",
      error: null,
      raw: "what is 50% of 80",
    });
    history.update(a, { corrected: true });
    expect(history.get(a)?.corrected).toBe(true);
    expect(history.remove(a)?.id).toBe(a);
    expect(history.get(a)).toBeNull();
    history.close();
  });

  it("never keeps a dictated secret in plain text, however the row is written or changed later (VAULT.md 6)", () => {
    const history = openHistory(":memory:", () => "t1");
    const id = history.add({
      at: "2026-11-08T10:00:00.000Z",
      kind: "dictation",
      app: "",
      raw: "dear sam",
      cleaned: null,
      status: "none",
      model: null,
      delivery: "oneshot",
      error: null,
    });
    // Voice dictation fills its row as the chunks come in: the later words carry the password.
    history.update(id, { raw: "dear sam my password is hunter-fake-77" });
    expect(history.get(id)).toMatchObject({ raw: REDACTED });
    history.update(id, { cleaned: "My password is hunter-fake-77." });
    expect(history.get(id)?.cleaned).toBe(REDACTED);
    history.update(id, { fixed: "the password is hunter-fake-77 now" });
    expect(history.get(id)?.fixed).toBe(REDACTED);
    history.update(id, {
      versions: [{ at: "x", raw: "password is hunter-fake-77", cleaned: null, model: null }],
    });
    expect(history.get(id)?.versions[0]).toMatchObject({ raw: REDACTED });
    // Ordinary words are kept as they are.
    history.update(id, { raw: "see you at five", cleaned: "See you at five." });
    expect(history.get(id)).toMatchObject({ raw: "see you at five", cleaned: "See you at five." });
    history.close();
  });
});
