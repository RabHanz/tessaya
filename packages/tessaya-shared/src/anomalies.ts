/**
 * Things that are wrong without having failed (D149): a job far slower than its usual, the same
 * step failing again and again, a machine short of disk or memory. Pure; the desktop keeps the
 * tracker between ticks. Each anomaly is an initiative trigger, so the same policy limits it.
 */
import type { CiRun, Trigger } from "./initiative.ts";

export interface JobSeen {
  readonly id: string;
  readonly title: string;
  readonly group: "running" | "needs_you" | "done" | "failed";
}

export interface JobTrack {
  /** Jobs seen running: when they were first seen. */
  readonly running: Readonly<Record<string, { readonly title: string; readonly since: number }>>;
  /** How long finished runs of a job (by title key) took, in minutes, newest last. */
  readonly history: Readonly<Record<string, ReadonlyArray<number>>>;
  /** Consecutive failures per title key. */
  readonly streak: Readonly<Record<string, number>>;
}

export const EMPTY_TRACK: JobTrack = { running: {}, history: {}, streak: {} };

const HISTORY_KEEP = 10;
const KEY_MAX = 80;

/** A repeated job ("Nightly report 2026-11-01") is the same job: dates and numbers are dropped. */
export const titleKey = (title: string): string =>
  title
    .toLowerCase()
    .replace(/[\d:/_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, KEY_MAX);

export const trackJobs = (track: JobTrack, jobs: ReadonlyArray<JobSeen>, now: number): JobTrack => {
  const running: Record<string, { title: string; since: number }> = {};
  const history: Record<string, ReadonlyArray<number>> = { ...track.history };
  const streak: Record<string, number> = { ...track.streak };
  const byId = new Map(jobs.map((j) => [j.id, j]));
  for (const j of jobs) {
    if (j.group === "running")
      running[j.id] = track.running[j.id] ?? { title: j.title, since: now };
  }
  for (const [id, seen] of Object.entries(track.running)) {
    if (running[id] !== undefined) continue;
    const key = titleKey(seen.title);
    const now_ = byId.get(id);
    if (now_?.group === "done") {
      const minutes = Math.max(1, Math.round((now - seen.since) / 60_000));
      history[key] = [...(history[key] ?? []), minutes].slice(-HISTORY_KEEP);
      streak[key] = 0;
    } else if (now_?.group === "failed") {
      streak[key] = (streak[key] ?? 0) + 1;
    }
  }
  return { running, history, streak };
};

const median = (xs: ReadonlyArray<number>): number => {
  const s = xs.toSorted((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

export const SLOW_MIN_SAMPLES = 3;
export const STREAK_AT = 3;

const fmt = (minutes: number): string =>
  minutes >= 120 ? `${Math.round(minutes / 60)} hours` : `${Math.round(minutes)} minutes`;

export const anomalyFromJobs = (track: JobTrack, now: number): ReadonlyArray<Trigger> => {
  const out: Trigger[] = [];
  for (const [id, seen] of Object.entries(track.running)) {
    const samples = track.history[titleKey(seen.title)] ?? [];
    if (samples.length < SLOW_MIN_SAMPLES) continue;
    const usual = median(samples);
    const minutes = (now - seen.since) / 60_000;
    // Twice the usual and at least 15 minutes longer: a 2 minute job at 5 minutes is not news.
    if (minutes > usual * 2 && minutes - usual >= 15) {
      out.push({
        id: `slow:${id}`,
        kind: "job_slow",
        topic: `slow:${titleKey(seen.title)}`,
        title: seen.title,
        offer: `${seen.title} has run for ${fmt(minutes)}; it usually takes about ${fmt(usual)}. Want me to look?`,
        importance: 65,
        urgency: 55,
        yes: {
          kind: "job",
          goal: `The job "${seen.title}" has run for ${fmt(minutes)} where it usually takes about ${fmt(usual)}. Find out whether it is stuck and what to do. Read only; change nothing.`,
          sessionId: id,
        },
      });
    }
  }
  for (const [key, n] of Object.entries(track.streak)) {
    if (n < STREAK_AT) continue;
    out.push({
      id: `repeat:${key}:${n}`,
      kind: "step_repeating",
      topic: `repeat:${key}`,
      title: key,
      offer: `"${key}" has failed ${n} times in a row. Want me to look at why?`,
      importance: 85,
      urgency: 60,
      yes: {
        kind: "job",
        goal: `The job "${key}" has failed ${n} times in a row. Compare the failures, say what they share and the smallest fix. Read only; change nothing.`,
      },
    });
  }
  return out;
};

/** The same workflow failing on its last several runs: a broken step, not bad luck. */
export const anomalyFromCi = (runs: ReadonlyArray<CiRun>, now: number): ReadonlyArray<Trigger> => {
  const groups = new Map<string, CiRun[]>();
  for (const r of runs) {
    if (r.conclusion === "") continue;
    const key = `${r.repo}|${r.branch}|${r.name}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return [...groups.values()].flatMap((group): ReadonlyArray<Trigger> => {
    const sorted = group.toSorted((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    let n = 0;
    while (n < sorted.length && sorted[n]!.conclusion === "failure") n += 1;
    const newest = sorted[0]!;
    if (n < STREAK_AT || now - Date.parse(newest.createdAt) > 48 * 3_600_000) return [];
    return [
      {
        id: `cirepeat:${newest.repo}:${newest.name}:${newest.runId}`,
        kind: "step_repeating",
        topic: `ci:${newest.repo}`,
        title: `${newest.name} on ${newest.repo}`,
        offer: `The ${newest.name} build for ${newest.repo} (${newest.branch}) has failed ${n} times in a row. Want me to look at why?`,
        importance: 88,
        urgency: 60,
        yes: {
          kind: "job",
          repo: newest.repo,
          goal: `The "${newest.name}" workflow on ${newest.repo} (${newest.branch}) failed its last ${n} runs. Use gh run view --log-failed on the last two, say what they share and the smallest fix. Read only; change nothing.`,
        },
      },
    ];
  });
};

export interface Pressure {
  readonly freeDiskGb: number;
  readonly totalDiskGb: number;
  readonly freeMemPct: number;
}

export const DISK_LOW_GB = 5;
export const DISK_LOW_PCT = 8;
export const MEM_LOW_PCT = 6;

/** This machine only: the fleet carries no resource data from other boxes. */
export const anomalyFromPressure = (p: Pressure, box: string): ReadonlyArray<Trigger> => {
  const out: Trigger[] = [];
  const diskPct = p.totalDiskGb > 0 ? (p.freeDiskGb / p.totalDiskGb) * 100 : 100;
  if (p.freeDiskGb < DISK_LOW_GB || diskPct < DISK_LOW_PCT) {
    out.push({
      id: `pressure:disk:${box}`,
      kind: "pressure",
      topic: `pressure:disk:${box}`,
      title: `Disk space on ${box}`,
      offer: `${box} has ${p.freeDiskGb.toFixed(1)} GB of disk left. Want me to find what is taking the room?`,
      importance: 80,
      urgency: p.freeDiskGb < 1 ? 95 : 65,
      yes: {
        kind: "commitment",
        text: `Find what is using the disk on ${box} (${p.freeDiskGb.toFixed(1)} GB left)`,
      },
    });
  }
  if (p.freeMemPct < MEM_LOW_PCT) {
    out.push({
      id: `pressure:mem:${box}`,
      kind: "pressure",
      topic: `pressure:mem:${box}`,
      title: `Memory on ${box}`,
      offer: `${box} is down to ${p.freeMemPct.toFixed(0)}% free memory. Want me to note it to look at?`,
      importance: 70,
      urgency: 60,
      yes: { kind: "commitment", text: `Look at memory use on ${box}` },
    });
  }
  return out;
};
