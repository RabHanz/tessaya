/** Personas acting in the ops system through its MCP, each as its own worker (Settings → Personas → the ops system). */
import * as Schema from "effect/Schema";

export const BATON_PERSONA_OPS_WS_METHODS = { call: "baton.personaOps.call" } as const;

export const PersonaOpsAccount = Schema.Struct({
  platform: Schema.String,
  account: Schema.String,
  /** Set when the account came from a warm-up schedule. */
  deviceSerial: Schema.optionalKey(Schema.String),
  /** Its warm-up runs (a schedule), or it may be warmed up (a delegation). */
  enabled: Schema.Boolean,
  /** Set when the account came from a delegation: it may post. */
  mayPost: Schema.optionalKey(Schema.Boolean),
});
export type PersonaOpsAccount = typeof PersonaOpsAccount.Type;

/** One delegated account in Settings: "@handle on tiktok (warm-up, posts)". */
export const personaOpsDelegation = (a: PersonaOpsAccount) =>
  `@${a.account} on ${a.platform} (${[a.enabled ? "warm-up" : "", a.mayPost === true ? "posts" : ""].filter(Boolean).join(", ") || "read only"})`;

export const PersonaOpsPersonaView = Schema.Struct({
  persona: Schema.String,
  workerId: Schema.String,
  /** Its token is in the brain's secrets; revoking removes it. */
  hasToken: Schema.Boolean,
  /** The accounts the ops system shows it, or null when it could not be asked (`error` says why). */
  accounts: Schema.NullOr(Schema.Array(PersonaOpsAccount)),
  error: Schema.optionalKey(Schema.String),
  /** The accounts are its delegations; otherwise they are its warm-up schedules (an ops system without that read). */
  delegated: Schema.optionalKey(Schema.Boolean),
});
export type PersonaOpsPersonaView = typeof PersonaOpsPersonaView.Type;

export const PersonaOpsView = Schema.Struct({
  /** False when this server is not the brain, or the ops system is not configured here. */
  available: Schema.Boolean,
  /** What he calls the system (its config's name). */
  name: Schema.String,
  why: Schema.optionalKey(Schema.String),
  personas: Schema.Array(PersonaOpsPersonaView),
});
export type PersonaOpsView = typeof PersonaOpsView.Type;

export const PersonaOpsCallInput = Schema.Union([
  Schema.Struct({ op: Schema.Literal("view") }),
  Schema.Struct({
    op: Schema.Literal("revoke"),
    persona: Schema.String.check(Schema.isMaxLength(40)),
  }),
]);
export type PersonaOpsCallInput = typeof PersonaOpsCallInput.Type;

export const PersonaOpsCallResult = Schema.Struct({
  ok: Schema.Boolean,
  error: Schema.optionalKey(Schema.String),
  view: Schema.optionalKey(PersonaOpsView),
});
export type PersonaOpsCallResult = typeof PersonaOpsCallResult.Type;
