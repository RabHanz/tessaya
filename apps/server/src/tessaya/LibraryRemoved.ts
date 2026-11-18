// @effect-diagnostics nodeBuiltinImport:off
/**
 * The private design library's removed list: sources of models he removed in his model viewer, sealed here on the brain
 * under the library's own key (PBKDF2-SHA256 from its passphrase and the vault's meta.json salt, AES-256-GCM, iv first)
 * so its static page hides them after unlock. The key file stays on the brain; a worker only sends the list over the peer link.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Schema from "effect/Schema";

export const LibraryRemovedAct = Schema.Struct({
  sources: Schema.Array(Schema.String.check(Schema.isMaxLength(300))).check(
    Schema.isMaxLength(2000),
  ),
});

/** Seals one list as the library page reads it. */
export const sealLibraryList = (sources: ReadonlyArray<string>, key: Uint8Array): Buffer => {
  const iv = NodeCrypto.randomBytes(12);
  const cipher = NodeCrypto.createCipheriv("aes-256-gcm", key, iv);
  return Buffer.concat([
    iv,
    cipher.update(JSON.stringify(sources)),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
};

/**
 * Writes `<vault>/removed.bin` from TESSAYA_LIBRARY_VAULT and TESSAYA_LIBRARY_KEY_FILE; false when either is unset, so a
 * server without the library keeps nothing.
 */
export const writeLibraryRemoved = (
  sources: ReadonlyArray<string>,
  env: Record<string, string | undefined> = process.env,
): boolean => {
  const vault = env["TESSAYA_LIBRARY_VAULT"];
  const keyFile = env["TESSAYA_LIBRARY_KEY_FILE"];
  if (!vault || !keyFile) return false;
  const meta = JSON.parse(NodeFS.readFileSync(NodePath.join(vault, "meta.json"), "utf8")) as {
    salt: string;
    iter: number;
  };
  const key = NodeCrypto.pbkdf2Sync(
    NodeFS.readFileSync(keyFile, "utf8").trim(),
    Buffer.from(meta.salt, "base64"),
    meta.iter,
    32,
    "sha256",
  );
  const tmp = NodePath.join(vault, "removed.bin.tmp");
  NodeFS.writeFileSync(tmp, sealLibraryList(sources, key));
  NodeFS.renameSync(tmp, NodePath.join(vault, "removed.bin"));
  key.fill(0);
  return true;
};
