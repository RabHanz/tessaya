/* oxlint-disable t3code/no-low-value-comments -- Baton file predating upstream's rule (D82) */
/**
 * §6.1 handoff: continue the same work on another provider instance.
 *
 * In-place account rotation (`fabric.account.use`, D56/D57) covers accounts behind one Claude
 * config directory. Moving to another instance or driver is upstream's `provider.switch` since
 * the v2 port: the thread stays, upstream's context handoff carries the work across, and
 * Baton's own capsule is gone (D80).
 *
 * @module baton/handoff
 */
import * as Schema from "effect/Schema";

import { ThreadId, TrimmedString } from "@t3tools/contracts";
import { ModelSelection, RuntimeMode } from "@t3tools/contracts";
import { WorkSession, WorkSessionId } from "./workSession.ts";

export const BATON_HANDOFF_WS_METHODS = {
  workSessionHandoff: "fabric.workSession.handoff",
} as const;

/**
 * "Continue with...": the work session's active thread moves to another provider instance with
 * upstream's own `provider.switch`, which carries the context across. The thread keeps its id,
 * so the work session keeps its thread. `threadId` is accepted from older clients and ignored.
 */
export const WorkSessionHandoffInput = Schema.Struct({
  id: WorkSessionId,
  threadId: Schema.optionalKey(ThreadId),
  modelSelection: ModelSelection,
  runtimeMode: Schema.optionalKey(RuntimeMode),
  /** Sent to the thread as the first message on the new provider, when given. */
  note: Schema.optionalKey(TrimmedString),
});
export type WorkSessionHandoffInput = typeof WorkSessionHandoffInput.Type;

export const WorkSessionHandoffResult = Schema.Struct({
  workSession: WorkSession,
});
export type WorkSessionHandoffResult = typeof WorkSessionHandoffResult.Type;

export class WorkSessionHandoffRefusedError extends Schema.TaggedError<WorkSessionHandoffRefusedError>()(
  "WorkSessionHandoffRefusedError",
  { workSessionId: WorkSessionId, reason: Schema.String },
) {
  override get message(): string {
    return `Work session ${this.workSessionId} was not handed off: ${this.reason}`;
  }
}
