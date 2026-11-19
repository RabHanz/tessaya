/**
 * One Tessaya on a client (M-097): whichever of his machines the client paired with, she is one. Her features read the
 * brain's environment while it is connected, else any connected one of his (each forwards to the brain). T3 sessions
 * keep their per-environment model; this is only for Tessaya.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import type { PhonePairingResult } from "@t3tools/tessaya-contracts";
import { Atom } from "effect/reactivity";

/** The environment her features talk to: the brain when connected, else the first connected; null with none. */
export const pickTessayaEnvironment = (
  connected: ReadonlyArray<EnvironmentId>,
  brain: EnvironmentId | null,
): EnvironmentId | null =>
  brain !== null && connected.includes(brain) ? brain : (connected[0] ?? null);

/** The household's other machines a pairing should add: those the client doesn't have yet. */
export const householdToJoin = (
  codes: PhonePairingResult,
  known: ReadonlySet<string>,
): ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly pairingUrl: string }> =>
  codes.linked
    .filter((l) => !known.has(l.environmentId))
    .map((l) => ({ environmentId: l.environmentId, pairingUrl: l.pairingUrl }));

export const createTessayaEnvironmentAtoms = (
  connectedEnvironmentIdsAtom: Atom.Atom<ReadonlyArray<EnvironmentId>>,
) => {
  // shortcut: the brain is learned at pairing and kept in memory; after a restart she uses any connected machine (each forwards to the brain) until the next pairing
  const brainEnvironmentIdAtom = Atom.make<EnvironmentId | null>(null).pipe(
    Atom.keepAlive,
    Atom.withLabel("tessaya:brain-environment"),
  );
  const tessayaEnvironmentIdAtom = Atom.make((get) =>
    pickTessayaEnvironment(get(connectedEnvironmentIdsAtom), get(brainEnvironmentIdAtom)),
  ).pipe(Atom.withLabel("tessaya:environment"));
  return { brainEnvironmentIdAtom, tessayaEnvironmentIdAtom };
};
