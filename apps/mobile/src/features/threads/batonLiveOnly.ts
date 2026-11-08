import { isLiveThreadId } from "@t3tools/baton-shared/liveThread";
import { useSyncExternalStore } from "react";

// T3's thread list with only live sessions (P5): one switch shared by the iOS pills, the Android menu and the list.
let liveOnly = false;
const listeners = new Set<() => void>();

export const setBatonLiveOnly = (on: boolean) => {
  liveOnly = on;
  for (const listener of listeners) listener();
};

export const getBatonLiveOnly = () => liveOnly;

export const useBatonLiveOnly = () =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => liveOnly,
  );

export const liveThreadsOnly = <T extends { readonly id: string }>(
  threads: ReadonlyArray<T>,
  on: boolean,
): ReadonlyArray<T> => (on ? threads.filter((thread) => isLiveThreadId(thread.id)) : threads);
