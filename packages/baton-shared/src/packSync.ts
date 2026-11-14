// @effect-diagnostics nodeBuiltinImport:off
/**
 * One pack, owned by the household's home server (SPINE-UNIFY §10, P4). Another of his servers (his laptop's, which
 * the desktop shares a folder with) keeps a working copy: what changed here since the last sync goes to the home, and
 * what changed there comes back. The home wins a file both changed. Pure, so both ends share one reading.
 */
import * as NodeCrypto from "node:crypto";

/** A pack file's path inside the pack folder (`roles/nova.md`) to its text. */
export type PackFiles = Readonly<Record<string, string>>;

/** Each path's sha256 when the two last agreed. */
export type PackBase = Readonly<Record<string, string>>;

const MAX_PACK_FILE = 64 * 1024;
/**
 * What syncs: his text files (role files, the executive brief, templates, routing). Not the home server's own wake
 * store and models, not skill drafts (they stay in his review on the laptop, SPINE-UNIFY §9), not dot-files.
 */
export const packPathSyncs = (path: string): boolean =>
  /^[\w-]+(\/[\w-]+)*\.(md|json)$/.test(path) &&
  !/^(wake|wake-requests|skills)\//.test(path) &&
  path !== "wake-models.json" &&
  path !== "skills.json";

export const packHash = (text: string) =>
  NodeCrypto.createHash("sha256").update(text).digest("hex");

export const packFileFits = (text: string) => Buffer.byteLength(text) <= MAX_PACK_FILE;

export interface PackPlan {
  /** Files to send the home (a null text deletes it there). */
  readonly push: ReadonlyArray<{ readonly path: string; readonly text: string | null }>;
  /** Files to write here (a null text deletes it here). */
  readonly pull: ReadonlyArray<{ readonly path: string; readonly text: string | null }>;
  /** The base once both are applied. */
  readonly base: PackBase;
}

/** The three-way plan: base is what both had, `here` this server's copy, `home` the home server's. */
export const planPackSync = (base: PackBase, here: PackFiles, home: PackFiles): PackPlan => {
  const push: Array<{ path: string; text: string | null }> = [];
  const pull: Array<{ path: string; text: string | null }> = [];
  const next: Record<string, string> = {};
  const paths = new Set([...Object.keys(base), ...Object.keys(here), ...Object.keys(home)]);
  for (const path of [...paths].toSorted()) {
    if (!packPathSyncs(path)) continue;
    const b = base[path];
    const h = here[path] === undefined ? undefined : packHash(here[path]!);
    const o = home[path] === undefined ? undefined : packHash(home[path]!);
    const changedHere = h !== b;
    const changedHome = o !== b;
    if (!changedHere && !changedHome) {
      if (o !== undefined) next[path] = o;
      continue;
    }
    if (h === o) {
      if (o !== undefined) next[path] = o;
      continue;
    }
    // The home owns the pack: a file both changed is the home's.
    if (changedHome) {
      pull.push({ path, text: home[path] ?? null });
      if (o !== undefined) next[path] = o;
      continue;
    }
    push.push({ path, text: here[path] ?? null });
    if (h !== undefined) next[path] = h;
  }
  return { push, pull, base: next };
};
