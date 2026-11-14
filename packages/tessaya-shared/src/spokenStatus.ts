/* oxlint-disable t3code/no-em-dash-copy, t3code/no-low-value-comments -- Baton file predating upstream's rule (D82) */
/**
 * Spoken status — the §20 "Jarvis" answers, as a pure function.
 *
 * The specification's rule: **answer from state and synopsis before
 * interrupting a provider session.** Nothing here asks an agent anything. It
 * turns the fleet the environment already reported into a sentence a person
 * can hear while walking away from the desk.
 *
 * Phase 5 wires a microphone to this; it is a pure function today so the
 * wording can be tested, reviewed and changed without a voice pipeline, and so
 * the same sentences can appear as text in the UI.
 *
 * Style rules, from the examples in §20:
 *   - name the account and what it is doing, not the thread id;
 *   - say whether the user is needed, because that is the question behind the
 *     question;
 *   - never invent a number or a result — every clause comes from a field.
 *
 * @module batonSpokenStatus
 */
import {
  BATON_STATE_LABELS,
  batonStateNeedsUser,
  isSynopsisStale,
  type BatonSessionState,
  type WorkSessionSynopsis,
} from "@t3tools/tessaya-contracts";

export interface SpokenWorkSession {
  readonly title: string;
  readonly projectLabel: string | null;
  readonly state: BatonSessionState;
  /** The account currently running it, as the user names it. */
  readonly providerLabel: string | null;
  readonly hostLabel: string | null;
  readonly synopsis: WorkSessionSynopsis | null;
}

const sentence = (parts: ReadonlyArray<string | null>): string =>
  parts
    .filter((part): part is string => part !== null && part.trim().length > 0)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

const withStop = (text: string): string =>
  text.length === 0 ? text : /[.!?]$/.test(text) ? text : `${text}.`;

const subject = (workSession: SpokenWorkSession): string =>
  workSession.providerLabel ?? workSession.projectLabel ?? workSession.title;

/**
 * "What's Storefront doing?" — one work session, answered from its state and
 * synopsis.
 *
 * A stale synopsis is said to be stale rather than read out as current. §11:
 * the synopsis must never silently become authoritative.
 */
export function speakWorkSessionStatus(workSession: SpokenWorkSession, now: number): string {
  const { synopsis, state } = workSession;
  const who = subject(workSession);
  const where = workSession.hostLabel === null ? null : `on ${workSession.hostLabel}`;

  const activity = (() => {
    if (state === "offline") return `${who} is offline`;
    if (state === "limited") return `${who} has reached its account limit`;
    if (state === "failed") return `${who} failed`;
    if (state === "needs_approval") return `${who} is waiting for approval`;
    if (state === "needs_input") return `${who} asked you a question`;
    if (state === "done_unseen") return `${who} finished`;
    if (state === "idle") return `${who} is idle`;
    const action = synopsis?.currentAction ?? null;
    if (action !== null) return `${who} is ${lowerFirst(action)}`;
    return `${who} is ${BATON_STATE_LABELS[state].toLowerCase()}`;
  })();

  // §20's shape: "It changed two files after finding a race between commit and
  // acknowledgement." Both halves come from recorded fields; neither is
  // invented, and either may be absent.
  const detail = (() => {
    if (synopsis === null) return null;
    const finding = synopsis.recentFindings[0]?.text ?? null;
    const changed = synopsis.changedFiles.length;
    const files =
      changed === 0 ? null : `${countWord(changed)} ${changed === 1 ? "file" : "files"}`;
    if (files !== null && finding !== null) {
      return withStop(`It changed ${files} after finding ${lowerFirst(finding)}`);
    }
    if (files !== null) return withStop(`It changed ${files}`);
    if (finding !== null) return withStop(`It found ${lowerFirst(finding)}`);
    return null;
  })();

  const need = batonStateNeedsUser(state)
    ? state === "needs_approval"
      ? "It needs you to approve."
      : state === "needs_input"
        ? "It needs an answer."
        : state === "limited"
          ? "Continue it on another account when you are ready."
          : "It needs you."
    : "It does not currently need you.";

  const stale =
    synopsis !== null && isSynopsisStale(synopsis, now)
      ? `That is the last thing recorded, ${describeAge(now - Date.parse(synopsis.updatedAt))} ago.`
      : null;

  return sentence([withStop(sentence([activity, where])), detail, need, stale]);
}

/**
 * "What needs me?" — the whole fleet, shortest useful form.
 *
 * Said in the order a person can act on: approvals, questions, failures,
 * limits, then a count of what is still running.
 */
export function speakFleetNeedsUser(workSessions: ReadonlyArray<SpokenWorkSession>): string {
  const by = (state: BatonSessionState) => workSessions.filter((entry) => entry.state === state);
  const approvals = by("needs_approval");
  const questions = by("needs_input");
  const failures = by("failed");
  const limited = by("limited");
  const working = workSessions.filter(
    (entry) => entry.state === "working" || entry.state === "starting",
  );

  const clauses: string[] = [];
  for (const entry of approvals) {
    clauses.push(withStop(`${subject(entry)} is waiting for approval on ${entry.title}`));
  }
  for (const entry of questions) {
    clauses.push(withStop(`${subject(entry)} has a question about ${entry.title}`));
  }
  for (const entry of failures) {
    clauses.push(withStop(`${entry.title} failed on ${subject(entry)}`));
  }
  for (const entry of limited) {
    clauses.push(withStop(`${subject(entry)} reached its account limit on ${entry.title}`));
  }

  if (clauses.length === 0) {
    return working.length === 0
      ? "Nothing needs you."
      : withStop(
          `Nothing needs you. ${working.length} ${working.length === 1 ? "session is" : "sessions are"} still working`,
        );
  }
  if (working.length > 0) {
    clauses.push(
      withStop(
        `${working.length} other ${working.length === 1 ? "session is" : "sessions are"} still working`,
      ),
    );
  }
  return sentence(clauses);
}

/** "What finished?" — completions the user has not seen. */
export function speakFleetCompletions(
  workSessions: ReadonlyArray<SpokenWorkSession>,
  now: number,
): string {
  const done = workSessions.filter((entry) => entry.state === "done_unseen");
  if (done.length === 0) return "Nothing has finished since you last looked.";
  return sentence(
    done.map((entry) => {
      const synopsis = entry.synopsis;
      const age =
        synopsis === null ? null : `${describeAge(now - Date.parse(synopsis.updatedAt))} ago`;
      const validation = synopsis?.validation.find((step) => step.outcome !== "running") ?? null;
      const outcome =
        validation === null
          ? null
          : validation.outcome === "passed"
            ? `${validation.label} passed`
            : `${validation.label} failed`;
      return withStop(
        sentence([`${entry.title} finished`, age, outcome === null ? null : `— ${outcome}`]),
      );
    }),
  );
}

/** "What's running?" — a roll call, no detail. */
export function speakFleetRunning(workSessions: ReadonlyArray<SpokenWorkSession>): string {
  const running = workSessions.filter(
    (entry) =>
      entry.state === "working" || entry.state === "starting" || entry.state === "monitoring",
  );
  if (running.length === 0) return "Nothing is running.";
  return sentence(
    running.map((entry) =>
      withStop(
        sentence([
          entry.title,
          `on ${subject(entry)}`,
          entry.hostLabel === null ? null : `at ${entry.hostLabel}`,
        ]),
      ),
    ),
  );
}

function describeAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "some time";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "less than a minute";
  if (minutes === 1) return "a minute";
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  return hours === 1 ? "an hour" : `${hours} hours`;
}

const lowerFirst = (text: string): string =>
  text.length === 0 ? text : `${text[0]?.toLowerCase() ?? ""}${text.slice(1)}`;

/** Small counts read better as words when spoken. */
const COUNT_WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
];
const countWord = (value: number): string =>
  value >= 0 && value < COUNT_WORDS.length ? (COUNT_WORDS[value] ?? String(value)) : String(value);
