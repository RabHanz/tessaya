import { liveSessionKey, runningLiveSessionKeys } from "@t3tools/tessaya-shared/liveThread";
import * as Schema from "effect/Schema";

import { useBatonFleet } from "../../batonFleetResolvers";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useBatonFleets } from "../../state/batonWorkSessions";

const LIVE_ONLY_KEY = "t3:baton:live-only";

/** T3's thread list with only live sessions (P5: one list, filtered), shared by the toggle and the list. */
export const useBatonLiveOnly = () => useLocalStorage(LIVE_ONLY_KEY, false, Schema.Boolean);

/** The live sessions running now on every connected computer, once for the whole list, from the fleets already read. */
export function useRunningLiveSessions(): ReadonlySet<string> {
  const fleets = useBatonFleets(useBatonFleet().environmentIds);
  return runningLiveSessionKeys(
    fleets.map(({ environmentId, fleet }) => ({
      environmentId,
      sessions: fleet?.claudeSessions ?? [],
    })),
  );
}

export const isRunningLive = (
  running: ReadonlySet<string>,
  thread: { readonly environmentId: string; readonly id: string },
): boolean => {
  const key = liveSessionKey(thread.environmentId, thread.id);
  return key !== null && running.has(key);
};

export const liveThreadsOnly = <T extends { readonly environmentId: string; readonly id: string }>(
  threads: readonly T[],
  liveOnly: boolean,
  running: ReadonlySet<string>,
): readonly T[] =>
  liveOnly ? threads.filter((thread) => isRunningLive(running, thread)) : threads;
