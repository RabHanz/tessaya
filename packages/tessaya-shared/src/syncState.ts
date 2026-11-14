/**
 * Where the upstream sync stands, for the Now page: how far behind (counted in the repo checkout when
 * there is one, else the number the last run wrote), when the last run was and how it ended, and the
 * open sync pull request with its checks. A run that has not happened for a day, one that stopped,
 * or a sync PR whose checks failed is something that needs him. Pure.
 */
import type { SyncStatus } from "./nightly.ts";
import type { NeedItem } from "./needsMe.ts";

export type ChecksState = "pass" | "fail" | "pending" | "none";

export interface SyncPr {
  readonly number: number;
  readonly url: string;
  readonly title: string;
  readonly checks: ChecksState;
}

export interface SyncState {
  /** `git rev-list --count <PIN>..upstream/main` in the repo checkout; null when there is none here. */
  readonly localBehind: number | null;
  readonly status: SyncStatus | null;
  readonly pr: SyncPr | null;
}

export const SYNC_STALL_MS = 24 * 3_600_000;

/** One word from a pull request's check rollup (GitHub's statusCheckRollup, checks and statuses alike). */
export const summariseChecks = (
  rollup: ReadonlyArray<{
    readonly conclusion?: string | null;
    readonly status?: string | null;
    readonly state?: string | null;
  }>,
): ChecksState => {
  if (rollup.length === 0) return "none";
  const failed = (c: (typeof rollup)[number]) =>
    ["FAILURE", "TIMED_OUT", "CANCELLED", "ERROR", "STARTUP_FAILURE", "ACTION_REQUIRED"].includes(
      (c.conclusion ?? c.state ?? "").toUpperCase(),
    );
  if (rollup.some(failed)) return "fail";
  const done = (c: (typeof rollup)[number]) =>
    ["SUCCESS", "NEUTRAL", "SKIPPED"].includes((c.conclusion ?? c.state ?? "").toUpperCase());
  return rollup.every(done) ? "pass" : "pending";
};

const ago = (ms: number): string => {
  const m = Math.max(0, Math.round(ms / 60_000));
  return m < 1
    ? "just now"
    : m < 120
      ? `${m} min ago`
      : m < 2880
        ? `${Math.round(m / 60)} h ago`
        : `${Math.round(m / 1440)} days ago`;
};

const behindOf = (s: SyncState): number | null => s.localBehind ?? s.status?.behindCommits ?? null;

const CHECK_WORDS: Readonly<Record<ChecksState, string>> = {
  pass: "all green",
  fail: "failing",
  pending: "still running",
  none: "none yet",
};

/** The 'what needs me' rows: a stall of more than a day, a stopped run, and a sync PR that is failing. */
export const syncNeeds = (s: SyncState, now: number): ReadonlyArray<NeedItem> => {
  const out: NeedItem[] = [];
  if (s.status !== null) {
    const age = now - Date.parse(s.status.at);
    if (Number.isFinite(age) && age > SYNC_STALL_MS) {
      out.push({
        id: "sync:stalled",
        source: "ledger",
        title: "The upstream sync has not run",
        why: `The last run was ${ago(age)}; it should run every night${behindOf(s) === null ? "" : `, and Tessaya is ${behindOf(s)} commits behind upstream`}.`,
        weight: 85,
        waitingMinutes: Math.round(age / 60_000),
      });
    } else if (!s.status.ok) {
      const files = s.status.conflictingFiles.slice(0, 3).join(", ");
      out.push({
        id: "sync:stopped",
        source: "ledger",
        title: "The upstream sync stopped",
        why: `The last run (${ago(age)}) ended: ${s.status.result}${files === "" ? "" : `, on ${files}`}.`,
        weight: 80,
      });
    }
  }
  if (s.pr !== null && s.pr.checks === "fail") {
    out.push({
      id: `sync:pr:${s.pr.number}`,
      source: "ledger",
      title: `The sync pull request #${s.pr.number} has failing checks`,
      why: s.pr.title,
      weight: 75,
    });
  }
  return out;
};

/** The 'what works right now' row. */
export const syncCapability = (
  s: SyncState,
  now: number,
): {
  readonly name: string;
  readonly state: "works" | "limited" | "unknown";
  readonly why: string;
} => {
  const name = "Upstream sync";
  if (s.status === null && s.localBehind === null && s.pr === null) {
    return { name, state: "unknown", why: "Unknown: the last sync result could not be read here." };
  }
  const behind = behindOf(s);
  const parts = [
    behind === null
      ? "Commits behind upstream: unknown."
      : `${behind} commits behind upstream${s.localBehind === null ? " (as of the last run)" : ""}.`,
    s.status === null
      ? "The last run could not be read."
      : `The last run was ${ago(now - Date.parse(s.status.at))}: ${s.status.result}.`,
    ...(s.pr === null ? [] : [`Sync PR #${s.pr.number}: checks ${CHECK_WORDS[s.pr.checks]}.`]),
  ];
  const bad = syncNeeds(s, now).length > 0;
  return { name, state: bad ? "limited" : "works", why: parts.join(" ") };
};
