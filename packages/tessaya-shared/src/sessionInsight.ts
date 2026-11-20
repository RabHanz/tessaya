/**
 * Session insight (M-104): which of his sessions he means, what of it a model may read, and the line his steering
 * goes with. Pure, so the server and its tests share it.
 */
import type { TessayaSessionSummary } from "@t3tools/tessaya-contracts";

import { redactSecretLines, sharesPrivateText } from "./memory.ts";

const words = (text: string): ReadonlyArray<string> =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !FILLER.has(w));
const FILLER = new Set(["the", "session", "my", "on", "pr", "a", "an", "of", "for", "one"]);
const RANK: Readonly<Record<string, number>> = { waiting: 0, working: 1, idle: 2 };

/** The session he means: its key, or the most words of its name and project, then the liveliest and newest. */
export const pickSession = (
  rows: ReadonlyArray<TessayaSessionSummary>,
  said: string,
): TessayaSessionSummary | null => {
  const exact = rows.find((r) => r.key === said.trim());
  if (exact !== undefined) return exact;
  const asked = words(said);
  if (asked.length === 0) return null;
  const scored = rows
    .map((row) => {
      const own = new Set(words(`${row.session} ${row.project}`));
      return { row, hits: asked.filter((w) => own.has(w)).length };
    })
    .filter((s) => s.hits > 0)
    .toSorted(
      (a, b) =>
        b.hits - a.hits ||
        (RANK[a.row.state] ?? 3) - (RANK[b.row.state] ?? 3) ||
        (b.row.updatedAt ?? "").localeCompare(a.row.updatedAt ?? ""),
    );
  return scored[0]?.row ?? null;
};

const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;

/** The pull requests a session's words name, newest mention first, at most three. */
export const prUrlsIn = (text: string): ReadonlyArray<string> =>
  [...new Set((text.match(PR_URL) ?? []).toReversed())].slice(0, 3);

/** What a model may read of a session: secrets marked, private pack text left out, the newest part kept. */
export const readableExcerpt = (
  parts: ReadonlyArray<string>,
  privateTexts: ReadonlyArray<string>,
  max = 12_000,
): string => {
  const kept = parts
    .map(redactSecretLines)
    .filter((p) => p.trim() !== "" && !sharesPrivateText(p, privateTexts));
  const text = kept.join("\n\n");
  return text.length <= max ? text : text.slice(text.length - max);
};

/** His words as the session reads them: from him, through her, never mistaken for the session's own user typing. */
export const steerText = (owner: string, text: string): string =>
  `From ${owner}, via Tessaya: ${text.trim()}`;

export interface GhPr {
  readonly state?: string;
  readonly reviewDecision?: string | null;
  readonly mergeStateStatus?: string;
  readonly statusCheckRollup?: ReadonlyArray<{
    readonly conclusion?: string | null;
    readonly state?: string | null;
    readonly status?: string | null;
  }> | null;
}

/** `gh pr view --json state,reviewDecision,mergeStateStatus,statusCheckRollup` as one line. */
export const prLine = (pr: GhPr): string => {
  const checks = pr.statusCheckRollup ?? [];
  const outcome = (c: NonNullable<GhPr["statusCheckRollup"]>[number]) =>
    (c.conclusion ?? c.state ?? c.status ?? "").toUpperCase();
  const failing = checks.filter((c) =>
    ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED"].includes(outcome(c)),
  ).length;
  const pending = checks.filter((c) =>
    ["", "PENDING", "QUEUED", "IN_PROGRESS", "EXPECTED"].includes(outcome(c)),
  ).length;
  const state = (pr.state ?? "unknown").toLowerCase();
  if (state !== "open") return state;
  const checkText =
    checks.length === 0
      ? "no checks"
      : failing > 0
        ? `${failing} check${failing === 1 ? "" : "s"} failing`
        : pending > 0
          ? `${pending} check${pending === 1 ? "" : "s"} running`
          : "checks green";
  const review =
    pr.reviewDecision === "APPROVED"
      ? "approved"
      : pr.reviewDecision === "CHANGES_REQUESTED"
        ? "changes requested"
        : "no review yet";
  const merge =
    pr.mergeStateStatus === "CLEAN"
      ? "ready to merge"
      : pr.mergeStateStatus === "DIRTY"
        ? "has conflicts"
        : pr.mergeStateStatus === "BLOCKED"
          ? "blocked from merging"
          : "merge state still being worked out";
  return `open, ${checkText}, ${review}, ${merge}`;
};
