import { LIVE_INSTANCE, isLiveThreadId } from "@t3tools/tessaya-shared/liveThread";
import { useSyncExternalStore } from "react";

// T3's thread list with only live sessions (P5): one switch shared by the iOS pills, the Android menu and the list.
let liveOnly = false;
const listeners = new Set<() => void>();

export const setTessayaLiveOnly = (on: boolean) => {
  liveOnly = on;
  for (const listener of listeners) listener();
};

export const useTessayaLiveOnly = () =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => liveOnly,
  );

type LiveCandidate = {
  readonly environmentId: string;
  readonly id: string;
  readonly providerInstanceId: string;
  readonly archivedAt: string | null;
};

/**
 * The live sessions running now, once for the whole list. The phone reads no fleet, so it goes by what the mirror
 * already writes: a session that ended has its thread archived, and one handed on has left the live instance.
 * shortcut: a thread he unarchived after its session ended still counts; the fleet's claudeSessions would settle it.
 */
export const runningLiveThreads = (threads: ReadonlyArray<LiveCandidate>): ReadonlySet<string> =>
  new Set(
    threads
      .filter(
        (t) =>
          isLiveThreadId(t.id) && t.providerInstanceId === LIVE_INSTANCE && t.archivedAt === null,
      )
      .map((t) => `${t.environmentId}:${t.id}`),
  );

export const isRunningLive = (
  running: ReadonlySet<string>,
  thread: { readonly environmentId: string; readonly id: string },
) => running.has(`${thread.environmentId}:${thread.id}`);

export const liveThreadsOnly = <T extends LiveCandidate>(
  threads: ReadonlyArray<T>,
  on: boolean,
): ReadonlyArray<T> => {
  if (!on) return threads;
  const running = runningLiveThreads(threads);
  return threads.filter((thread) => isRunningLive(running, thread));
};
