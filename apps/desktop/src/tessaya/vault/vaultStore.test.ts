// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it, vi } from "vite-plus/test";

import { createVault, VaultError } from "./vaultStore.ts";

const FAKE = "fake-test-value-1234";
const cheap = { N: 1024, r: 8, p: 1 };
const make = (over: Partial<Parameters<typeof createVault>[0]> = {}) => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "baton-vault-"));
  const file = NodePath.join(dir, "vault.json");
  return { dir, file, vault: createVault({ file, kdf: cheap, ...over }) };
};
const os = {
  wrap: (k: Buffer) => `os:${k.toString("base64")}`,
  unwrap: (w: string) => Buffer.from(w.slice(3), "base64"),
};

describe("the vault", () => {
  it("keeps nothing readable on disk, and opens again with the passphrase or the recovery key", () => {
    const { file, vault } = make();
    const { recoveryKey } = vault.create("correct horse battery");
    vault.add({ name: "github", label: "GitHub token", category: "key", value: FAKE });
    const onDisk = NodeFS.readFileSync(file, "utf8");
    expect(onDisk).not.toContain(FAKE);
    expect(onDisk).not.toContain("github");

    vault.lock();
    expect(() => vault.list()).toThrow("locked");
    expect(() => vault.unlockWithPassphrase("wrong passphrase")).toThrow(VaultError);
    vault.unlockWithPassphrase("correct horse battery");
    expect(vault.list().map((i) => i.name)).toEqual(["github"]);
    expect(JSON.stringify(vault.list())).not.toContain(FAKE);

    vault.lock();
    vault.unlockWithRecovery(recoveryKey.toLowerCase());
    expect(vault.valueOf("github")?.value).toBe(FAKE);
    expect(() => make().vault.unlockWithRecovery("nope")).toThrow();
  });

  it("detects tampering", () => {
    const { file, vault } = make();
    vault.create("correct horse battery");
    vault.add({ name: "a", label: "", category: "note", value: "x-fake-note" });
    vault.lock();
    const f = JSON.parse(NodeFS.readFileSync(file, "utf8"));
    f.data.ct = Buffer.from("tampered").toString("base64");
    NodeFS.writeFileSync(file, JSON.stringify(f));
    expect(() => vault.unlockWithPassphrase("correct horse battery")).toThrow("did not open");
  });

  it("financial items are always 'he types it himself'; names are checked", () => {
    const { vault } = make();
    vault.create("correct horse battery");
    expect(
      vault.add({
        name: "bank",
        label: "",
        category: "financial",
        value: FAKE,
        policy: { mode: "ask" },
      }).policy,
    ).toEqual({ mode: "self" });
    expect(
      vault.update(vault.list()[0]!.id, { policy: { mode: "domain", minutes: 5 } }).policy,
    ).toEqual({ mode: "self" });
    expect(() => vault.add({ name: "Bad Name", label: "", category: "key", value: FAKE })).toThrow(
      "lower-case",
    );
    expect(() => vault.add({ name: "bank", label: "", category: "key", value: FAKE })).toThrow(
      "already",
    );
    expect(() => vault.add({ name: "empty", label: "", category: "key", value: "" })).toThrow(
      "nothing",
    );
  });

  it("locks itself when idle", () => {
    vi.useFakeTimers();
    const onLock = vi.fn();
    const { vault } = make({ idleMs: 1000, onLock });
    vault.create("correct horse battery");
    vi.advanceTimersByTime(1500);
    expect(vault.isUnlocked()).toBe(false);
    expect(onLock).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("the Windows account unlocks only after consent", async () => {
    const { vault } = make({ os });
    vault.create("correct horse battery");
    vault.lock();
    await expect(vault.unlockWithOs(async () => false)).rejects.toThrow("Hello");
    expect(vault.isUnlocked()).toBe(false);
    await vault.unlockWithOs(async () => true);
    expect(vault.isUnlocked()).toBe(true);
  });

  it("exports and imports as ciphertext, merging by name", () => {
    const a = make();
    a.vault.create("correct horse battery");
    a.vault.add({ name: "one", label: "", category: "key", value: FAKE });
    const blob = a.vault.exportBlob("export passphrase");
    expect(blob).not.toContain(FAKE);
    const b = make();
    b.vault.create("another passphrase");
    b.vault.add({ name: "two", label: "", category: "key", value: "other-fake-value" });
    expect(() => b.vault.importBlob(blob, "wrong one")).toThrow("did not open");
    expect(b.vault.importBlob(blob, "export passphrase")).toBe(1);
    expect(b.vault.importBlob(blob, "export passphrase")).toBe(0);
    expect(
      b.vault
        .list()
        .map((i) => i.name)
        .toSorted(),
    ).toEqual(["one", "two"]);
  });
});
