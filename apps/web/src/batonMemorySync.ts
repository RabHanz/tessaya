/** Where the window may send another server's memory-sync credential (MEMORY.md section 6). */
import { syncOriginAllowed } from "@t3tools/tessaya-shared/syncOrigin";

/**
 * That server's URL for `path`, keeping any base path a relay puts it under. Null when the credential must not go
 * there: plain http is refused unless it stays on this machine or the tailnet.
 */
export const syncPeerUrl = (base: string, path: string): URL | null => {
  const root = new URL(base.endsWith("/") ? base : `${base}/`);
  if (!syncOriginAllowed(root)) return null;
  return new URL(path.replace(/^\//, ""), root);
};

/** What a failed pairing or sync call means, in his words. */
export const syncFailureLine = (status: number): string =>
  status === 404 || status === 502
    ? `That server could not be reached through its relay (${status}). Try again when it is online.`
    : status === 401 || status === 403
      ? "That server no longer accepts this computer's sync credential. Pair it again."
      : "That code did not work. Make a new one on that machine and try again.";
