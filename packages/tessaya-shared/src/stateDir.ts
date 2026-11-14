// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const mtime = (path: string): number | null => {
  try {
    return NodeFS.statSync(path).mtimeMs;
  } catch {
    return null;
  }
};

/**
 * Where a file under the T3 state dir lives: `~/.t3/tessaya/<rel>` or the legacy `~/.t3/baton/<rel>`.
 * The newer copy wins, so a producer still writing the old path is never shadowed by a stale copy
 * (scripts/tessaya/state-migrate.sh copies, never deletes). With neither, the new path.
 */
export function stateFile(home: string, ...rel: string[]): string {
  const next = NodePath.join(home, ".t3", "tessaya", ...rel);
  const legacy = NodePath.join(home, ".t3", "baton", ...rel);
  const a = mtime(next);
  const b = mtime(legacy);
  return b !== null && (a === null || b > a) ? legacy : next;
}

/** A directory both sides must agree on (a queue): the new one only once it exists, else the legacy one while that exists. */
export function stateSubdir(home: string, ...rel: string[]): string {
  const next = NodePath.join(home, ".t3", "tessaya", ...rel);
  const legacy = NodePath.join(home, ".t3", "baton", ...rel);
  return mtime(next) === null && mtime(legacy) !== null ? legacy : next;
}
