/**
 * Provenance for what a turn decides (memory note provenance-in-the-bones): each action as one event with its kind,
 * actor and certainty, evidence by reference and the persona, in the action log (B-046).
 */
import * as Effect from "effect/Effect";

import { emitAction as logAction } from "../provenance/ActionLog.ts";

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

/** Into the action log: queued, never fails or blocks the turn. */
export const emitAction = (action: TurnAction) => Effect.asVoid(logAction(action));
