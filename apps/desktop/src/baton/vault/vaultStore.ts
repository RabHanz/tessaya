// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off
/**
 * The vault (D151, docs/baton/VAULT.md): one encrypted file, locked until he opens it, locking itself
 * when idle. Nothing here writes a value anywhere but into that file as ciphertext.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  NAME_PATTERN,
  VAULT_VALUE_MAX,
  listing,
  policyFor,
  type VaultCategory,
  type VaultItem,
  type VaultListing,
  type VaultPolicy,
} from "@t3tools/baton-shared/vault";

import {
  DEFAULT_KDF,
  deriveKey,
  newRecoveryKey,
  open,
  parseRecoveryKey,
  randomKey,
  seal,
  type KdfParams,
  type Sealed,
} from "@t3tools/baton-shared/vaultCrypto";

// @effect-diagnostics-next-line extendsNativeError:off -- a Promise API, never in an Effect failure channel.
export class VaultError extends Error {
  override readonly name = "VaultError";
}

interface VaultFile {
  readonly v: 1;
  readonly kdf: KdfParams;
  readonly salt: string;
  readonly byPassphrase: Sealed;
  readonly byRecovery: Sealed;
  /** The vault key wrapped by Windows DPAPI (`safeStorage`), as base64; absent where there is none. */
  readonly byOs?: string;
  readonly data: Sealed;
}

/** The operating system's own wrapping (Electron `safeStorage`), injected so tests need no Electron. */
export interface OsWrap {
  readonly wrap: (key: Buffer) => string | null;
  readonly unwrap: (wrapped: string) => Buffer | null;
}

const AAD_DATA = "vault-v1-data";
const AAD_WRAP = "vault-v1-wrap";
const IDLE_MS = 10 * 60_000;

export const createVault = (input: {
  readonly file: string;
  readonly os?: OsWrap;
  readonly kdf?: KdfParams;
  readonly idleMs?: number;
  readonly now?: () => number;
  /** Called when it locks, for the window and the clipboard. */
  readonly onLock?: () => void;
}) => {
  const now = input.now ?? Date.now;
  const kdf = input.kdf ?? DEFAULT_KDF;
  let key: Buffer | null = null;
  let items: VaultItem[] | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const read = (): VaultFile | null => {
    try {
      return JSON.parse(NodeFS.readFileSync(input.file, "utf8")) as VaultFile;
    } catch {
      return null;
    }
  };
  const exists = (): boolean => read() !== null;

  const write = (file: VaultFile): void => {
    NodeFS.mkdirSync(NodePath.dirname(input.file), { recursive: true });
    const tmp = `${input.file}.tmp`;
    NodeFS.writeFileSync(tmp, JSON.stringify(file), { mode: 0o600 });
    NodeFS.renameSync(tmp, input.file);
  };

  const lock = (): void => {
    key?.fill(0);
    key = null;
    items = null;
    clearTimeout(timer);
    input.onLock?.();
  };
  const touch = (): void => {
    clearTimeout(timer);
    timer = setTimeout(lock, input.idleMs ?? IDLE_MS);
    timer.unref();
  };
  const need = (): { key: Buffer; items: VaultItem[] } => {
    if (key === null || items === null) throw new VaultError("The vault is locked.");
    touch();
    return { key, items };
  };
  const save = (): void => {
    const { key: k, items: list } = need();
    const file = read();
    if (file === null) throw new VaultError("The vault file is missing.");
    write({ ...file, data: seal(k, Buffer.from(JSON.stringify(list)), AAD_DATA) });
  };

  const unlockWith = (vaultKey: Buffer, file: VaultFile): void => {
    try {
      items = JSON.parse(open(vaultKey, file.data, AAD_DATA).toString("utf8")) as VaultItem[];
    } catch {
      throw new VaultError("That did not open the vault.");
    }
    key = vaultKey;
    touch();
  };
  const unwrapWith = (kek: Buffer, sealed: Sealed): Buffer => {
    try {
      return open(kek, sealed, AAD_WRAP);
    } catch {
      throw new VaultError("That did not open the vault.");
    }
  };

  const clean = (value: string): string => {
    if (value.length === 0) throw new VaultError("There is nothing to keep.");
    if (Buffer.byteLength(value) > VAULT_VALUE_MAX)
      throw new VaultError("That is too big for the vault (256 KB).");
    return value;
  };

  return {
    exists,
    isUnlocked: (): boolean => key !== null,
    lock,

    /** Makes the vault and opens it. The recovery key is returned once and kept nowhere. */
    create: (passphrase: string): { readonly recoveryKey: string } => {
      if (exists()) throw new VaultError("A vault already exists.");
      if (passphrase.length < 8) throw new VaultError("Use a passphrase of at least 8 characters.");
      const vaultKey = randomKey();
      const salt = NodeCrypto.randomBytes(16);
      const recovery = newRecoveryKey();
      const osWrapped = input.os?.wrap(vaultKey) ?? null;
      const file: VaultFile = {
        v: 1,
        kdf,
        salt: salt.toString("base64"),
        byPassphrase: seal(deriveKey(passphrase, salt, kdf), vaultKey, AAD_WRAP),
        byRecovery: seal(recovery.bytes, vaultKey, AAD_WRAP),
        ...(osWrapped === null ? {} : { byOs: osWrapped }),
        data: seal(vaultKey, Buffer.from("[]"), AAD_DATA),
      };
      write(file);
      unlockWith(vaultKey, file);
      return { recoveryKey: recovery.text };
    },

    unlockWithPassphrase: (passphrase: string): void => {
      const file = read();
      if (file === null) throw new VaultError("There is no vault yet.");
      const kek = deriveKey(passphrase, Buffer.from(file.salt, "base64"), file.kdf);
      unlockWith(unwrapWith(kek, file.byPassphrase), file);
    },
    unlockWithRecovery: (text: string): void => {
      const file = read();
      const kek = parseRecoveryKey(text);
      if (file === null) throw new VaultError("There is no vault yet.");
      if (kek === null) throw new VaultError("That is not a recovery key.");
      unlockWith(unwrapWith(kek, file.byRecovery), file);
    },
    /** `consent` is the Windows Hello prompt; without a yes the wrapped key is never touched. */
    unlockWithOs: async (consent: () => Promise<boolean>): Promise<void> => {
      const file = read();
      if (file === null) throw new VaultError("There is no vault yet.");
      if (file.byOs === undefined || input.os === undefined) {
        throw new VaultError("This computer's account cannot open the vault; use the passphrase.");
      }
      if (!(await consent())) throw new VaultError("Windows Hello did not confirm it is you.");
      const vaultKey = input.os.unwrap(file.byOs);
      if (vaultKey === null)
        throw new VaultError("This computer's account cannot open the vault; use the passphrase.");
      unlockWith(vaultKey, file);
    },

    list: (): ReadonlyArray<VaultListing> => need().items.map(listing),

    add: (item: {
      readonly name: string;
      readonly label: string;
      readonly category: VaultCategory;
      readonly value: string;
      readonly policy?: VaultPolicy;
    }): VaultListing => {
      const { items: list } = need();
      if (!NAME_PATTERN.test(item.name)) {
        throw new VaultError("A name is lower-case letters, digits, dots, dashes or underscores.");
      }
      if (list.some((i) => i.name === item.name))
        throw new VaultError("There is already a secret by that name.");
      const at = new Date(now()).toISOString();
      const made: VaultItem = {
        id: NodeCrypto.randomUUID(),
        name: item.name,
        label: item.label.slice(0, 120),
        category: item.category,
        value: clean(item.value),
        policy: policyFor(item.category, item.policy ?? { mode: "ask" }),
        createdAt: at,
        updatedAt: at,
      };
      list.push(made);
      save();
      return listing(made);
    },

    update: (
      id: string,
      patch: { label?: string; value?: string; policy?: VaultPolicy; name?: string },
    ): VaultListing => {
      const { items: list } = need();
      const at = list.findIndex((i) => i.id === id);
      if (at < 0) throw new VaultError("There is no such secret.");
      const old = list[at]!;
      if (patch.name !== undefined && patch.name !== old.name) {
        if (!NAME_PATTERN.test(patch.name) || list.some((i) => i.name === patch.name)) {
          throw new VaultError("That name is not available.");
        }
      }
      const next: VaultItem = {
        ...old,
        name: patch.name ?? old.name,
        label: patch.label?.slice(0, 120) ?? old.label,
        value: patch.value === undefined ? old.value : clean(patch.value),
        policy: policyFor(old.category, patch.policy ?? old.policy),
        updatedAt: new Date(now()).toISOString(),
      };
      list[at] = next;
      save();
      return listing(next);
    },

    remove: (id: string): boolean => {
      const { items: list } = need();
      const at = list.findIndex((i) => i.id === id);
      if (at < 0) return false;
      list.splice(at, 1);
      save();
      return true;
    },

    /** The value, for his own eyes or for Tessaya to inject; the caller has already had consent. */
    valueOf: (idOrName: string): VaultItem | null =>
      need().items.find((i) => i.id === idOrName || i.name === idOrName) ?? null,

    /** Every value, so output can be scrubbed. Empty when locked. */
    secrets: (): ReadonlyArray<{ readonly name: string; readonly value: string }> =>
      items === null ? [] : items.map((i) => ({ name: i.name, value: i.value })),

    /** The vault re-wrapped under an export passphrase; carries no plaintext. */
    exportBlob: (exportPassphrase: string): string => {
      const { items: list } = need();
      if (exportPassphrase.length < 8)
        throw new VaultError("Use a passphrase of at least 8 characters.");
      const salt = NodeCrypto.randomBytes(16);
      return JSON.stringify({
        v: 1,
        kdf,
        salt: salt.toString("base64"),
        data: seal(
          deriveKey(exportPassphrase, salt, kdf),
          Buffer.from(JSON.stringify(list)),
          "vault-v1-export",
        ),
      });
    },

    /** Adds what is not here by name; returns how many. */
    importBlob: (blob: string, exportPassphrase: string): number => {
      const { items: list } = need();
      let parsed: { kdf: KdfParams; salt: string; data: Sealed };
      let incoming: VaultItem[];
      try {
        parsed = JSON.parse(blob) as typeof parsed;
        incoming = JSON.parse(
          open(
            deriveKey(exportPassphrase, Buffer.from(parsed.salt, "base64"), parsed.kdf),
            parsed.data,
            "vault-v1-export",
          ).toString("utf8"),
        ) as VaultItem[];
      } catch {
        throw new VaultError("That file or passphrase did not open.");
      }
      let added = 0;
      for (const item of incoming) {
        if (list.some((i) => i.name === item.name) || !NAME_PATTERN.test(item.name)) continue;
        list.push({
          ...item,
          id: NodeCrypto.randomUUID(),
          policy: policyFor(item.category, item.policy),
        });
        added++;
      }
      if (added > 0) save();
      return added;
    },
  };
};

export type Vault = ReturnType<typeof createVault>;
