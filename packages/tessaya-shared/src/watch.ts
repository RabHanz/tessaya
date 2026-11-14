/**
 * Session monitoring (D146): which sessions have been left alone when they should not be. Pure and
 * read from state the server already holds (the fleet's derived state and timestamps), never a
 * model's guess: a session is failed because its state says so, stalled because it says "working"
 * and nothing has happened for a long time.
 */
import { freshFindings } from "./attention.ts";
import {
  WorkSessionId,
  type BatonFleetEntry,
  type BatonRecordEntry,
  type ClaudeLiveSession,
  type WatchFinding,
} from "@t3tools/tessaya-contracts";

export const WATCH_LIMITS = {
  /** Working, and no activity at all for this long. */
  stalledMinutes: 30,
  /** Waiting for his answer for this long. */
  unansweredMinutes: 30,
  /** Finished and never looked at for this long. */
  unseenMinutes: 60,
} as const;

const SEVERITY: Record<WatchFinding["kind"], number> = {
  failed: 0,
  limited: 1,
  offline: 2,
  stalled: 3,
  unanswered: 4,
  unseen: 5,
};

const lastActivity = (entry: BatonFleetEntry): number => {
  const times = [entry.updatedAt, ...entry.threads.map((t) => t.lastActivityAt)].flatMap((t) => {
    const ms = t === null ? NaN : Date.parse(t);
    return Number.isNaN(ms) ? [] : [ms];
  });
  return Math.max(0, ...times);
};

export const watchFleet = (
  entries: ReadonlyArray<BatonFleetEntry>,
  now: number,
  limits: typeof WATCH_LIMITS = WATCH_LIMITS,
): ReadonlyArray<WatchFinding> =>
  entries
    .flatMap((entry): ReadonlyArray<WatchFinding> => {
      if (entry.lifecycle !== "active") return [];
      const since = lastActivity(entry);
      const minutes = since === 0 ? 0 : Math.max(0, Math.floor((now - since) / 60_000));
      const said = entry.synopsis?.currentAction ?? entry.synopsis?.recentFindings[0]?.text ?? "";
      const make = (kind: WatchFinding["kind"]): ReadonlyArray<WatchFinding> => [
        {
          workSessionId: entry.workSessionId,
          title: entry.title,
          kind,
          minutes,
          ...(said === "" ? {} : { lastDid: said.slice(0, 200) }),
        },
      ];
      switch (entry.state) {
        case "failed":
        case "limited":
        case "offline":
          return make(entry.state);
        case "working":
        case "starting":
        case "monitoring":
          return minutes >= limits.stalledMinutes ? make("stalled") : [];
        case "needs_approval":
        case "needs_input":
          return minutes >= limits.unansweredMinutes ? make("unanswered") : [];
        case "done_unseen":
          return minutes >= limits.unseenMinutes ? make("unseen") : [];
        case "idle":
          return [];
      }
    })
    .toSorted((a, b) => SEVERITY[a.kind] - SEVERITY[b.kind] || b.minutes - a.minutes);

/** What the auto-resume watchdog did about a session that died mid-turn. */
export interface WatchdogOutcome {
  readonly sessionId: string;
  readonly title: string;
  readonly resumed: boolean;
  /** Why it was not resumed, in words; absent when it was. */
  readonly why?: string;
  readonly at: number;
}

/** Outcomes are reported for this long, so "did anything fail overnight" still sees them in the morning. */
export const OUTCOME_MEMORY_MS = 12 * 3_600_000;

const RESUMED = "died mid-turn, resumed";
const NOT_RESUMED = "died mid-turn, not resumed";

/** An outcome as a Record row, so the watch still has it after the server restarts. */
export const outcomeRecord = (o: Omit<WatchdogOutcome, "at">) => ({
  kind: "session",
  subject: o.title,
  outcome: o.resumed ? RESUMED : NOT_RESUMED,
  detail: o.why ?? "",
});

/** The outcomes the Record holds; any other row is ignored. */
export const outcomesFromRecord = (
  rows: ReadonlyArray<BatonRecordEntry>,
): ReadonlyArray<WatchdogOutcome> =>
  rows.flatMap((r): ReadonlyArray<WatchdogOutcome> => {
    const at = Date.parse(r.at);
    if (r.kind !== "session" || r.ref === null || Number.isNaN(at)) return [];
    if (r.outcome !== RESUMED && r.outcome !== NOT_RESUMED) return [];
    const resumed = r.outcome === RESUMED;
    return [
      {
        sessionId: r.ref,
        title: r.subject,
        resumed,
        ...(resumed || r.detail === "" ? {} : { why: r.detail }),
        at,
      },
    ];
  });

/** A finding the server's own watch noticed, as a Record row (D1): kept with no desktop up, read by the morning brief. */
export const findingRecord = (f: WatchFinding) => ({
  kind: "watch",
  actor: "watch",
  ref: f.workSessionId,
  subject: f.title,
  outcome: f.kind,
  detail: f.lastDid ?? "",
});

/** The same finding of the same session is written at most this often, so one that flaps does not fill the Record. */
const RECORD_EVERY_MS = 6 * 3_600_000;
/** An account out of room is the account pool's to report. */
const RECORDED: ReadonlySet<string> = new Set(["failed", "stalled", "unanswered"]);
const keyOf = (ref: string | null, kind: string) => `${ref}:${kind}`;

export interface WatchRecordState {
  /** What stands now, so it is not written again while it stands. */
  readonly noted: ReadonlySet<string>;
  /** When each session's finding was last written. */
  readonly written: ReadonlyMap<string, number>;
}

/** From the Record's `watch` rows, newest first: each session's newest row stood when the server stopped, whatever its age. */
export const watchRecordStart = (rows: ReadonlyArray<BatonRecordEntry>): WatchRecordState => {
  const written = new Map<string, number>();
  const newest = new Map<string | null, string>();
  for (const r of rows) {
    if (r.kind !== "watch") continue;
    const key = keyOf(r.ref, r.outcome);
    if (!written.has(key)) written.set(key, Date.parse(r.at));
    if (!newest.has(r.ref)) newest.set(r.ref, key);
  }
  return { noted: new Set(newest.values()), written };
};

/** The findings to write now, and the state once they are written. */
export const watchRecordStep = (
  found: ReadonlyArray<WatchFinding>,
  state: WatchRecordState,
  now: number,
): { readonly write: ReadonlyArray<WatchFinding>; readonly next: WatchRecordState } => {
  const { fresh, next } = freshFindings(found, state.noted);
  const written = new Map(state.written);
  const write = fresh.filter((f) => {
    const key = keyOf(f.workSessionId, f.kind);
    if (!RECORDED.has(f.kind) || now - (written.get(key) ?? -Infinity) < RECORD_EVERY_MS)
      return false;
    written.set(key, now);
    return true;
  });
  return { write, next: { noted: next, written } };
};

const KEPT_KINDS: ReadonlySet<string> = new Set(["failed", "stalled"]);

/** The failures and stalls the watch recorded, as findings again, though they have since cleared; any other row is ignored. */
export const findingsFromRecord = (
  rows: ReadonlyArray<BatonRecordEntry>,
): ReadonlyArray<WatchFinding> =>
  rows.flatMap((r): ReadonlyArray<WatchFinding> =>
    r.kind !== "watch" || r.ref === null || !KEPT_KINDS.has(r.outcome)
      ? []
      : [
          {
            workSessionId: WorkSessionId.make(r.ref),
            title: r.subject,
            kind: r.outcome as WatchFinding["kind"],
            minutes: 0,
            ...(r.detail === "" ? {} : { lastDid: r.detail }),
          },
        ],
  );

/**
 * His terminal sessions, which are not work sessions: one waiting on him too long, and what the watchdog did
 * about one that died (resumed, or why not). The session id stands where a work session's id would.
 */
export const watchLiveSessions = (
  sessions: ReadonlyArray<
    Pick<ClaudeLiveSession, "sessionId" | "name" | "cwd" | "status" | "updatedAt">
  >,
  outcomes: ReadonlyArray<WatchdogOutcome>,
  now: number,
  limits: typeof WATCH_LIMITS = WATCH_LIMITS,
): ReadonlyArray<WatchFinding> => {
  const minutesSince = (at: number) => Math.max(0, Math.floor((now - at) / 60_000));
  const waiting = sessions.flatMap((s): ReadonlyArray<WatchFinding> => {
    const at = Date.parse(s.updatedAt ?? "");
    if (s.status !== "waiting" || Number.isNaN(at)) return [];
    const minutes = minutesSince(at);
    return minutes < limits.unansweredMinutes
      ? []
      : [
          {
            workSessionId: WorkSessionId.make(s.sessionId),
            title:
              (s.name ?? "").trim() || s.cwd.split(/[\\/]/).filter(Boolean).at(-1) || s.sessionId,
            kind: "unanswered",
            minutes,
          },
        ];
  });
  // The newest outcome per session: a later resume replaces an earlier "not resumed".
  const latest = new Map<string, WatchdogOutcome>();
  for (const o of outcomes) {
    if (now - o.at <= OUTCOME_MEMORY_MS && (latest.get(o.sessionId)?.at ?? -1) <= o.at)
      latest.set(o.sessionId, o);
  }
  const live = new Set(sessions.map((s) => s.sessionId));
  const died = [...latest.values()].flatMap((o): ReadonlyArray<WatchFinding> =>
    // A session not resumed that is running again was brought back some other way.
    !o.resumed && live.has(o.sessionId)
      ? []
      : [
          {
            workSessionId: WorkSessionId.make(o.sessionId),
            title: o.title.trim() || o.sessionId,
            // "unseen", not a new kind: an older client fails to decode the whole answer on a literal it lacks.
            kind: o.resumed ? "unseen" : "failed",
            minutes: minutesSince(o.at),
            lastDid: o.resumed
              ? "resumed by itself after dying mid-turn"
              : `died mid-turn, not resumed: ${o.why ?? "unknown"}`,
          },
        ],
  );
  return [...waiting, ...died].toSorted(
    (a, b) => SEVERITY[a.kind] - SEVERITY[b.kind] || b.minutes - a.minutes,
  );
};

const WORDS: Record<WatchFinding["kind"], string> = {
  failed: "failed",
  limited: "stopped, its account is out of room",
  offline: "is offline",
  stalled: "looks stalled",
  unanswered: "has been waiting for you",
  unseen: "finished and has not been looked at",
};

export const describeWatch = (findings: ReadonlyArray<WatchFinding>): string =>
  findings.length === 0
    ? "Nothing is being left alone."
    : findings
        .map(
          (f) =>
            `${f.title} ${WORDS[f.kind]}${f.minutes >= 1 ? ` (${f.minutes >= 120 ? `${Math.round(f.minutes / 60)} h` : `${f.minutes} min`})` : ""}${f.lastDid === undefined ? "" : `. Last: ${f.lastDid}`} [id: ${f.workSessionId}]`,
        )
        .join("\n");
