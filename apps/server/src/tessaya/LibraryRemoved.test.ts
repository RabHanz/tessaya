// @effect-diagnostics nodeBuiltinImport:off - the list is written to a real temp vault.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { writeLibraryRemoved } from "./LibraryRemoved.ts";

describe("library removed list", () => {
  it("seals the list so the library page's key (PBKDF2 + AES-GCM, iv first) opens it, and writes nothing without the library", async () => {
    const vault = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "library-vault-"));
    const salt = NodeCrypto.randomBytes(16);
    NodeFS.writeFileSync(
      NodePath.join(vault, "meta.json"),
      JSON.stringify({ salt: salt.toString("base64"), iter: 1000 }),
    );
    const keyFile = NodePath.join(vault, "key.txt");
    NodeFS.writeFileSync(keyFile, "pass-phrase\n");

    expect(writeLibraryRemoved(["https://x/1"], { TESSAYA_LIBRARY_VAULT: vault })).toBe(false);
    expect(
      writeLibraryRemoved(["https://x/1"], {
        TESSAYA_LIBRARY_VAULT: vault,
        TESSAYA_LIBRARY_KEY_FILE: keyFile,
      }),
    ).toBe(true);

    const base = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("pass-phrase"),
      "PBKDF2",
      false,
      ["deriveKey"],
    );
    const key = await crypto.subtle.deriveKey(
      { name: "PBKDF2", hash: "SHA-256", salt, iterations: 1000 },
      base,
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"],
    );
    const box = NodeFS.readFileSync(NodePath.join(vault, "removed.bin"));
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: box.subarray(0, 12) },
      key,
      box.subarray(12),
    );
    expect(JSON.parse(new TextDecoder().decode(plain))).toEqual(["https://x/1"]);
    expect(NodeFS.existsSync(NodePath.join(vault, "removed.bin.tmp"))).toBe(false);
  });
});
