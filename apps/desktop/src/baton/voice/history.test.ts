// @effect-diagnostics nodeBuiltinImport:off
import { describe, expect, it } from "vite-plus/test";

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

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

  it("a secret marked later redacts the stored words and deletes the kept audio; the decided clean-up is kept", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "history-"));
    const clip = NodePath.join(dir, "clip.webm");
    NodeFS.writeFileSync(clip, "audio");
    const history = openHistory(":memory:", () => "t1");
    const id = history.add({
      at: "2026-11-08T10:00:00.000Z",
      kind: "dictation",
      app: "chrome.exe",
      raw: "the code for the door",
      cleaned: "The code for the door.",
      status: "ok",
      model: null,
      delivery: "hold key",
      error: null,
      audio: clip,
      cleanup: "local",
    });
    expect(history.get(id)?.cleanup).toBe("local");
    // Only the cleaned words carry it: the stored heard words and the recording go too.
    history.update(id, { cleaned: "The password is hunter-fake-77." });
    expect(history.get(id)).toMatchObject({ raw: REDACTED, cleaned: REDACTED, audio: null });
    expect(NodeFS.existsSync(clip)).toBe(false);
    history.close();
    NodeFS.rmSync(dir, { recursive: true, force: true });
  });

  it("a password box or private app keeps that it happened, never the words or the recording, even from a late write", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "history-"));
    const clip = NodePath.join(dir, "clip.webm");
    NodeFS.writeFileSync(clip, "audio");
    const history = openHistory(":memory:", () => "t1");
    const id = history.add({
      at: "2026-11-08T10:00:00.000Z",
      kind: "dictation",
      app: "1password.exe",
      raw: "correct horse battery",
      cleaned: null,
      status: "none",
      model: null,
      delivery: "hold key",
      error: null,
      audio: clip,
    });
    history.hide(id, "password field");
    history.update(id, {
      raw: "correct horse",
      cleaned: "Correct horse.",
      status: "ok",
      fixed: "x",
    });
    expect(history.get(id)).toMatchObject({
      hidden: "password field",
      raw: "",
      cleaned: null,
      fixed: null,
      audio: null,
      status: "ok",
      app: "1password.exe",
    });
    expect(NodeFS.existsSync(clip)).toBe(false);
    expect(history.list({ query: "horse" })).toEqual([]);
    history.close();
    NodeFS.rmSync(dir, { recursive: true, force: true });
  });

  it("delete removes the words and the recording; a flag can be taken back", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "history-"));
    const clips = [NodePath.join(dir, "a.webm"), NodePath.join(dir, "b.webm")];
    for (const clip of clips) NodeFS.writeFileSync(clip, "audio");
    const history = openHistory(":memory:", () => "t1");
    const id = history.add({
      at: "2026-11-08T10:00:00.000Z",
      kind: "dictation",
      app: "slack.exe",
      raw: "hello there",
      cleaned: "Hello there.",
      status: "ok",
      model: null,
      delivery: "oneshot",
      error: null,
      audio: clips.join("\n"),
    });
    history.flag(id, true);
    expect(history.get(id)?.flagged).toBe(true);
    history.flag(id, false);
    expect(history.get(id)?.flagged).toBe(false);
    history.remove(id);
    expect(history.get(id)).toBeNull();
    expect(history.list({ query: "hello" })).toEqual([]);
    expect(clips.filter((clip) => NodeFS.existsSync(clip))).toEqual([]);
    history.close();
    NodeFS.rmSync(dir, { recursive: true, force: true });
  });

  it("scrubs rows kept before redaction covered every write, once", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "history-"));
    const file = NodePath.join(dir, "history.sqlite");
    // A file as an older build left it: a voice row whose later words were kept in plain text.
    const old = new NodeSqlite.DatabaseSync(file);
    old.exec(`create table turns (id text primary key, at text not null, kind text not null, app text not null default '',
      raw text not null, cleaned text, status text not null, model text, delivery text, audio text,
      corrected integer not null default 0, error text, fixed text, seconds real, versions text)`);
    old
      .prepare("insert into turns (id, at, kind, raw, cleaned, status) values (?, ?, ?, ?, ?, ?)")
      .run(
        "a",
        "2026-11-01T10:00:00.000Z",
        "dictation",
        "my password is hunter-fake-77",
        null,
        "none",
      );
    old
      .prepare("insert into turns (id, at, kind, raw, cleaned, status) values (?, ?, ?, ?, ?, ?)")
      .run(
        "b",
        "2026-11-01T11:00:00.000Z",
        "dictation",
        "see you at five",
        "See you at five.",
        "ok",
      );
    old.close();
    const history = openHistory(file);
    expect(history.get("a")?.raw).toBe(REDACTED);
    expect(history.get("b")?.raw).toBe("see you at five");
    history.close();
    // Once: a later open does not scan again (and a row written since is already safe).
    const again = new NodeSqlite.DatabaseSync(file);
    expect(
      (again.prepare("pragma user_version").get() as { user_version: number }).user_version,
    ).toBe(1);
    again.close();
    NodeFS.rmSync(dir, { recursive: true, force: true });
  });
});
