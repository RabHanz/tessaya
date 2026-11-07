/**
 * What Tessaya says without being asked (D146): a line when something first needs him, only
 * outside his quiet hours, and a morning brief. Pure: it takes what the watch and the jobs report.
 */
import type { BatonJob, BatonRecordEntry, WatchFinding } from "@t3tools/baton-contracts";

/** Only these are worth interrupting for; "unseen" is left for the morning brief. */
const INTERRUPTING: ReadonlySet<WatchFinding["kind"]> = new Set([
  "failed",
  "limited",
  "unanswered",
  "stalled",
]);

const key = (f: WatchFinding): string => `${f.workSessionId}:${f.kind}`;

/** Nothing unprompted is said or offered: quiet hours, Do not disturb, or a snooze still running. */
export const isSilenced = (
  s: {
    readonly quietHours: string;
    readonly doNotDisturb?: boolean;
    readonly snoozeUntil?: number;
  },
  now: Date,
): boolean =>
  s.doNotDisturb === true ||
  (s.snoozeUntil ?? 0) > now.getTime() ||
  inQuietHours(s.quietHours, now.getHours());

/** "22-8" is 22:00 to 08:00 and wraps midnight; "none" is never quiet. */
export const inQuietHours = (spec: string, hour: number): boolean => {
  const m = /^(\d{1,2})-(\d{1,2})$/.exec(spec);
  if (m === null) return false;
  const from = Number(m[1]);
  const to = Number(m[2]);
  return from === to ? false : from < to ? hour >= from && hour < to : hour >= from || hour < to;
};

/**
 * The findings not yet announced, and the set to remember. A finding that clears and comes back is
 * announced again; one still standing is not repeated.
 */
export const freshFindings = (
  found: ReadonlyArray<WatchFinding>,
  announced: ReadonlySet<string>,
): { readonly fresh: ReadonlyArray<WatchFinding>; readonly next: ReadonlySet<string> } => {
  const interrupting = found.filter((f) => INTERRUPTING.has(f.kind));
  return {
    fresh: interrupting.filter((f) => !announced.has(key(f))),
    next: new Set(interrupting.map(key)),
  };
};

const VERB: Record<WatchFinding["kind"], string> = {
  failed: "failed",
  limited: "stopped, its account is out of room",
  offline: "is offline",
  stalled: "looks stalled",
  unanswered: "is waiting for you",
  unseen: "finished",
};

/**
 * A job whose plan is written and waits for his yes: said once, briefly, pointing at its thread. `told` is the
 * set already said; a plan that is agreed or rewritten and ready again is said again.
 */
export const planReadyLine = (
  jobs: ReadonlyArray<Pick<BatonJob, "workSessionId" | "title" | "phase">>,
  told: ReadonlySet<string>,
): { readonly line: string | null; readonly next: ReadonlySet<string> } => {
  const ready = jobs.filter((j) => j.phase === "awaiting_agreement");
  const fresh = ready.filter((j) => !told.has(j.workSessionId));
  const first = fresh[0];
  return {
    line:
      first === undefined
        ? null
        : `The plan for ${first.title} is ready in its thread${fresh.length > 1 ? `, and ${fresh.length - 1} more plans wait for you` : ""}.`,
    next: new Set(ready.map((j) => j.workSessionId)),
  };
};

/** One line, whatever the number: the first, and how many more. */
export const noticeLine = (fresh: ReadonlyArray<WatchFinding>): string | null => {
  const first = fresh[0];
  if (first === undefined) return null;
  const more = fresh.length - 1;
  return `${first.title} ${VERB[first.kind]}${more > 0 ? `, and ${more} more need a look` : ""}.`;
};

/** What happened in the last day, from the job cards and the watch. Plain sentences, nothing invented. */
export const morningBrief = (input: {
  readonly jobs: ReadonlyArray<BatonJob>;
  readonly findings: ReadonlyArray<WatchFinding>;
  readonly now: number;
  /** Further plain sentences, such as the commitments due. */
  readonly extra?: ReadonlyArray<string>;
  /** The Record's `background_turns` notes: who passed the day's guide. Never a stop. */
  readonly guide?: ReadonlyArray<BatonRecordEntry>;
}): string => {
  const day = 24 * 3_600_000;
  const recent = input.jobs.filter((j) => input.now - Date.parse(j.lastActivityAt) <= day);
  const names = (group: BatonJob["group"], within: ReadonlyArray<BatonJob> = recent) =>
    within.filter((j) => j.group === group).map((j) => j.title);
  const list = (items: ReadonlyArray<string>) =>
    items.slice(0, 3).join(", ") + (items.length > 3 ? ` and ${items.length - 3} more` : "");
  const parts: string[] = [];
  const done = names("done");
  if (done.length > 0) parts.push(`Finished: ${list(done)}.`);
  const failed = [
    ...names("failed"),
    ...input.findings.filter((f) => f.kind === "failed").map((f) => f.title),
  ];
  if (failed.length > 0) parts.push(`Failed: ${list([...new Set(failed)])}.`);
  const waiting = [
    ...names("needs_you", input.jobs),
    ...input.findings.filter((f) => f.kind === "unanswered").map((f) => f.title),
  ];
  if (waiting.length > 0) parts.push(`Waiting for you: ${list([...new Set(waiting)])}.`);
  const running = names("running", input.jobs);
  if (running.length > 0) parts.push(`Still running: ${list(running)}.`);
  const stuck = input.findings.filter((f) => f.kind === "stalled").map((f) => f.title);
  if (stuck.length > 0) parts.push(`Looks stalled: ${list([...new Set(stuck)])}.`);
  const guide = (input.guide ?? [])
    .filter((e) => e.kind === "background_turns" && input.now - Date.parse(e.at) <= day)
    .map((e) =>
      `${e.actor === "team" ? "the team" : e.actor} ${/\d+/.exec(e.subject)?.[0] ?? ""}`.trim(),
    );
  if (guide.length > 0)
    parts.push(
      `Past the daily guide for background turns: ${list([...new Set(guide)])}. Nothing was stopped.`,
    );
  parts.push(...(input.extra ?? []));
  return parts.length === 0
    ? "Good morning. Nothing happened overnight and nothing is waiting."
    : `Good morning. ${parts.join(" ")}`;
};
