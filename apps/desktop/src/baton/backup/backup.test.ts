// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { applyRestore, memoryRestore, planBackup, previewRestore, writeBackup } from "./backup.ts";
import { backupControls } from "./backupRows.ts";
import { makeZip, readZip } from "./zip.ts";

const tmp = () => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "backup-"));
const put = (dir: string, name: string, text: string) => {
  const file = NodePath.join(dir, ...name.split("/"));
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  NodeFS.writeFileSync(file, text);
};

describe("zip", () => {
  it("round-trips, and rejects damage", () => {
    const zip = makeZip([
      { name: "a/b.txt", data: Buffer.from("hello") },
      { name: "c.json", data: Buffer.from("{}") },
    ]);
    const back = readZip(zip);
    expect(back).not.toBeInstanceOf(Error);
    expect(
      (back as Array<{ name: string; data: Buffer }>).map((e) => `${e.name}:${e.data}`),
    ).toEqual(["a/b.txt:hello", "c.json:{}"]);
    const bad = Buffer.from(zip);
    bad[37] = bad[37]! ^ 0xff;
    expect(readZip(bad)).toBeInstanceOf(Error);
    expect(readZip(Buffer.from("not a zip at all, just text"))).toBeInstanceOf(Error);
  });
});

describe("backup and restore", () => {
  it("takes settings, notes and the pack, and never the vault, logs or a file holding a secret", () => {
    const from = tmp();
    put(from, "fabric-voice.json", '{"holdKey":"F9"}');
    put(from, "snippets.json", "[]");
    put(from, "memory/likes-tea.md", "He likes tea.");
    put(from, "operating-system/executive.md", "Be brief.");
    put(from, "operating-system/roles/legal.md", "A lawyer.");
    put(from, "vault.json", "ENCRYPTED");
    put(from, "vault-audit.ndjson", "{}");
    put(
      from,
      "scratchpad.json",
      '{"notes":["key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789"]}',
    );
    put(from, "baton-conversation.ndjson", '{"id":1}');
    put(from, "conversation/assistant.ndjson", '{"id":1}');
    const tea = {
      id: "m1",
      kind: "preference",
      text: "He likes tea",
      source: "user",
      sourceRef: null,
      scope: "global",
      scopeRef: null,
      confidence: 1,
      pinned: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      lastUsedAt: null,
      expiresAt: null,
      supersededBy: null,
      proposed: false,
    } as const;
    const plan = planBackup(from, [tea]);
    const names = plan.entries.map((e) => e.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "fabric-voice.json",
        "snippets.json",
        "memory/likes-tea.md",
        "operating-system/executive.md",
        "operating-system/roles/legal.md",
        "baton-conversation.ndjson",
        "conversation/assistant.ndjson",
        "memory-server.json",
      ]),
    );
    // The memory comes back whole: his source, the pin and the id, as a push the server checks again.
    const kept = plan.entries.find((e) => e.name === "memory-server.json")!;
    expect(memoryRestore(kept.data, "2026-02-01T00:00:00.000Z")).toEqual({
      from: "backup",
      changes: [{ item: tea, tombstone: null, writer: "backup" }],
      upTo: "2026-02-01T00:00:00.000Z",
    });
    expect(memoryRestore(Buffer.from("not json"), "x")).toBeNull();
    expect(names.join()).not.toMatch(/vault/);
    expect(plan.skipped.map((s) => s.name)).toEqual(["scratchpad.json"]);
  });

  it("previews first, then restores, keeping a .bak of what it replaces", () => {
    const from = tmp();
    put(from, "fabric-voice.json", '{"holdKey":"F9"}');
    put(from, "snippets.json", "[1]");
    const zipFile = NodePath.join(tmp(), "b.zip");
    writeBackup(zipFile, planBackup(from, null));

    const to = tmp();
    put(to, "fabric-voice.json", '{"holdKey":"Pause"}');
    put(to, "snippets.json", "[1]");
    const preview = previewRestore(NodeFS.readFileSync(zipFile), to);
    if (preview instanceof Error) throw preview;
    expect(Object.fromEntries(preview.rows.map((r) => [r.name, r.action]))).toEqual({
      "fabric-voice.json": "replaces",
      "snippets.json": "same",
    });
    expect(NodeFS.readFileSync(NodePath.join(to, "fabric-voice.json"), "utf8")).toBe(
      '{"holdKey":"Pause"}',
    );
    expect(applyRestore(preview, to)).toBe(1);
    expect(NodeFS.readFileSync(NodePath.join(to, "fabric-voice.json"), "utf8")).toBe(
      '{"holdKey":"F9"}',
    );
    expect(NodeFS.readFileSync(NodePath.join(to, "fabric-voice.json.bak"), "utf8")).toBe(
      '{"holdKey":"Pause"}',
    );
  });

  it("restores a backup from before P2 into the lead's conversation, and says so; .1 files go both ways", () => {
    const old = tmp();
    put(old, "baton-conversation.ndjson", '{"id":2}');
    put(old, "baton-conversation.ndjson.1", '{"id":1}');
    put(old, "conversation/assistant.ndjson.1", '{"id":3}');
    const zipFile = NodePath.join(tmp(), "old.zip");
    writeBackup(zipFile, planBackup(old, null));

    const to = tmp();
    put(to, "conversation/executive.ndjson", '{"id":9}');
    const preview = previewRestore(NodeFS.readFileSync(zipFile), to);
    if (preview instanceof Error) throw preview;
    expect(preview.rows).toEqual([
      {
        name: "conversation/executive.ndjson",
        from: "baton-conversation.ndjson",
        action: "replaces",
      },
      {
        name: "conversation/executive.ndjson.1",
        from: "baton-conversation.ndjson.1",
        action: "new",
      },
      { name: "conversation/assistant.ndjson.1", action: "new" },
    ]);
    expect(backupControls({ file: "old.zip", rows: preview.rows }, null)[2]?.label).toBe(
      "baton-conversation.ndjson → conversation/executive.ndjson",
    );
    expect(applyRestore(preview, to)).toBe(3);
    expect(NodeFS.readFileSync(NodePath.join(to, "conversation/executive.ndjson"), "utf8")).toBe(
      '{"id":2}',
    );
    expect(NodeFS.existsSync(NodePath.join(to, "baton-conversation.ndjson"))).toBe(false);
  });

  it("refuses any name it would not have written, so a hand-made zip cannot climb out", () => {
    const zip = makeZip([
      { name: "../evil.json", data: Buffer.from("x") },
      { name: "vault.json", data: Buffer.from("x") },
      // Separators and drives only Windows reads: they climb out there.
      { name: "memory/x\\..\\..\\..\\settings.md", data: Buffer.from("x") },
      { name: "memory/c:evil.md", data: Buffer.from("x") },
      { name: "snippets.json", data: Buffer.from("[]") },
    ]);
    const to = tmp();
    const preview = previewRestore(zip, to);
    if (preview instanceof Error) throw preview;
    expect(preview.rows.map((r) => r.action)).toEqual([
      "refused",
      "refused",
      "refused",
      "refused",
      "new",
    ]);
    expect(applyRestore(preview, to)).toBe(1);
    expect(NodeFS.readdirSync(to)).toEqual(["snippets.json"]);
  });
});
