import type { HerPhase } from "@t3tools/tessaya-shared/island";
import { useSyncExternalStore } from "react";

// shortcut: her phase on this phone only (Talk's voice controller); a turn she takes on another vessel shows there
let phase: HerPhase = "idle";
const listeners = new Set<() => void>();

export const setHerPhase = (next: HerPhase) => {
  if (next === phase) return;
  phase = next;
  for (const l of listeners) l();
};

/** Each change of her phase here, for a timer outside React. */
export const onHerPhase = (l: (next: HerPhase) => void) => {
  const f = () => l(phase);
  listeners.add(f);
  return () => void listeners.delete(f);
};

export const useHerPhase = () =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => phase,
  );
