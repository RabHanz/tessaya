// @effect-diagnostics globalTimers:off
/**
 * A standing job's run once it holds the turn (KIRO-1): a pass that ran out of time while it waited does not start it,
 * and its own time limit starts now, not while it waited for his turn.
 */
export type StandingRunStatus = "ok" | "error" | "timeout" | "cancelled";

export const runOnceItsTurn = async (
  pass: AbortSignal,
  timeoutMs: number,
  work: (
    timeout: AbortSignal,
  ) => Promise<{ readonly status: StandingRunStatus; readonly text: string }>,
): Promise<{ readonly status: StandingRunStatus; readonly text: string }> => {
  if (pass.aborted) return { status: "cancelled", text: "Waited too long for its turn." };
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), timeoutMs);
  try {
    return await work(timeout.signal);
  } finally {
    clearTimeout(timer);
  }
};
