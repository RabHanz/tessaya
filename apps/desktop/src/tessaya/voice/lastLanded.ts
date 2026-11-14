/**
 * The last dictated words that landed (pasted, kept, on the clipboard, or left by a crash), for paste-last and Copy
 * last transcript. A spoken command or discarded words never land; words that look like a secret are never held.
 */
import { detectSecret } from "@t3tools/tessaya-shared/memory";

export const createLastLanded = () => {
  let last: string | null = null;
  return {
    /** True when the words were taken. */
    landed: (text: string): boolean => {
      if (detectSecret(text) !== null) return false;
      last = text;
      return true;
    },
    last: () => last,
    clear: () => {
      last = null;
    },
  };
};
