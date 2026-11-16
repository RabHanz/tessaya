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

/** A word-timed effect a vessel fired as her voice reached its word (VOXTA-STUDY G7): what it showed and buzzed. */
export const effectFired = (fired: {
  readonly vessel: string;
  readonly nonverbal: string;
  readonly face: string | null;
  readonly haptic: string | null;
  /** What the device answered for the buzz (his haptics setting may have kept it still). */
  readonly outcome?: string;
}) =>
  emitAction({
    kind: "turn.effect.fired",
    actor: { kind: "device", id: fired.vessel, certainty: 1 },
    subject: fired.nonverbal,
    ...(fired.outcome === undefined ? {} : { outcome: fired.outcome }),
    data: { face: fired.face, haptic: fired.haptic },
  });
