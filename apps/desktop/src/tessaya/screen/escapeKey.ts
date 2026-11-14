// @effect-diagnostics globalTimers:off
/**
 * Esc is one global key with several owners: a drive, a recording, a card on screen. Registering it
 * twice fails and unregistering drops everyone, so they share this list. One press goes to the most
 * urgent holder, so closing a card cannot lose a recording; the next press reaches the next. It is
 * his key again the moment the list is empty.
 */
export type EscapeRank = "drive" | "recording" | "card";
const URGENCY: Readonly<Record<EscapeRank, number>> = { drive: 2, recording: 1, card: 0 };
/** RegisterHotKey is checked as the injected key is processed, a moment after SendInput returns. */
const OWN_KEY_SETTLE_MS = 150;

export const createEscapeKey = (shortcut: {
  readonly register: (accelerator: string, callback: () => void) => unknown;
  readonly unregister: (accelerator: string) => void;
}) => {
  const holders: Array<{ readonly press: () => void; readonly urgency: number }> = [];
  /** Tessaya is sending Esc itself: a held hotkey would swallow it and stop the work that sent it. */
  let sending = 0;
  const pressed = () => {
    // Newest first among equals. One that throws must not cost him the stop behind it.
    const order = holders
      .map((holder, at) => ({ holder, at }))
      .sort((a, b) => b.holder.urgency - a.holder.urgency || b.at - a.at);
    for (const { holder } of order) {
      try {
        return holder.press();
      } catch {
        continue;
      }
    }
  };
  const hold = (onPress: () => void, rank: EscapeRank = "card"): (() => void) => {
    const holder = { press: () => onPress(), urgency: URGENCY[rank] };
    if (holders.length === 0 && sending === 0) shortcut.register("Escape", pressed);
    holders.push(holder);
    return () => {
      const at = holders.indexOf(holder);
      if (at < 0) return;
      holders.splice(at, 1);
      if (holders.length === 0 && sending === 0) shortcut.unregister("Escape");
    };
  };
  /** Runs `send` with the key let go, so the Esc it sends reaches the app under it. */
  const own = async <T>(send: () => Promise<T>): Promise<T> => {
    if (sending === 0 && holders.length > 0) shortcut.unregister("Escape");
    sending += 1;
    try {
      return await send();
    } finally {
      if (holders.length > 0) await new Promise((r) => setTimeout(r, OWN_KEY_SETTLE_MS));
      sending -= 1;
      if (sending === 0 && holders.length > 0) shortcut.register("Escape", pressed);
    }
  };
  return Object.assign(hold, { own });
};
