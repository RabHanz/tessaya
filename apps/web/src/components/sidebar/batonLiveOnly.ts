import * as Schema from "effect/Schema";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { isLiveThreadId } from "@t3tools/baton-shared/liveThread";

const LIVE_ONLY_KEY = "t3:baton:live-only";

/** T3's thread list with only live sessions (P5: one list, filtered), shared by the toggle and the list. */
export const useBatonLiveOnly = () => useLocalStorage(LIVE_ONLY_KEY, false, Schema.Boolean);

export const liveThreadsOnly = <T extends { readonly id: string }>(
  threads: readonly T[],
  liveOnly: boolean,
): readonly T[] => (liveOnly ? threads.filter((thread) => isLiveThreadId(thread.id)) : threads);
