import type { EnvironmentId } from "@t3tools/contracts";
import * as SecureStore from "expo-secure-store";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import {
  createTessayaEnvironmentAtoms,
  householdToJoin,
} from "@t3tools/tessaya-shared/householdClient";

import { whenProtectedDataAvailable } from "../lib/protectedData";
import { appAtomRegistry } from "./atom-registry";
import { environmentCatalog } from "../connection/catalog";
import { connectedEnvironmentIdsAtom } from "./presentation";
import { tessayaWorkSessions } from "./tessayaWorkSessions";

/** Her one environment on this phone (M-097): Tessaya screens read this, never a picker. */
export const { brainEnvironmentIdAtom, tessayaEnvironmentIdAtom } = createTessayaEnvironmentAtoms(
  connectedEnvironmentIdsAtom,
);

const CONNECT_WAIT_MS = 20_000;

/** Her brain and the machines this phone joined as one household, kept with its credentials. */
const STORE_KEY = "tessaya.household.v1";
interface SavedHousehold {
  readonly brain: EnvironmentId | null;
  readonly members: ReadonlyArray<EnvironmentId>;
}
let saved: SavedHousehold = { brain: null, members: [] };

const save = async (next: SavedHousehold) => {
  saved = next;
  appAtomRegistry.set(brainEnvironmentIdAtom, next.brain);
  try {
    await whenProtectedDataAvailable();
    await SecureStore.setItemAsync(STORE_KEY, JSON.stringify(next));
  } catch {
    // kept for this launch; the next pairing writes it again
  }
};

/** At launch: her brain as last learned, so Tessaya reads it before any pairing this launch. */
export function installHousehold(): () => void {
  void loadHousehold();
  return () => {};
}

async function loadHousehold(): Promise<void> {
  try {
    await whenProtectedDataAvailable();
    const raw = await SecureStore.getItemAsync(STORE_KEY);
    const value = raw === null ? null : (JSON.parse(raw) as Partial<SavedHousehold>);
    if (value === null) return;
    saved = {
      brain: typeof value.brain === "string" ? value.brain : null,
      members: Array.isArray(value.members)
        ? value.members.filter((m): m is EnvironmentId => typeof m === "string")
        : [],
    };
    appAtomRegistry.set(brainEnvironmentIdAtom, saved.brain);
  } catch {
    // none saved: she uses any connected machine of his until the next pairing
  }
}

/** Whether a saved machine is one of the household's (so "Remove" offers signing the phone out of all of them). */
export const inHousehold = (environmentId: EnvironmentId): boolean =>
  saved.members.includes(environmentId);

/**
 * "Sign this phone out of the household": every machine signs this phone out (through her brain), then the phone
 * forgets them all. The machines it could not reach first still drop it when the brain reaches them.
 */
export async function signOutOfHousehold(
  environmentId: EnvironmentId,
  forget: (environmentId: EnvironmentId) => Promise<unknown>,
): Promise<void> {
  await runAtomCommand(
    appAtomRegistry,
    tessayaWorkSessions.phoneSignOut,
    { environmentId, input: {} },
    { reportFailure: false },
  );
  for (const member of new Set([environmentId, ...saved.members])) await forget(member);
  await save({ brain: null, members: [] });
}

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
  const known = new Set<string>([
    environmentId,
    ...appAtomRegistry.get(environmentCatalog.catalogValueAtom).entries.keys(),
  ]);
  const notAdded: Array<string> = [];
  const members = new Set<EnvironmentId>([...saved.members, environmentId]);
  for (const l of issued.value.linked) if (known.has(l.environmentId)) members.add(l.environmentId);
  for (const next of householdToJoin(issued.value, known)) {
    const added = await pair(next.pairingUrl, next.environmentId);
    if (added.ok) members.add(next.environmentId);
    else notAdded.push(added.error ?? "not added");
  }
  // The household as it stands now: refreshed at every pairing.
  await save({ brain: issued.value.brain ?? saved.brain, members: [...members] });
  return notAdded;
}
