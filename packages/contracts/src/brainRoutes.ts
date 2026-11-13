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

/**
 * The models a row can name, so "use Opus for talking" resolves by voice: Claude Code's aliases first (the newest
 * of each size, and what he says: "haiku", "sonnet", "opus"), then full ids, then the other providers' lineups
 * (BRAIN-DESIGN §1.2). Both alias and id work on either credential's path.
 */
const BRAIN_MODELS = [
  "haiku",
  "sonnet",
  "opus",
  "claude-haiku-5-5",
  "claude-sonnet-5-5",
  "claude-opus-5-5",
  "gpt-6-astra",
  "gpt-6-luna",
  "gpt-5.5",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gemini-3.8-flash",
  "gemini-2.5-flash-lite",
] as const;
export const BrainModel = Schema.Literals(BRAIN_MODELS).annotate({
  description: 'Say "haiku", "sonnet" or "opus" for Claude; the others are full model ids.',
});

export const BrainModelRoute = Schema.Struct({
  model: BrainModel,
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

/**
 * When a hard task goes to the deep role (Opus): `ask` offers it each time, `auto` goes on its own within the daily
 * cap, `never` stays put. His rules, in his own words, are matched by the model when it asks; the check is code
 * (BRAIN-DESIGN §2.3). Unset fields keep the defaults: ask, 20 a day, no rules.
 */
export const BrainEscalationRule = Schema.Struct({
  when: Schema.String.check(Schema.isMaxLength(200)),
  then: Schema.Literals(["opus", "ask", "sonnet"]),
});
export type BrainEscalationRule = typeof BrainEscalationRule.Type;
export const BrainEscalation = Schema.Struct({
  mode: Schema.optionalKey(Schema.Literals(["ask", "auto", "never"])),
  autoDeepDailyCap: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 500 })),
  ),
  rules: Schema.optionalKey(Schema.Array(BrainEscalationRule).check(Schema.isMaxLength(30))),
});
export type BrainEscalation = typeof BrainEscalation.Type;
