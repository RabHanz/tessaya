// @effect-diagnostics nodeBuiltinImport:off
/**
 * A key kept in the Vault instead of as a file on disk. Using it asks Windows Hello (where there is one;
 * elsewhere the unlocked vault is the gate), writes the key to a private temporary file only for the one
 * call, and deletes it straight after. The text is never logged, returned in a message or shown.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

export interface VaultKeyPorts {
  readonly unlocked: () => boolean;
  /** The text of a vault item by name, or null. */
  readonly read: (name: string) => string | null;
  readonly hello: (message: string) => Promise<"verified" | "declined" | "unavailable">;
  readonly tmpDir?: string;
}

export type KeyUse =
  | { readonly ok: true; readonly path: string; readonly done: () => void }
  | { readonly ok: false; readonly error: string };

export const useVaultKey = async (
  name: string,
  why: string,
  ports: VaultKeyPorts,
): Promise<KeyUse> => {
  if (!ports.unlocked())
    return {
      ok: false,
      error: "The vault is locked. Unlock it in the Vault page, then try again.",
    };
  const text = ports.read(name);
  if (text === null) return { ok: false, error: "There is no key by that name in the vault." };
  const hello = await ports.hello(why);
  if (hello === "declined")
    return { ok: false, error: "The key was not used: it was not confirmed." };
  const dir = NodeFS.mkdtempSync(NodePath.join(ports.tmpDir ?? NodeOS.tmpdir(), "tessaya-key-"));
  const path = NodePath.join(dir, "key");
  // OpenSSH refuses a key file that others can read, so it is private from the first byte.
  NodeFS.writeFileSync(path, text.endsWith("\n") ? text : `${text}\n`, { mode: 0o600 });
  return { ok: true, path, done: () => NodeFS.rmSync(dir, { recursive: true, force: true }) };
};
