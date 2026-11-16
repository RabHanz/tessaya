/**
 * Provenance for what a turn decides (memory note provenance-in-the-bones): each action as one event with its kind,
 * actor and certainty, evidence by reference and the persona. Shaped as the action log's `ActionInput`
 * (feat/provenance-spine, apps/server/src/provenance/ActionLog.ts) so the switch to it is this one function.
 */
import * as Effect from "effect/Effect";

export interface TurnAction {
  /** Dotted: "turn.repair.verdict", "turn.recall.window", "turn.context.expired". */
  readonly kind: string;
  readonly actor: {
    readonly kind: "owner" | "member" | "guest" | "persona" | "rule" | "system" | "device";
    readonly id?: string;
    readonly certainty: number;
  };
  readonly evidence?: ReadonlyArray<{ readonly kind: string; readonly ref: string }>;
  readonly persona?: string | null;
  readonly subject?: string;
  readonly outcome?: string;
  readonly data?: unknown;
}

// shortcut: a structured log line until ActionLog merges; then `ActionLog.emit(action)` (it never fails or blocks).
export const emitAction = (action: TurnAction) =>
  Effect.logInfo(`action ${action.kind}`, action).pipe(Effect.withSpan("TessayaTurn.action"));
