// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { useVaultKey, type VaultKeyPorts } from "./vaultKey.ts";

const KEY = "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----";
const ports = (over: Partial<VaultKeyPorts> = {}): VaultKeyPorts => ({
  unlocked: () => true,
  read: (n) => (n === "approver" ? KEY : null),
  hello: async () => "verified",
  tmpDir: NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "vk-")),
  ...over,
});

describe("a key kept in the vault", () => {
  it("is confirmed, written privately for one call, and gone afterwards", async () => {
    const p = ports();
    const used = await useVaultKey("approver", "Approve a cloud task", p);
    if (!used.ok) throw new Error(used.error);
    expect(NodeFS.readFileSync(used.path, "utf8")).toBe(`${KEY}\n`);
    if (used.path.startsWith("/")) expect(NodeFS.statSync(used.path).mode & 0o077).toBe(0);
    used.done();
    expect(NodeFS.existsSync(used.path)).toBe(false);
  });

  it("says plainly when the vault is locked, the key is missing or Hello was declined, and writes nothing", async () => {
    const p = ports();
    const before = NodeFS.readdirSync(p.tmpDir!).length;
    expect(await useVaultKey("approver", "x", { ...p, unlocked: () => false })).toEqual({
      ok: false,
      error: "The vault is locked. Unlock it in the Vault page, then try again.",
    });
    expect(await useVaultKey("nope", "x", p)).toEqual({
      ok: false,
      error: "There is no key by that name in the vault.",
    });
    const declined = await useVaultKey("approver", "x", { ...p, hello: async () => "declined" });
    expect(declined).toEqual({ ok: false, error: "The key was not used: it was not confirmed." });
    expect(JSON.stringify(declined)).not.toContain("PRIVATE");
    expect(NodeFS.readdirSync(p.tmpDir!).length).toBe(before);
  });

  it("uses an unlocked vault as the gate where there is no Hello", async () => {
    const used = await useVaultKey("approver", "x", ports({ hello: async () => "unavailable" }));
    expect(used.ok).toBe(true);
    if (used.ok) used.done();
  });
});
