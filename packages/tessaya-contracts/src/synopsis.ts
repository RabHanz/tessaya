/* oxlint-disable t3code/no-low-value-comments -- Baton file predating upstream's rule (D82) */
/**
 * The Working Synopsis: what a piece of work is doing, in a form a human can
 * hear in one breath.
 *
 * §11's rule, and the reason this is a struct of small typed fields rather
 * than a paragraph: **update deterministically from events whenever possible.**
 * A file changed, a test started, an approval was requested, a turn settled —
 * each of those is a fact the environment already reported, and turning it into
 * a synopsis field costs nothing and cannot hallucinate. Asking the agent to
 * summarise itself on a cadence costs tokens and invents.
 *
 * §11's other rule is here too: **the synopsis must never silently become
 * authoritative over Git or provider reality.** Hence `updatedAt` on every
 * field group and `staleAfterSeconds` on the record: a surface that shows a
 * synopsis shows how old it is, and a consumer that needs the truth reads Git
 * or the thread.
 *
 * @module baton/synopsis
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString, TrimmedString } from "@t3tools/contracts";

/**
 * Where a synopsis field came from. `events` is the deterministic path and is
 * the default; `model` marks text a provider generated at a milestone. Keeping
 * them distinguishable is what stops a generated sentence from being read as a
 * recorded fact later.
 */
export const SynopsisSource = Schema.Literals(["events", "model"]);
export type SynopsisSource = typeof SynopsisSource.Type;

/** One validation step and how it ended. Derived from test/command activities. */
export const SynopsisValidation = Schema.Struct({
  label: TrimmedNonEmptyString,
  outcome: Schema.Literals(["running", "passed", "failed"]),
  observedAt: IsoDateTime,
});
export type SynopsisValidation = typeof SynopsisValidation.Type;

export const SynopsisFinding = Schema.Struct({
  text: TrimmedNonEmptyString,
  observedAt: IsoDateTime,
  source: SynopsisSource,
});
export type SynopsisFinding = typeof SynopsisFinding.Type;

/**
 * The §11 example, typed.
 *
 * Absent rather than empty-stringed: a work session that has done nothing yet
 * has no current action, and "" would render as a blank line pretending to be
 * content.
 */
export const WorkSessionSynopsis = Schema.Struct({
  /** What the provider is doing right now, from the latest turn/tool activity. */
  currentAction: Schema.NullOr(TrimmedNonEmptyString),
  /** Why the work exists. Mirrors the work session's objective unless a model refined it. */
  goal: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  recentFindings: Schema.Array(SynopsisFinding).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  /** Workspace-relative paths the turn touched, most recent first. */
  changedFiles: Schema.Array(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  validation: Schema.Array(SynopsisValidation).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  /** What happens after this, from orchestration rules or the user's own note. */
  next: Schema.Array(TrimmedNonEmptyString).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  /** Mirrors the derived session state; kept here so a spoken answer needs one read. */
  needsUser: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /** When any field last changed. The staleness clock. */
  updatedAt: IsoDateTime,
  /** The last event kind that moved it, so a reader can tell why it is current. */
  updatedBy: Schema.NullOr(TrimmedNonEmptyString),
  source: SynopsisSource.pipe(Schema.withDecodingDefault(Effect.succeed("events" as const))),
});
export type WorkSessionSynopsis = typeof WorkSessionSynopsis.Type;

export const EMPTY_SYNOPSIS = (updatedAt: string): WorkSessionSynopsis => ({
  currentAction: null,
  goal: "",
  recentFindings: [],
  changedFiles: [],
  validation: [],
  next: [],
  needsUser: false,
  updatedAt,
  updatedBy: null,
  source: "events",
});

/**
 * How long a synopsis stays useful before a surface should say so out loud.
 * Ninety seconds because a turn's tool churn updates it far more often than
 * that while work is live, so anything older means the work stopped moving and
 * nobody has looked.
 */
export const SYNOPSIS_STALE_AFTER_MS = 90_000;

export const synopsisAgeMs = (synopsis: WorkSessionSynopsis, now: number): number => {
  const updatedAt = Date.parse(synopsis.updatedAt);
  return Number.isNaN(updatedAt) ? Number.POSITIVE_INFINITY : Math.max(0, now - updatedAt);
};

export const isSynopsisStale = (synopsis: WorkSessionSynopsis, now: number): boolean =>
  synopsisAgeMs(synopsis, now) > SYNOPSIS_STALE_AFTER_MS;

/**
 * Bounds. A synopsis is a glance, not a log: an unbounded findings list turns
 * into a transcript nobody reads and a row nobody can render.
 */
export const SYNOPSIS_MAX_FINDINGS = 5;
export const SYNOPSIS_MAX_CHANGED_FILES = 12;
export const SYNOPSIS_MAX_VALIDATION = 6;
export const SYNOPSIS_MAX_NEXT = 4;
