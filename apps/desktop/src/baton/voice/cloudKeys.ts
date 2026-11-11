// @effect-diagnostics nodeBuiltinImport:off
/**
 * His cloud speech keys, one per provider, wrapped by the OS (Electron safeStorage) in voice/cloud-keys.json. Not the
 * vault: that locks after ten idle minutes, and dictation must not stop for a Windows Hello prompt mid-sentence. Never in
 * settings.json, never in a log; a key that will not unwrap counts as no key.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { CloudSttProvider } from "@t3tools/baton-shared/cloudStt";

/** Wraps and unwraps with the OS; null where that is not real encryption (Linux's basic_text). */
export interface KeyProtection {
  readonly protect: (plain: string) => string;
  readonly unprotect: (wrapped: string) => string;
}

export interface CloudKeys<K extends string = CloudSttProvider> {
  /** The key to use, or null: none kept, one that will not unwrap, or one the provider refused. */
  readonly get: (provider: K) => string | null;
  readonly has: (provider: K) => boolean;
  /** The provider answered 401/403: the cloud is not tried with this key again until he saves or removes one. */
  readonly refuse: (provider: K) => void;
  readonly refused: (provider: K) => boolean;
  /** Throws when this computer cannot encrypt it, so it is never kept in the clear. */
  readonly set: (provider: K, key: string) => void;
  readonly clear: (provider: K) => void;
}

/** API keys are long runs of letters, digits and - _ . (sk-..., AIza..., sk-or-v1-...); anything else is a paste gone wrong. */
const KEY_SHAPE = /^[A-Za-z0-9_.-]{20,400}$/;

/** Also keeps his recogniser tokens, by server address (`K` = string), in their own file. */
export const createCloudKeys = <K extends string = CloudSttProvider>(
  file: string,
  protection: () => KeyProtection | null,
): CloudKeys<K> => {
  const read = (): Partial<Record<K, string>> => {
    try {
      const parsed = JSON.parse(NodeFS.readFileSync(file, "utf8")) as unknown;
      return parsed !== null && typeof parsed === "object"
        ? (parsed as Partial<Record<K, string>>)
        : {};
    } catch {
      return {};
    }
  };
  const write = (all: Partial<Record<K, string>>) => {
    NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
    NodeFS.writeFileSync(file, JSON.stringify(all), { mode: 0o600 });
  };
  // Unwrapped once and kept in memory: the settings page asks on every draw, and a file read plus a decrypt each time is waste.
  const cache = new Map<K, string | null>();
  const refusedBy = new Set<K>();
  const unwrap = (provider: K): string | null => {
    const wrapped = read()[provider];
    const os = protection();
    if (typeof wrapped !== "string" || os === null) return null;
    try {
      const key = os.unprotect(wrapped);
      return key === "" ? null : key;
    } catch {
      return null;
    }
  };
  const kept = (provider: K): string | null => {
    if (!cache.has(provider)) cache.set(provider, unwrap(provider));
    return cache.get(provider) ?? null;
  };
  const forget = (provider: K) => {
    cache.delete(provider);
    refusedBy.delete(provider);
  };
  return {
    get: (provider) => (refusedBy.has(provider) ? null : kept(provider)),
    has: (provider) => kept(provider) !== null,
    refuse: (provider) => void refusedBy.add(provider),
    refused: (provider) => refusedBy.has(provider),
    set: (provider, key) => {
      const os = protection();
      if (os === null) {
        throw new Error(
          "This computer cannot encrypt the key, so it is not kept. Cloud recognition needs a key it can keep safely.",
        );
      }
      const trimmed = key.trim();
      if (!KEY_SHAPE.test(trimmed)) {
        throw new Error(
          "That does not look like an API key: it should be one line of letters, digits, dashes and underscores.",
        );
      }
      write({ ...read(), [provider]: os.protect(trimmed) });
      forget(provider);
    },
    clear: (provider) => {
      const rest = { ...read() };
      delete rest[provider];
      write(rest);
      forget(provider);
    },
  };
};
