/* oxlint-disable t3code/no-em-dash-copy, t3code/no-low-value-comments -- Baton file predating upstream's rule (D82) */
/**
 * What the client itself knows about where the user is, and what it can do
 * about dictation.
 *
 * Two small things, both §14 and §18 in the only place the web client can
 * honestly answer them:
 *
 *   - **Rung 3 has a producer.** "What is open in Baton" was a fact nobody
 *     reported until now, so `focusedWorkSessionId` was always null and "tell
 *     it to stop" always fell through to whatever moved last. The client knows
 *     which thread is on screen; this turns that into the work session it
 *     belongs to.
 *   - **Dictation refuses by name.** A browser tab cannot type into Gmail in
 *     another window, and saying nothing while the words go nowhere is the
 *     failure §18 is written against.
 */
import {
  canInjectAnywhere,
  describeInjection,
  type BatonFleetEntry,
  type BatonInjectionReport,
} from "@t3tools/tessaya-contracts";

/**
 * The work session the user is looking at, from the thread the route has open.
 *
 * `activeThreadKey` is the client's `"<environmentId>:<threadId>"`, because a
 * thread id alone is not unique across environments.
 */
export const focusedWorkSessionFromThreads = (
  entries: ReadonlyArray<BatonFleetEntry>,
  environmentId: string,
  activeThreadKey: string | null,
): string | null => {
  if (activeThreadKey === null) return null;
  const prefix = `${environmentId}:`;
  if (!activeThreadKey.startsWith(prefix)) return null;
  const threadId = activeThreadKey.slice(prefix.length);
  const entry = entries.find((candidate) =>
    candidate.threads.some((thread) => thread.threadId === threadId),
  );
  return entry?.workSessionId ?? null;
};

/**
 * What to say when someone dictates and there is nowhere to put the words.
 *
 * Ordered from the most specific fact available: the host's own capability
 * report if the desktop gave us one, then the fact that a browser tab cannot
 * reach other applications at all. Never a bare "no".
 */
export const dictationRefusal = (input: {
  readonly report: BatonInjectionReport | null;
  readonly targetReason: string;
}): string => {
  if (input.report !== null && !canInjectAnywhere(input.report)) {
    return describeInjection(input.report);
  }
  if (input.targetReason.length > 0) return input.targetReason;
  return "I can only type into a field something has told me about. Nothing is reporting one right now.";
};

/** The line the UI shows while dictation is on, so the mode is never invisible. */
export const dictationModeLabel = (target: { readonly label: string } | null): string =>
  target === null ? "Dictating — nowhere to put it" : `Dictating into ${target.label}`;
