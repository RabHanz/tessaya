import { PROVIDER_DISPLAY_NAMES, ProviderDriverKind } from "@t3tools/contracts";

import { instanceLabel } from "./liveThread.ts";

/**
 * Why a command may not move a thread that has run to another provider (Director, 2026-11-09): another account on
 * the same provider is fine, another provider only when the user picked it. `provider` is the driver, or for ACP
 * agents (which share one driver) the agent's own continuation key. `null` means this server cannot say what the
 * provider is, which never counts as the same one.
 */
export const providerChangeRefusal = (input: {
  readonly started: boolean;
  readonly approved: boolean;
  /** `name` is what the user sees in the picker (`instanceName`), never the internal instance id. */
  readonly current: { readonly name: string; readonly provider: string | null };
  readonly target: { readonly name: string; readonly provider: string | null };
  /** The provider its latest turn ran on, when the thread was pointed elsewhere since (Open in terminal). */
  readonly lastTurnProvider?: string | null;
}): string | null =>
  !input.started ||
  input.approved ||
  (input.target.provider !== null &&
    (input.target.provider === input.current.provider ||
      input.target.provider === input.lastTurnProvider))
    ? null
    : `This thread runs on ${input.current.name}. Tessaya will not move it to ${input.target.name} on its own: pick ${input.target.name} in the composer to continue there.`;

/** An instance's display name, else its driver's, else the live instance's label; the id only when nothing names it. */
export const instanceName = (
  instanceId: string,
  entry: { readonly displayName?: string | undefined; readonly driver: string } | undefined,
): string =>
  entry?.displayName ??
  PROVIDER_DISPLAY_NAMES[ProviderDriverKind.make(entry?.driver ?? instanceId)] ??
  instanceLabel(instanceId);

/** The provider identity `providerChangeRefusal` compares: the driver, or an ACP agent's continuation key. */
export const providerIdentity = (driver: string, continuationKey: string): string =>
  driver === "acpRegistry" ? `${driver}:${continuationKey}` : driver;
