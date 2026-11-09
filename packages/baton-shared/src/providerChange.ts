/**
 * Why a command may not move a thread that has run to another provider (Director, 2026-11-09): another account on
 * the same provider is fine, another provider only when the user picked it. `provider` is the driver, or for ACP
 * agents (which share one driver) the agent's own continuation key. `null` means this server cannot say what the
 * provider is, which never counts as the same one.
 */
export const providerChangeRefusal = (input: {
  readonly started: boolean;
  readonly approved: boolean;
  readonly current: { readonly instance: string; readonly provider: string | null };
  readonly target: { readonly instance: string; readonly provider: string | null };
}): string | null =>
  !input.started ||
  input.approved ||
  (input.current.provider !== null && input.current.provider === input.target.provider)
    ? null
    : `This thread runs on ${input.current.instance}. Tessaya will not move it to ${input.target.instance} on its own: pick ${input.target.instance} in the composer to continue there.`;

/** The provider identity `providerChangeRefusal` compares: the driver, or an ACP agent's continuation key. */
export const providerIdentity = (driver: string, continuationKey: string): string =>
  driver === "acpRegistry" ? `${driver}:${continuationKey}` : driver;
