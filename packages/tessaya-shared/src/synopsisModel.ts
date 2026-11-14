/* oxlint-disable t3code/no-low-value-comments -- Baton file predating upstream's rule (D82) */
/**
 * The written half of the Working Synopsis (D51), with none of the model in it.
 *
 * §11 always allowed semantic summarisation at milestones; D16 declined it
 * while the fork had no model on any path. D50 put one there, and the Director
 * asked for the same thing here: two sentences that say where the work is and
 * what is needed, in place of a label assembled from event names.
 *
 * What the model is **not** allowed to decide, and this module is where that is
 * enforced:
 *
 *   - **the state.** `needsUser` — and therefore whether the fleet interrupts
 *     somebody — stays derived from events. A model guessing "needs approval"
 *     is a model deciding whether to interrupt a person, which is not a
 *     summarisation task.
 *   - **the facts.** `changedFiles`, `validation` and `recentFindings` are
 *     observations, and they keep coming from the events that observed them. A
 *     model that "remembers" a file nobody touched is worse than no synopsis.
 *
 * It writes `currentAction` and `next`, and it marks the synopsis `source:
 * "model"` so a reader always knows which kind they are looking at.
 *
 * @module batonSynopsisModel
 */
import type { WorkSessionSynopsis } from "@t3tools/tessaya-contracts";

/** Turns handed to the model, oldest first. */
export interface SynopsisTurn {
  readonly role: "user" | "assistant";
  readonly text: string;
}

/** Enough turns to see a direction, few enough to stay cheap. */
export const SYNOPSIS_TURN_WINDOW = 6;
/** Per turn. A synopsis is two sentences; it does not need the whole essay. */
export const SYNOPSIS_TURN_CHARS = 1_200;

const trim = (text: string): string => {
  const flattened = text.replace(/\s+/gu, " ").trim();
  return flattened.length <= SYNOPSIS_TURN_CHARS
    ? flattened
    : `${flattened.slice(0, SYNOPSIS_TURN_CHARS)}…`;
};

/**
 * What the model is told.
 *
 * The work's own title and its recent turns, and nothing else — no file
 * contents, no diffs, no other work session. A synopsis is about this thread.
 */
export function buildSynopsisPrompt(input: {
  readonly title: string;
  readonly objective: string;
  readonly turns: ReadonlyArray<SynopsisTurn>;
}): string {
  const turns = input.turns
    .slice(-SYNOPSIS_TURN_WINDOW)
    .map((turn) => `${turn.role === "user" ? "Person" : "Agent"}: ${trim(turn.text)}`)
    .filter((line) => line.length > 7);

  return [
    "Write two short sentences about a piece of software work, for someone who stepped away and came back.",
    "",
    "The first sentence says where the work is now. The second says what is needed next.",
    "Rules:",
    '- Write about the WORK. Never about this request, never about the summary itself, never about yourself. "Wrote a status update" is wrong; "The reconnect fix is in" is right.',
    "- Plain, specific, concrete. No preamble, no 'the agent is', no restating the title.",
    "- Present tense for the first, imperative or expectant for the second.",
    "- If nothing is needed next, say what would confirm it is done.",
    "- Never invent a file, a test result or a decision that is not in the turns below.",
    "",
    `The work is called: ${input.title}`,
    input.objective.trim().length === 0 ? "" : `Its objective: ${input.objective.trim()}`,
    "",
    "Recent turns, oldest first:",
    turns.length === 0 ? "(nothing yet)" : turns.join("\n"),
  ]
    .filter((section) => section !== "")
    .join("\n");
}

const sentence = (text: string, fallback: string | null): string | null => {
  const flattened = text.replace(/\s+/gu, " ").trim();
  if (flattened.length === 0) return fallback;
  // One sentence, whatever the model sent. Two is a paragraph, and this line
  // renders in a 256px sidebar.
  const first = /^[^.!?]*[.!?]?/u.exec(flattened)?.[0]?.trim() ?? flattened;
  return first.length === 0 ? fallback : first;
};

/**
 * Fold a model's two sentences into the deterministic synopsis.
 *
 * `updatedAt` moves because the account did change; `updatedBy` says which
 * trigger caused it, so "why is this line here" stays answerable.
 */
export function applyModelSynopsis(
  synopsis: WorkSessionSynopsis,
  written: {
    readonly currentAction: string;
    readonly next: string;
    readonly at: string;
  },
): WorkSessionSynopsis {
  const currentAction = sentence(written.currentAction, synopsis.currentAction);
  const next = sentence(written.next, null);
  return {
    ...synopsis,
    currentAction,
    // The written "what is needed" replaces the assembled one rather than
    // joining it: two answers to the same question, one of them a rule name,
    // is how a synopsis becomes unreadable.
    next: next === null ? synopsis.next : [next],
    // Deliberately untouched: needsUser, validation, changedFiles,
    // recentFindings. Those are what the events observed, and the model was not
    // asked about them.
    source: "model",
    updatedAt: written.at,
    updatedBy: "turn-completed",
  };
}
