/**
 * "What needs me?" (Stage 5): one short ranked list across every source, read-only. Pure: each
 * adapter turns what a source reported into NeedItems, `rankNeeds` orders them, `describeNeeds`
 * says them. Nothing here sends, posts or spends; a source that cannot be read is named, not hidden.
 */
import type { TessayaJob, WatchFinding } from "@t3tools/tessaya-contracts";

import type { Approval } from "./approvals.ts";

export type NeedSource =
  | "approval"
  | "session"
  | "job"
  | "commitment"
  | "ledger"
  | "deadline"
  | "memory";

export interface NeedItem {
  readonly id: string;
  readonly source: NeedSource;
  readonly title: string;
  /** One plain clause: why it is on the list. */
  readonly why: string;
  /** How important it is on its own, 0 to 100. */
  readonly weight: number;
  /** Minutes it has been waiting, when known. */
  readonly waitingMinutes?: number;
  /** Epoch ms it is due, when it has a date. */
  readonly dueAt?: number;
  /** The id a tool needs to act on it (a job, a session). */
  readonly ref?: string;
}

const DAY = 86_400_000;

/** Importance plus urgency: a date that is near or past, and a wait that is long. */
export const needScore = (item: NeedItem, now: number): number => {
  let score = item.weight;
  if (item.dueAt !== undefined) {
    const left = item.dueAt - now;
    score += left < 0 ? 40 : left < DAY ? 30 : left < 3 * DAY ? 20 : left < 14 * DAY ? 10 : 0;
  }
  if (item.waitingMinutes !== undefined)
    score += Math.min(20, Math.floor(item.waitingMinutes / 30));
  return score;
};

export const rankNeeds = (
  items: ReadonlyArray<NeedItem>,
  now: number,
  /** Ids he has put off or told it to stop raising. */
  hidden: ReadonlySet<string> = new Set(),
): ReadonlyArray<NeedItem> => {
  const byId = new Map<string, NeedItem>();
  for (const item of items) {
    const kept = byId.get(item.id);
    if (kept === undefined || needScore(item, now) > needScore(kept, now)) byId.set(item.id, item);
  }
  return [...byId.values()]
    .filter((i) => !hidden.has(i.id))
    .toSorted((a, b) => needScore(b, now) - needScore(a, now) || a.id.localeCompare(b.id));
};

const WATCH_WEIGHT: Record<WatchFinding["kind"], number> = {
  failed: 80,
  unanswered: 75,
  limited: 70,
  stalled: 55,
  offline: 45,
  unseen: 45,
};
const WATCH_WHY: Record<WatchFinding["kind"], string> = {
  failed: "failed",
  unanswered: "is waiting for your answer",
  limited: "stopped, its account is out of room",
  stalled: "is working but has gone silent",
  offline: "is offline",
  unseen: "finished and nobody has looked at it",
};

const minutesText = (m: number): string => (m >= 120 ? `${Math.round(m / 60)} h` : `${m} min`);

/** Failed, stalled, waiting, and finished-but-unseen sessions, from the fleet's own state. */
export const needsFromFindings = (findings: ReadonlyArray<WatchFinding>): ReadonlyArray<NeedItem> =>
  findings.map((f) => ({
    id: `ws:${f.workSessionId}`,
    source: "session",
    title: f.title,
    why: `${WATCH_WHY[f.kind]}${f.minutes >= 1 ? ` (${minutesText(f.minutes)})` : ""}${f.lastDid === undefined ? "" : `. Last: ${f.lastDid}`}`,
    weight: WATCH_WEIGHT[f.kind],
    waitingMinutes: f.minutes,
    ref: f.workSessionId,
  }));

/** A job that ended and nobody has opened. Same id as the fleet's finding, so it is listed once. */
export const needsFromJobs = (
  jobs: ReadonlyArray<TessayaJob>,
  now: number,
  /** Finished this long ago and still unseen. */
  unseenAfterMinutes = 30,
): ReadonlyArray<NeedItem> =>
  jobs.flatMap((j): ReadonlyArray<NeedItem> => {
    const minutes = Math.max(0, Math.floor((now - Date.parse(j.lastActivityAt)) / 60_000));
    const make = (why: string, weight: number): NeedItem => ({
      id: `ws:${j.workSessionId}`,
      source: "job",
      title: j.title,
      why: `${why} (${minutesText(minutes)})`,
      weight,
      waitingMinutes: minutes,
      ref: j.workSessionId,
    });
    if (j.phase === "awaiting_agreement") return [make("its plan wants your OK", 70)];
    if (j.limitReached !== null) return [make(`hit its ${j.limitReached} limit`, 65)];
    if (j.group === "failed") return [make("failed", 80)];
    if (j.state === "done_unseen" && minutes >= unseenAfterMinutes) {
      return [make("finished and nobody has looked at it", 45)];
    }
    return [];
  });

export const needsFromApprovals = (items: ReadonlyArray<Approval>): ReadonlyArray<NeedItem> =>
  items.map((a) => ({
    id: a.kind === "plan" ? `ws:${a.ref}` : `s:${a.ref}`,
    source: "approval",
    title: a.title,
    why: a.action,
    weight: a.kind === "plan" ? 70 : 75,
    ref: a.ref,
  }));

export interface LedgerIssue {
  readonly repo: string;
  readonly number: number;
  readonly title: string;
  readonly labels: ReadonlyArray<string>;
  readonly updatedAt: string;
}

const LEDGER_WEIGHT: ReadonlyArray<readonly [string, number, string]> = [
  ["ledger:money-blocker", 85, "stands between today and revenue"],
  ["ledger:blocked-on-director", 70, "only you can do it"],
];

/** "due 2026-11-04" in a title is a date the row carries. */
export const dueInTitle = (title: string): number | undefined => {
  const m = /\bdue (\d{4}-\d{2}-\d{2})\b/i.exec(title);
  const ms = m === null ? NaN : Date.parse(`${m[1]}T23:59:59Z`);
  return Number.isNaN(ms) ? undefined : ms;
};

export const needsFromLedger = (issues: ReadonlyArray<LedgerIssue>): ReadonlyArray<NeedItem> =>
  issues.flatMap((i): ReadonlyArray<NeedItem> => {
    const hit = LEDGER_WEIGHT.filter(([label]) => i.labels.includes(label)).toSorted(
      (a, b) => b[1] - a[1],
    )[0];
    if (hit === undefined) return [];
    const due = dueInTitle(i.title);
    return [
      {
        id: `ledger:${i.repo}#${i.number}`,
        source: "ledger",
        title: i.title.replace(/^\[ledger\]\s*/i, ""),
        why: `${hit[2]} (${i.repo}#${i.number})`,
        weight: hit[1],
        ...(due === undefined ? {} : { dueAt: due }),
      },
    ];
  });

export interface DeadlineRow {
  readonly id: string;
  readonly what: string;
  readonly due?: string;
  readonly warnDays?: number;
}

/** Dated rows whose warning window has opened, or that are past. A row with no date is skipped. */
export const needsFromDeadlines = (
  rows: ReadonlyArray<DeadlineRow>,
  now: number,
  defaultWarnDays = 14,
): ReadonlyArray<NeedItem> =>
  rows.flatMap((r): ReadonlyArray<NeedItem> => {
    const due = r.due === undefined ? NaN : Date.parse(`${r.due}T23:59:59Z`);
    if (Number.isNaN(due) || due - now > (r.warnDays ?? defaultWarnDays) * DAY) return [];
    const days = Math.ceil((due - now) / DAY);
    return [
      {
        id: `deadline:${r.id}`,
        source: "deadline",
        title: r.what,
        why: days < 0 ? `${-days} days overdue` : days === 0 ? "due today" : `due in ${days} days`,
        weight: 60,
        dueAt: due,
      },
    ];
  });

/** A source that could not be read is said, so a short list is never mistaken for a clear one. */
export const describeNeeds = (
  ranked: ReadonlyArray<NeedItem>,
  unreadable: ReadonlyArray<string> = [],
  limit = 7,
): string => {
  const shown = ranked.slice(0, limit);
  const lines =
    shown.length === 0
      ? ["Nothing needs you in the sources I can read."]
      : shown.map(
          (n, i) => `${i + 1}. ${n.title}: ${n.why}${n.ref === undefined ? "" : ` [id: ${n.ref}]`}`,
        );
  if (ranked.length > shown.length)
    lines.push(`And ${ranked.length - shown.length} more, lower down.`);
  if (unreadable.length > 0) lines.push(`I could not read: ${unreadable.join(", ")}.`);
  return lines.join("\n");
};
