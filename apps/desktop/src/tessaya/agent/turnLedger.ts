import type { TraceCall, TurnTrace } from "@t3tools/tessaya-shared/skillLearning";
import type { SpeakerIdentity } from "@t3tools/tessaya-voice";

import { SessionClosed } from "../screen/claudeVision.ts";

export interface ToolResult {
  readonly tool: string;
  readonly ok: boolean;
  readonly error?: string;
  readonly argKeys: ReadonlyArray<string>;
  readonly ms: number;
}

/** What one assistant turn did, for its own line in the turn log and no other turn's. */
export interface TurnRecord {
  readonly tools: string[];
  readonly results: Array<ToolResult>;
  readonly decisions: Array<{ readonly tool: string; readonly outcome: string }>;
  readonly routes: Array<{ readonly route: string; readonly why: string }>;
  /** Each tool's first answer, only on this machine and never in a log, so the turn can be replayed. */
  readonly answers: Record<string, string>;
  /** The learned skills this turn was given. */
  readonly skills: string[];
  /** Whose voice asked for this turn: a short spoken yes to its question is theirs. */
  readonly speaker?: SpeakerIdentity | null;
}

const empty = (): TurnRecord => ({
  tools: [],
  results: [],
  decisions: [],
  routes: [],
  answers: {},
  skills: [],
});

/** Why a turn ended early: he stopped it, he moved the mouse, or the failure guard did. */
export const stoppedBy = (
  results: ReadonlyArray<ToolResult>,
  error: unknown,
): TurnTrace["stoppedBy"] => {
  if (error instanceof SessionClosed) return "stop";
  if (results.some((r) => r.error?.startsWith("He moved the mouse") === true)) return "mouse";
  if (results.some((r) => /^Stopped: .* has failed \d+ times/.test(r.error ?? ""))) return "guard";
  return null;
};

/** The calls as code wrote them: no error text, which can quote what was on the screen. */
export const traceCalls = (results: ReadonlyArray<ToolResult>): ReadonlyArray<TraceCall> =>
  results.map((r) => ({ tool: r.tool, argKeys: r.argKeys, ok: r.ok, ms: r.ms }));

/**
 * A sentence is logged when it is heard, but the assistant runs turns one at a time in that order. Each asked turn gets
 * its record when it really begins; one stopped before it began keeps an empty one, and writes outside any turn are dropped.
 */
export const createTurnLedger = () => {
  const waiting: Array<{ readonly record: TurnRecord }> = [];
  let running: TurnRecord | null = null;
  return {
    ask: (speaker: SpeakerIdentity | null = null) => {
      const slot = { record: { ...empty(), ...(speaker === null ? {} : { speaker }) } };
      waiting.push(slot);
      return {
        record: () => slot.record,
        done: () => {
          const at = waiting.indexOf(slot);
          if (at >= 0) waiting.splice(at, 1);
          if (running === slot.record) running = null;
        },
      };
    },
    begin: () => {
      running = waiting.shift()?.record ?? empty();
    },
    current: (): TurnRecord => running ?? empty(),
  };
};
