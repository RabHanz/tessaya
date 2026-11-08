import { settleOneShot } from "@t3tools/baton-shared/dictationOneShot";

/**
 * Spoken dictation all at once, however long: chunks are kept (and saved after each one, so a
 * crash or a failed paste loses nothing), tidied as one, fitted to the caret and inserted when
 * speech ends. A tidy-up that fails or times out inserts what was heard.
 */
export interface OneShotIo {
  readonly save: (chunks: ReadonlyArray<string>) => void;
  readonly clean: (
    raw: string,
  ) => Promise<{ readonly text: string; readonly stage: string } | null>;
  readonly fit: (text: string) => Promise<string>;
  readonly paste: (text: string) => Promise<boolean>;
  /** Shows what the tidy-up kept of what he said, and resolves when it is time to paste. */
  readonly preview?: (raw: string, text: string) => Promise<void>;
}

export interface OneShotResult {
  readonly status: "empty" | "pasted" | "kept";
  /** What went (or would go) into the field. */
  readonly text: string;
  /** The tidy-up failed, so this is what was heard. */
  readonly failed: boolean;
}

export const createOneShot = (io: OneShotIo) => {
  const chunks: Array<string> = [];
  /** Takes the first `n` chunks out: a flush owns only what was there when it began. */
  const release = (n: number) => {
    chunks.splice(0, n);
    io.save(chunks);
  };
  return {
    push: (text: string) => {
      chunks.push(text);
      io.save(chunks);
    },
    pending: (): ReadonlyArray<string> => chunks,
    discard: () => release(chunks.length),
    release,
    /** `taken` is how many chunks this flush owns; on "kept" they stay until the caller releases them. */
    flush: async (): Promise<OneShotResult & { readonly taken: number }> => {
      const taken = chunks.length;
      const raw = chunks.slice(0, taken).join(" ").trim();
      if (raw.length === 0) {
        release(taken);
        return { status: "empty", text: "", failed: false, taken };
      }
      const cleaned = await io.clean(raw).catch(() => null);
      const { text, failed } = settleOneShot(raw, cleaned);
      const fitted = await io.fit(text).catch(() => text);
      await io.preview?.(raw, fitted).catch(() => undefined);
      const pasted = await io.paste(fitted).catch(() => false);
      // The chunks stay on disk until the paste has landed; words of a newer dictation stay after them.
      if (pasted) release(taken);
      return { status: pasted ? "pasted" : "kept", text: fitted, failed, taken };
    },
  };
};
