/**
 * Cloud tasks over the connection a client already has (transport 2): the computer that holds the
 * logins runs the harness, other computers ask it. Two methods so the scopes stay honest: `read`
 * only looks (describe, detect, status, list, usage, diff); `act` creates, answers or changes.
 * The request and the answer are plain JSON; the shapes are in docs/baton/CLOUD_DISPATCH.md.
 */
import * as Schema from "effect/Schema";

export const BATON_CLOUD_WS_METHODS = {
  read: "baton.cloud.read",
  act: "baton.cloud.act",
  /** Approve or deny: its own scope, so no assistant, tool or session client can approve its own request. */
  approve: "baton.cloud.approve",
} as const;

export const BATON_CLOUD_READ_OPS = [
  "describe",
  "detect",
  "status",
  "list",
  "usage",
  "diff",
] as const;
// Applying writes a change into a checkout, so it needs the same scope as approving.
export const BATON_CLOUD_ACT_OPS = ["dispatch", "cancel"] as const;
export const BATON_CLOUD_APPROVE_OPS = ["approve", "deny", "apply"] as const;

export const BatonCloudCallInput = Schema.Struct({
  op: Schema.String.check(Schema.isMaxLength(40)),
  provider: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(40))),
  args: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});
export type BatonCloudCallInput = typeof BatonCloudCallInput.Type;

/** ok with a value, or not ok with a sentence for a person. */
export const BatonCloudCallResult = Schema.Struct({
  ok: Schema.Boolean,
  error: Schema.optionalKey(Schema.String),
  value: Schema.optionalKey(Schema.Unknown),
});
export type BatonCloudCallResult = typeof BatonCloudCallResult.Type;
