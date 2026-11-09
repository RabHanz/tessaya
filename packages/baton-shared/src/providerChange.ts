/**
 * Why a turn may not move a thread that has run to another provider (Director, 2026-11-09): another account on the
 * same driver is fine, another driver only when the user picked it. A `null` current driver means the thread's
 * provider is gone from this server, which never licenses a different one.
 */
export const providerChangeRefusal = (input: {
  readonly started: boolean;
  readonly currentDriver: string | null;
  readonly targetDriver: string;
  readonly approved: boolean;
}): string | null =>
  !input.started || input.approved || input.currentDriver === input.targetDriver
    ? null
    : `This thread runs on ${input.currentDriver ?? "a provider this server no longer has"}. Tessaya will not move it to ${input.targetDriver} on its own: pick ${input.targetDriver} in the composer to continue there.`;
