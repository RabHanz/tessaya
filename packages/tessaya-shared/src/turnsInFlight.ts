/**
 * What an update, an install or a restart of this machine would cut off (SESS-SURVIVE): a T3 thread whose run is
 * active (running, or waiting on him mid-turn), and a Claude Code process that says it is busy. Archived and deleted
 * threads hold nothing.
 */
export interface InFlightThread {
  readonly id: string;
  readonly title: string;
  readonly activeRunId?: string | null | undefined;
  readonly archivedAt?: unknown;
  readonly deletedAt?: unknown;
}
export interface InFlightLive {
  readonly sessionId: string;
  readonly name: string | null;
  readonly cwd: string;
  readonly status: string | null;
}

export const turnsInFlight = (input: {
  readonly threads: ReadonlyArray<InFlightThread>;
  readonly live: ReadonlyArray<InFlightLive>;
}) => ({
  threads: input.threads
    .filter((t) => t.activeRunId != null && t.archivedAt == null && t.deletedAt == null)
    .map((t) => ({ threadId: t.id, title: t.title })),
  live: input.live
    .filter((s) => s.status === "busy")
    .map((s) => ({ sessionId: s.sessionId, name: s.name, cwd: s.cwd })),
});

/** One line for him: what is running, or null when nothing is. */
export const inFlightLine = (found: ReturnType<typeof turnsInFlight>): string | null => {
  const names = [
    ...found.threads.map((t) => t.title),
    ...found.live.map((s) => s.name ?? s.cwd.split(/[\\/]/).pop() ?? s.sessionId),
  ];
  if (names.length === 0) return null;
  const shown = names
    .slice(0, 3)
    .map((n) => `“${n}”`)
    .join(", ");
  return `${names.length === 1 ? "A session is" : `${names.length} sessions are`} mid-turn: ${shown}${names.length > 3 ? ", and more" : ""}.`;
};
