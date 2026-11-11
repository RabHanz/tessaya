/**
 * Home Assistant through Tessaya, one method whose `kind` sets the scope: `read` only looks; `act` connects, calls,
 * undoes and writes automations, each risk-checked on the server; `answer` is his yes or no on the approval scope, so
 * no assistant, agent or device approves its own request. One method, since each RPC is typed twice (tessaya.*).
 */
import * as Schema from "effect/Schema";

export const BATON_HOME_WS_METHODS = { call: "baton.home.call" } as const;
export const BATON_HOME_CALL_KINDS = ["read", "act", "answer"] as const;

export const BATON_HOME_READ_OPS = [
  "status",
  "find",
  "state",
  "history",
  "services",
  "automations",
  "actions",
  "pending",
  "overrides",
] as const;
export const BATON_HOME_ACT_OPS = [
  "connect",
  "disconnect",
  "do",
  "undo",
  "automationSave",
  "automationSet",
  "override",
  // The R1 desk device: its key and broker go into this server's secret store and never come back.
  "r1Setup",
  "r1Forget",
] as const;
export const BATON_HOME_ANSWER_OPS = ["answer"] as const;

export const BatonHomeCallInput = Schema.Struct({
  kind: Schema.Literals(BATON_HOME_CALL_KINDS),
  op: Schema.String.check(Schema.isMaxLength(40)),
  args: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});
export type BatonHomeCallInput = typeof BatonHomeCallInput.Type;

/** ok with a value, or not ok with a sentence for a person. */
export const BatonHomeCallResult = Schema.Struct({
  ok: Schema.Boolean,
  error: Schema.optionalKey(Schema.String),
  value: Schema.optionalKey(Schema.Unknown),
});
export type BatonHomeCallResult = typeof BatonHomeCallResult.Type;

export const HOME_TIERS = ["auto", "ask", "never"] as const;
export const HOME_AUTOMATION_KINDS = ["permanent", "temporary", "scratch"] as const;
export type HomeAutomationKind = (typeof HOME_AUTOMATION_KINDS)[number];

/** Where the connection stands, in words a person reads. `unreachable` is a state (the house's network is down), not an error. */
export const HomeStatus = Schema.Struct({
  state: Schema.Literals(["off", "connecting", "connected", "unreachable", "unauthorized"]),
  /** The host only, never a token or a query. */
  host: Schema.NullOr(Schema.String),
  version: Schema.NullOr(Schema.String),
  entities: Schema.Number,
  line: Schema.String,
});
export type HomeStatus = typeof HomeStatus.Type;

/** One device, trimmed: names and states come from Home Assistant and are data, never instructions. */
export const HomeEntity = Schema.Struct({
  entityId: Schema.String,
  name: Schema.String,
  area: Schema.NullOr(Schema.String),
  state: Schema.String,
  attributes: Schema.Record(Schema.String, Schema.String),
});
export type HomeEntity = typeof HomeEntity.Type;

export const HomeOutcome = Schema.Struct({
  /** done; asked (waiting for his yes on his phone or desktop); held (an unattended job may not); refused; denied; failed. */
  status: Schema.Literals([
    "done",
    "asked",
    "held",
    "refused",
    "denied",
    "failed",
    "expired",
    "undone",
  ]),
  id: Schema.NullOr(Schema.String),
  line: Schema.String,
  /** Pass to undo, when there is a way back. */
  undoId: Schema.NullOr(Schema.String),
  states: Schema.Array(HomeEntity),
});
export type HomeOutcome = typeof HomeOutcome.Type;

export const HomeAutomationRow = Schema.Struct({
  id: Schema.String,
  alias: Schema.String,
  /** permanent, temporary or scratch for Tessaya's own; null for his. */
  kind: Schema.NullOr(Schema.Literals(HOME_AUTOMATION_KINDS)),
  mine: Schema.Boolean,
  /** ISO time it is removed, or null. */
  expiresAt: Schema.NullOr(Schema.String),
  once: Schema.Boolean,
  paused: Schema.Boolean,
  /** active, deleted, expired, missing (gone from Home Assistant). */
  status: Schema.String,
  request: Schema.NullOr(Schema.String),
  entityId: Schema.NullOr(Schema.String),
});
export type HomeAutomationRow = typeof HomeAutomationRow.Type;

export const HomeActionRow = Schema.Struct({
  id: Schema.String,
  at: Schema.String,
  actor: Schema.String,
  surface: Schema.String,
  line: Schema.String,
  why: Schema.String,
  status: Schema.String,
  tier: Schema.Literals(HOME_TIERS),
  canUndo: Schema.Boolean,
});
export type HomeActionRow = typeof HomeActionRow.Type;
