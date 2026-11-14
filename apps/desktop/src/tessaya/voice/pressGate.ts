// @effect-diagnostics globalTimers:off
/**
 * The hold key's pill waits until the key has been down `delayMs`: a tap shorter than that shows nothing at all, while
 * the microphone still opens at once so the first word is never lost. A recording that came without a press (the
 * hands-free key, a mouse button, an older helper) shows at once.
 */
export const createPressGate = (delayMs: number, show: () => void) => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** True when it stopped a pill that had not shown yet. */
  const cancel = () => {
    const pending = timer !== null;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    return pending;
  };
  return {
    press: () => {
      cancel();
      timer = setTimeout(() => {
        timer = null;
        show();
      }, delayMs);
    },
    /** The recording wants the pill: now, unless a press is still inside its delay (the timer shows it then). */
    want: () => {
      if (timer === null) show();
    },
    /** The press ended (a tap, or the recording ended): a pill not yet shown never shows. */
    cancel,
  };
};
