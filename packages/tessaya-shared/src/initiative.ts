/* oxlint-disable t3code/no-low-value-comments -- Baton file predating the rule (D82) */
/**
 * When Tessaya speaks up (D149). Triggers come from the watch, jobs, CI, approvals and commitments;
 * a policy scores them (importance x urgency, less the cost of interrupting), then applies quiet
 * hours, an hourly budget, de-duplication, snooze and "stop telling me about X". The result is an
 * offer: a card with Yes, Later and Never. Pure. A Yes starts a job through the normal plan-first
 * path or notes a commitment; nothing here acts alone.
 */
import type { WatchFinding } from "@t3tools/tessaya-contracts";

import type { Commitment } from "./commitments.ts";
import { inQuietHours } from "./attention.ts";

export type TriggerKind =
  | "session_failed"
  | "session_stalled"
  | "session_waiting"
  | "session_finished"
  | "ci_failed"
  | "job_slow"
  | "step_repeating"
  | "pressure"
  | "commitment_due";

export interface Trigger {
  /** Stable for the same event, so the same failure is offered once. */
  readonly id: string;
  readonly kind: TriggerKind;
  /** What "stop telling me about X" means: a session, a repository, a kind of thing. */
  readonly topic: string;
  readonly title: string;
  /** The card's sentence, ending in the question. */
  readonly offer: string;
  /** 0 to 100. */
  readonly importance: number;
  /** 0 to 100. */
  readonly urgency: number;
  /** What Yes does. */
  readonly yes:
    | {
        readonly kind: "job";
        readonly goal: string;
        readonly sessionId?: string;
        readonly repo?: string;
      }
    | { readonly kind: "commitment"; readonly text: string }
    | { readonly kind: "done"; readonly commitmentId: string };
}

export interface Policy {
  readonly quietHours: string;
  readonly maxPerHour: number;
  /** Below this, it stays on the Now page and nothing pops up. */
  readonly minScore: number;
  /** How costly an interruption is right now, 0 to 40: typing hard, in a call, or fullscreen. */
  readonly interruptionCost: number;
  /** An offered id is not offered again for this long unless it was snoozed shorter. */
  readonly cooldownMs: number;
}

export const DEFAULT_POLICY: Policy = {
  quietHours: "22-8",
  maxPerHour: 3,
  minScore: 55,
  interruptionCost: 0,
  cooldownMs: 4 * 3_600_000,
};

export interface InitiativeState {
  /** id -> when it was last offered. */
  readonly offered: Readonly<Record<string, number>>;
  /** id -> do not offer again before this. */
  readonly snoozed: Readonly<Record<string, number>>;
  /** Topics he said to stop raising. */
  readonly never: ReadonlyArray<string>;
  /** When offers were made, for the hourly budget. */
  readonly recent: ReadonlyArray<number>;
  /** topic -> the last title offered under it, so "stop telling me about X" can find X. */
  readonly titles: Readonly<Record<string, string>>;
  /** Why something was held back, newest last, for the Now page ("what it declined and why"). */
  readonly declined: ReadonlyArray<{
    readonly at: number;
    readonly title: string;
    readonly why: string;
  }>;
}

export const EMPTY_INITIATIVE: InitiativeState = {
  offered: {},
  snoozed: {},
  never: [],
  recent: [],
  titles: {},
  declined: [],
};

const HOUR = 3_600_000;
const KEEP_DECLINED = 20;

export const triggerScore = (t: Trigger, policy: Policy): number =>
  Math.round(t.importance * 0.6 + t.urgency * 0.4 - policy.interruptionCost);

export type Held =
  | "quiet hours"
  | "below the bar"
  | "already offered"
  | "snoozed"
  | "you said stop"
  | "hourly budget";

export const decide = (
  triggers: ReadonlyArray<Trigger>,
  state: InitiativeState,
  policy: Policy,
  now: number,
  hour: number,
): { readonly offers: ReadonlyArray<Trigger>; readonly state: InitiativeState } => {
  const recent = state.recent.filter((t) => now - t < HOUR);
  const held: Array<{ t: Trigger; why: Held }> = [];
  const candidates: Trigger[] = [];
  const quiet = inQuietHours(policy.quietHours, hour);
  for (const t of triggers) {
    if (state.never.includes(t.topic)) held.push({ t, why: "you said stop" });
    else if ((state.snoozed[t.id] ?? 0) > now) held.push({ t, why: "snoozed" });
    else if (now - (state.offered[t.id] ?? -Infinity) < policy.cooldownMs)
      held.push({ t, why: "already offered" });
    else if (triggerScore(t, policy) < policy.minScore) held.push({ t, why: "below the bar" });
    else if (quiet) held.push({ t, why: "quiet hours" });
    else candidates.push(t);
  }
  const ranked = candidates.toSorted((a, b) => triggerScore(b, policy) - triggerScore(a, policy));
  const room = Math.max(0, policy.maxPerHour - recent.length);
  const offers = ranked.slice(0, room);
  for (const t of ranked.slice(room)) held.push({ t, why: "hourly budget" });
  // Held-back items that did not just repeat an earlier line are recorded once per id.
  const known = new Set(state.declined.map((d) => d.title));
  const declined = [
    ...state.declined,
    ...held
      .filter(({ t, why }) => why !== "already offered" && why !== "snoozed" && !known.has(t.title))
      .map(({ t, why }) => ({ at: now, title: t.title, why })),
  ].slice(-KEEP_DECLINED);
  return {
    offers,
    state: {
      ...state,
      offered: { ...state.offered, ...Object.fromEntries(offers.map((t) => [t.id, now])) },
      recent: [...recent, ...offers.map(() => now)],
      titles: { ...state.titles, ...Object.fromEntries(offers.map((t) => [t.topic, t.title])) },
      declined,
    },
  };
};

export type Answer = "yes" | "later" | "never";

export const LATER_MS = 2 * HOUR;

export const answerOffer = (
  state: InitiativeState,
  t: Trigger,
  answer: Answer,
  now: number,
): InitiativeState =>
  answer === "never"
    ? { ...state, never: [...new Set([...state.never, t.topic])] }
    : answer === "later"
      ? { ...state, snoozed: { ...state.snoozed, [t.id]: now + LATER_MS } }
      : state;

/** Lets him take "never" back, from the Now page or by voice. */
export const allowTopic = (state: InitiativeState, topic: string): InitiativeState => ({
  ...state,
  never: state.never.filter((x) => x !== topic),
});

const ago = (minutes: number): string =>
  minutes >= 120 ? `${Math.round(minutes / 60)} hours ago` : `${Math.max(1, minutes)} min ago`;

export const triggersFromFindings = (
  findings: ReadonlyArray<WatchFinding>,
): ReadonlyArray<Trigger> =>
  findings.flatMap((f): ReadonlyArray<Trigger> => {
    const base = { topic: `ws:${f.workSessionId}`, title: f.title };
    const look = (what: string) => ({
      kind: "job" as const,
      goal: `Find out ${what} for the session "${f.title}"${f.lastDid === undefined ? "" : ` (last did: ${f.lastDid})`} and say what to do about it. Read only; change nothing.`,
      sessionId: f.workSessionId,
    });
    switch (f.kind) {
      case "failed":
        return [
          {
            ...base,
            id: `fail:${f.workSessionId}`,
            kind: "session_failed",
            importance: 85,
            urgency: 60,
            offer: `${f.title} failed ${ago(f.minutes)}. Want me to look?`,
            yes: look("why it failed"),
          },
        ];
      case "stalled":
        return [
          {
            ...base,
            id: `stall:${f.workSessionId}`,
            kind: "session_stalled",
            importance: 60,
            urgency: 55,
            offer: `${f.title} has been silent for ${ago(f.minutes).replace(" ago", "")}. Want me to look?`,
            yes: look("whether it is stuck"),
          },
        ];
      case "unanswered":
        return [
          {
            ...base,
            id: `wait:${f.workSessionId}`,
            kind: "session_waiting",
            importance: 75,
            urgency: 50,
            offer: `${f.title} has been waiting for you ${ago(f.minutes).replace(" ago", "")}. Want me to look?`,
            yes: look("what it is asking"),
          },
        ];
      case "unseen":
        return [
          {
            ...base,
            id: `done:${f.workSessionId}`,
            kind: "session_finished",
            importance: 50,
            urgency: 30,
            offer: `${f.title} finished ${ago(f.minutes)} and nobody has looked. Want a summary?`,
            yes: look("what it did and how it ended"),
          },
        ];
      default:
        return [];
    }
  });

export interface CiRun {
  readonly repo: string;
  readonly runId: number;
  readonly name: string;
  readonly branch: string;
  readonly conclusion: string;
  readonly createdAt: string;
}

/** The newest run on each workflow and branch; one that failed in the last day is a trigger. */
export const triggersFromCi = (runs: ReadonlyArray<CiRun>, now: number): ReadonlyArray<Trigger> => {
  const newest = new Map<string, CiRun>();
  for (const r of runs.toSorted((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))) {
    const key = `${r.repo}/${r.branch}/${r.name}`;
    if (!newest.has(key)) newest.set(key, r);
  }
  return [...newest.values()].flatMap((r): ReadonlyArray<Trigger> => {
    const minutes = Math.floor((now - Date.parse(r.createdAt)) / 60_000);
    if (r.conclusion !== "failure" || minutes > 24 * 60 || Number.isNaN(minutes)) return [];
    return [
      {
        id: `ci:${r.repo}:${r.runId}`,
        kind: "ci_failed",
        topic: `ci:${r.repo}`,
        title: `${r.name} on ${r.repo}`,
        offer: `The ${r.name} build for ${r.repo} (${r.branch}) failed ${ago(minutes)}. Want me to look?`,
        importance: r.branch === "main" || r.branch === "master" ? 80 : 55,
        urgency: 55,
        yes: {
          kind: "job",
          repo: r.repo,
          goal: `Look at the failed "${r.name}" run ${r.runId} on ${r.repo} (${r.branch}) with gh run view --log-failed, say why it failed and what the smallest fix is. Read only; change nothing.`,
        },
      },
    ];
  });
};

export const triggersFromCommitments = (
  list: ReadonlyArray<Commitment>,
  now: number,
): ReadonlyArray<Trigger> =>
  list.flatMap((c): ReadonlyArray<Trigger> =>
    c.status === "open" && c.due !== null && c.due <= now
      ? [
          {
            id: `commit:${c.id}`,
            kind: "commitment_due",
            topic: `commit:${c.id}`,
            title: c.text,
            offer: `You asked me to keep track of "${c.text}" and it is due. Done with it?`,
            importance: 70,
            urgency: 75,
            yes: { kind: "done", commitmentId: c.id },
          },
        ]
      : [],
  );

/** Topics whose last title, or whose id, contains the words he gave. */
export const topicsMatching = (state: InitiativeState, words: string): ReadonlyArray<string> => {
  const w = words.trim().toLowerCase();
  if (w === "") return [];
  return Object.entries(state.titles)
    .filter(([topic, title]) => title.toLowerCase().includes(w) || topic.toLowerCase().includes(w))
    .map(([topic]) => topic);
};

/** "Stop telling me about X": every topic that matches goes quiet. Returns what it silenced. */
export const stopAbout = (
  state: InitiativeState,
  words: string,
): { readonly state: InitiativeState; readonly stopped: ReadonlyArray<string> } => {
  const hits = topicsMatching(state, words);
  return {
    state: { ...state, never: [...new Set([...state.never, ...hits])] },
    stopped: hits.map((t) => state.titles[t] ?? t),
  };
};

export const resumeAbout = (
  state: InitiativeState,
  words: string,
): { readonly state: InitiativeState; readonly resumed: ReadonlyArray<string> } => {
  const w = words.trim().toLowerCase();
  const hits = state.never.filter(
    (t) => t.toLowerCase().includes(w) || (state.titles[t] ?? "").toLowerCase().includes(w),
  );
  return {
    state: { ...state, never: state.never.filter((t) => !hits.includes(t)) },
    resumed: hits.map((t) => state.titles[t] ?? t),
  };
};
