/**
 * Problem reports and the developer feed (Director, 18 Nov). Pure: which log events the feed carries and how they are
 * redacted, which faults are worth a report, the dedupe and rate limit, and the lines she says. The server keeps the
 * queue (ProblemReports.ts); the action log is the one source, so every vessel feeds it the same way.
 */
import type {
  FeedEvent,
  HealthDiagnosis,
  ProblemBundle,
  ProblemReport,
} from "@t3tools/tessaya-contracts";

import type { ActionEnvelope, Finding } from "./provenance.ts";

/** The conversation's families: turns, the room loop, devices, the desk, phones, tools, personas and her health. */
const FEED_PREFIXES = [
  "turn",
  "room.",
  "device.",
  "desk.",
  "desktop.",
  "phone.",
  "tool",
  "mcp.",
  "persona",
  "voice.",
  "health.",
  "brain",
  "problem.",
] as const;
/** Keys that can hold what someone said or wrote; never carried, whatever their length. */
const WORDS_KEYS = new Set([
  "text",
  "words",
  "transcript",
  "prompt",
  "reply",
  "content",
  "message",
  "body",
  "query",
  "note",
  "summary",
]);
const SHORT = 60;

/** A number, a flag or a short enum; never a sentence, never a nested value (where words could hide). */
export const redactData = (data: unknown): Record<string, number | boolean | string> | null => {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return null;
  const out: Record<string, number | boolean | string> = {};
  for (const [k, v] of Object.entries(data)) {
    if (WORDS_KEYS.has(k)) continue;
    if (typeof v === "number" || typeof v === "boolean") out[k] = v;
    else if (typeof v === "string" && v.length <= SHORT && !/\s\S+\s/.test(v)) out[k] = v;
  }
  return Object.keys(out).length === 0 ? null : out;
};

const vesselOf = (e: ActionEnvelope): string | null => {
  const v = (e.data as { vessel?: unknown } | null)?.vessel;
  if (typeof v === "string") return v;
  return e.actor.kind === "device" ? (e.actor.id ?? null) : null;
};

/** The feed's view of one log event; null for a private one or one outside the conversation's families. */
export const feedEventOf = (e: ActionEnvelope): FeedEvent | null => {
  if (e.kind === "private" || !FEED_PREFIXES.some((p) => e.kind.startsWith(p))) return null;
  return {
    id: e.id,
    at: e.at,
    kind: e.kind,
    origin: e.origin,
    actor: e.actor.id === undefined ? e.actor.kind : `${e.actor.kind}:${e.actor.id}`,
    subject: e.subject.slice(0, SHORT * 2),
    outcome: e.outcome,
    vessel: vesselOf(e),
    data: redactData(e.data),
  };
};

/** A cause worth a report, with its evidence. */
export interface Fault {
  readonly key: string;
  readonly title: string;
  readonly guess: string;
  readonly vessel: string | null;
  readonly eventIds: ReadonlyArray<string>;
}

const REPORTED_RULES = new Set([
  "repeating_failure",
  "retry_storm",
  "owner_turn_unverified",
  "double_turn",
]);
const HEALTH_FAULT = /^(down|loop|brain|restart|stalls|memory|offline):/;

/**
 * The real faults in a beat: the log's bug rules (repeated failures, retry storms, two loops on one device, Voice ID
 * missing him), and a degraded health cause that also held the beat before (`heldBefore`), so a blip is never sent.
 */
export const faultsOf = (input: {
  readonly findings: ReadonlyArray<Finding>;
  readonly diagnosis: HealthDiagnosis | null;
  readonly heldBefore: ReadonlySet<string>;
}): ReadonlyArray<Fault> => [
  ...input.findings
    .filter((f) => REPORTED_RULES.has(f.rule))
    .map((f): Fault => ({
      key: f.key,
      title: f.title,
      guess:
        f.rule === "double_turn"
          ? "two voice loops are answering the same device, so every turn is answered twice"
          : f.rule === "owner_turn_unverified"
            ? "Voice ID scored him too low and held his turn as a guest's"
            : `the same step failed ${f.count} times within an hour; the events show where`,
      vessel:
        f.rule === "double_turn" || f.rule === "owner_turn_unverified"
          ? f.key.slice(f.rule.length + 1)
          : null,
      eventIds: f.eventIds,
    })),
  ...(input.diagnosis?.findings ?? [])
    .filter(
      (f) =>
        (f.severity === "degraded" || f.severity === "down") &&
        HEALTH_FAULT.test(f.key) &&
        input.heldBefore.has(f.key),
    )
    .map((f): Fault => ({
      key: `health:${f.key}`,
      title: f.says,
      guess: f.evidence[0] === undefined ? f.says : `${f.says}: ${f.evidence[0]}`,
      vessel: null,
      eventIds: [],
    })),
];

const DAY = 86_400_000;
const HOUR = 3_600_000;
/** At most this many reports she sends on her own, per hour and per day; one asked for always goes. */
export const PROACTIVE_PER_HOUR = 3;
export const PROACTIVE_PER_DAY = 10;

/** Whether a new report for `key` goes: not the same cause within a day, and her own within the rate limit. */
export const admit = (
  key: string,
  source: "asked" | "proactive",
  recent: ReadonlyArray<Pick<ProblemReport, "key" | "at" | "source" | "status">>,
  now: number,
): "ok" | "duplicate" | "rate-limited" => {
  const live = recent.filter((r) => r.status !== "deleted" && now - r.at < DAY);
  if (live.some((r) => r.key === key)) return "duplicate";
  if (source === "asked") return "ok";
  const own = live.filter((r) => r.source === "proactive");
  return own.length >= PROACTIVE_PER_DAY ||
    own.filter((r) => now - r.at < HOUR).length >= PROACTIVE_PER_HOUR
    ? "rate-limited"
    : "ok";
};

/** A key for what he asked her to report: the words, so asking twice about the same thing is one report. */
export const askedKey = (symptom: string, vessel: string | null) =>
  `asked:${vessel ?? ""}:${symptom
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .slice(0, 80)}`;

/** The one short line she says in developer mode when she sends one. */
export const reportLine = (title: string) => `I've sent the developers a report on ${title}.`;

const EVENTS_MAX = 40;

/** The bundle, trimmed: the newest events (oldest first in the bundle), each already redacted by `feedEventOf`. */
export const bundleOf = (
  input: Omit<ProblemBundle, "events"> & {
    readonly events: ReadonlyArray<FeedEvent>;
  },
): ProblemBundle => ({
  ...input,
  symptom: input.symptom.slice(0, 300),
  guess: input.guess.slice(0, 600),
  events: input.events.toSorted((a, b) => a.at - b.at).slice(-EVENTS_MAX),
});

/** A GitHub issue for a report: the title, then the bundle as plain sections. */
export const issueOf = (r: ProblemReport): { readonly title: string; readonly body: string } => {
  const b = r.bundle;
  const lines = [
    `Tessaya problem report \`${r.id}\` (${r.source === "asked" ? "asked for" : "found by her"}), from environment \`${r.origin}\`.`,
    "",
    `**Symptom:** ${b?.symptom ?? r.title}`,
    `**Her guess:** ${b?.guess ?? "none"}`,
    ...(b?.vessel === null || b === null ? [] : [`**Vessel:** ${b.vessel}`]),
    ...(b === null ? [] : [`**Versions:** server ${b.versions.server} on ${b.versions.host}`]),
    "",
    ...(b?.diagnosis === null || b === null
      ? []
      : [
          `**Diagnosis:** ${b.diagnosis.summary}`,
          ...b.diagnosis.findings.slice(0, 6).map((f) => `- ${f.severity}: ${f.says}`),
          "",
        ]),
    "<details><summary>Events</summary>",
    "",
    "```json",
    JSON.stringify(b?.events ?? [], null, 1).slice(0, 40_000),
    "```",
    "</details>",
  ];
  return { title: `[tessaya-report] ${r.title}`.slice(0, 200), body: lines.join("\n") };
};
