import type { SpeechStreamText } from "@t3tools/contracts";

// His words heard so far by a live capture (liveCapture.ts), for the composer and Talk.
let words: SpeechStreamText | null = null;
const listeners = new Set<() => void>();
export const setLiveWords = (next: SpeechStreamText | null) => {
  words = next;
  for (const listener of listeners) listener();
};
export const subscribeLiveWords = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
export const getLiveWords = () => words;
