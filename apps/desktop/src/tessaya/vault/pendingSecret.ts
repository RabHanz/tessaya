/** A secret he just said, held in this process only (never written) until he says whether it goes in the vault (D151). */
const HOLD_MS = 5 * 60_000;

export interface PendingSecret {
  readonly set: (text: string, at: number) => void;
  readonly peek: (at: number) => string | null;
  readonly clear: () => void;
}

export const createPendingSecret = (): PendingSecret => {
  let held: { text: string; at: number } | null = null;
  return {
    set: (text, at) => void (held = { text, at }),
    peek: (at) => (held !== null && at - held.at < HOLD_MS ? held.text : null),
    clear: () => void (held = null),
  };
};

/** The one the window and the assistant share. */
export const pendingSecret = createPendingSecret();
