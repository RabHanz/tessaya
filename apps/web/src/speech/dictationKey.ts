/** Whether the dictation key is held down now: a held key shows only the waveform, letting go is the commit. */
let held = false;
const listeners = new Set<() => void>();

export const noteDictationKey = (down: boolean) => {
  if (held === down) return;
  held = down;
  for (const listener of listeners) listener();
};
export const isDictationKeyHeld = () => held;
export const subscribeDictationKey = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
