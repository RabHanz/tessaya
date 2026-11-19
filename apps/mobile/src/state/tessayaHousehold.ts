import type { EnvironmentId } from "@t3tools/contracts";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import {
  createTessayaEnvironmentAtoms,
  householdToJoin,
} from "@t3tools/tessaya-shared/householdClient";

import { appAtomRegistry } from "./atom-registry";
import { environmentCatalog } from "../connection/catalog";
import { connectedEnvironmentIdsAtom } from "./presentation";
import { tessayaWorkSessions } from "./tessayaWorkSessions";

/** Her one environment on this phone (M-097): Tessaya screens read this, never a picker. */
export const { brainEnvironmentIdAtom, tessayaEnvironmentIdAtom } = createTessayaEnvironmentAtoms(
  connectedEnvironmentIdsAtom,
);

const CONNECT_WAIT_MS = 20_000;

/** Resolves once the machine just paired is connected, or after the wait (the RPC then says why). */
const connected = (environmentId: EnvironmentId) =>
  new Promise<void>((resolve) => {
    if (appAtomRegistry.get(connectedEnvironmentIdsAtom).includes(environmentId)) return resolve();
    const timer = setTimeout(done, CONNECT_WAIT_MS);
    const unsubscribe = appAtomRegistry.subscribe(connectedEnvironmentIdsAtom, (ids) => {
      if (ids.includes(environmentId)) done();
    });
    function done() {
      clearTimeout(timer);
      unsubscribe();
      resolve();
    }
  });

/**
 * Paired with one of his machines: that machine (through her brain) gives codes for the rest of the household, and the
 * phone pairs each one it doesn't have. What could not be added, in words; empty when all were.
 */
export async function joinHousehold(
  environmentId: EnvironmentId,
  pair: (
    pairingUrl: string,
    expected: EnvironmentId,
  ) => Promise<{ readonly ok: boolean; readonly error: string | null }>,
): Promise<ReadonlyArray<string>> {
  await connected(environmentId);
  const issued = await runAtomCommand(
    appAtomRegistry,
    tessayaWorkSessions.phonePairing,
    { environmentId, input: {} },
    { reportFailure: false },
  );
  // An older machine, or one not in a household: the phone keeps the one it paired.
  if (issued._tag !== "Success") return [];
  if (issued.value.brain !== undefined)
    appAtomRegistry.set(brainEnvironmentIdAtom, issued.value.brain);
  const known = new Set<string>([
    environmentId,
    ...appAtomRegistry.get(environmentCatalog.catalogValueAtom).entries.keys(),
  ]);
  const notAdded: Array<string> = [];
  for (const next of householdToJoin(issued.value, known)) {
    const added = await pair(next.pairingUrl, next.environmentId);
    if (!added.ok) notAdded.push(added.error ?? "not added");
  }
  return notAdded;
}
