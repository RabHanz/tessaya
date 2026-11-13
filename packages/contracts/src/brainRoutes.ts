/**
 * Tessaya: the one table that says which login pays for each kind of work her brain does, and on which model
 * (tessaya-ops research/BRAIN-DESIGN.md §13). Every model call asks it; nothing hard-codes a model or a credential.
 * A role left out of the table uses what it used before the table (the cleanup model, `routing.json`), except his
 * 13 Nov choices: spoken turns on his subscription, and the API key for cleanup only.
 */
import * as Schema from "effect/Schema";

const BRAIN_ROLES = [
  "cleanup",
  "voice",
  "deep",
  "background",
  "consolidation",
  "web",
  "vision",
  "intent",
  "synopsis",
] as const;
export const BrainRole = Schema.Literals(BRAIN_ROLES);
export type BrainRole = typeof BrainRole.Type;

/** The API keys the brain can read: today the one Anthropic key in Settings → APIs. */
export type BrainApiKey = "anthropic";

/**
 * Which login pays: `subscription` (the server's own Claude login), `subscription:<account>` (a named one), or
 * `apiKey:anthropic`. One string, so a voice setting or a settings row reads as plainly as it is said.
 */
export const BrainCredential = Schema.String.check(
  Schema.isPattern(/^(?:subscription(?::[A-Za-z0-9._-]{1,60})?|apiKey:anthropic)$/),
);
export type BrainCredential = typeof BrainCredential.Type;

/** `fallback` is used only when `use` fails before a word is said, and only because this row names it. */
export const BrainCredentialRoute = Schema.Struct({
  use: BrainCredential,
  /** "none" says so outright: a settings patch merges rows, so leaving the key out can't take a fallback away. */
  fallback: Schema.optionalKey(Schema.Union([BrainCredential, Schema.Literal("none")])),
});
export type BrainCredentialRoute = typeof BrainCredentialRoute.Type;

export const BrainEffort = Schema.Literals(["low", "medium", "high", "xhigh", "max"]);
export type BrainEffort = typeof BrainEffort.Type;

/** A Claude Code alias (`sonnet`) or a full model id (`claude-sonnet-5-5`); both work on either credential's path. */
export const BrainModelRoute = Schema.Struct({
  model: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80)),
  effort: Schema.optionalKey(BrainEffort),
});
export type BrainModelRoute = typeof BrainModelRoute.Type;

const credentialRow = Schema.optionalKey(BrainCredentialRoute);
export const BrainCredentials = Schema.Struct({
  cleanup: credentialRow,
  voice: credentialRow,
  deep: credentialRow,
  background: credentialRow,
  consolidation: credentialRow,
  web: credentialRow,
  vision: credentialRow,
  intent: credentialRow,
  synopsis: credentialRow,
});
export type BrainCredentials = typeof BrainCredentials.Type;
const modelRow = Schema.optionalKey(BrainModelRoute);
export const BrainModels = Schema.Struct({
  cleanup: modelRow,
  voice: modelRow,
  deep: modelRow,
  background: modelRow,
  consolidation: modelRow,
  web: modelRow,
  vision: modelRow,
  intent: modelRow,
  synopsis: modelRow,
});
export type BrainModels = typeof BrainModels.Type;

/** The roles each API key may serve. A call for any other role is refused, never sent (the spend guard). */
export const BrainKeyRoles = Schema.Struct({
  anthropic: Schema.optionalKey(Schema.Array(BrainRole)),
});
export type BrainKeyRoles = typeof BrainKeyRoles.Type;
