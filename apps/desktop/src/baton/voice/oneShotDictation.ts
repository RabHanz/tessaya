import { settleOneShot } from "@t3tools/baton-shared/dictationOneShot";

/**
 * Spoken dictation all at once, however long: chunks are kept (and saved after each one, so a
 * crash or a failed paste loses nothing), tidied as one, fitted to the caret and inserted when
 * speech ends. A tidy-up that fails or times out inserts what was heard.
 */
export interface OneShotIo<App> {
  readonly save: (chunks: ReadonlyArray<string>) => void;
  /** `level`: the clean-up level it used, kept on the History row so a retry never goes above it. */
  readonly clean: (
    raw: string,
    app: App,
  ) => Promise<{ readonly text: string; readonly stage: string; readonly level?: string } | null>;
  readonly fit: (text: string, app: App) => Promise<string>;
  readonly paste: (text: string, app: App) => Promise<boolean>;
}

export interface OneShotResult {
  readonly status: "empty" | "pasted" | "kept";
  /** What went (or would go) into the field. */
  readonly text: string;
  /** The tidy-up failed, so this is what was heard. */
  readonly failed: boolean;
  /** The words as heard, joined. */
  readonly raw: string;
  /** The clean-up level used, when the clean-up said. */
  readonly level?: string;
}

export const createOneShot = <App>(io: OneShotIo<App>) => {
  const chunks: Array<string> = [];
  /** Chunks ever pushed and ever taken out: a flush owns the ones pushed before it was asked for. */
  let pushed = 0;
  let released = 0;
  /** Flushes run one at a time: two dictations ending close together each paste once, into their own window. */
  let tail: Promise<unknown> = Promise.resolve();
  /** Takes the first `n` chunks out. */
  const release = (n: number) => {
    const k = Math.min(n, chunks.length);
    chunks.splice(0, k);
    released += k;
    io.save(chunks);
  };
  return {
    push: (text: string) => {
      chunks.push(text);
      pushed += 1;
      io.save(chunks);
    },
    pending: (): ReadonlyArray<string> => chunks,
    discard: () => release(chunks.length),
    release,
    /**
     * Tidies, fits and pastes into `app` the chunks pushed before this call, after any flush asked for earlier.
     * `taken` is how many it owns; on "kept" they stay until the caller releases them (it does, before the next runs).
     */
    flush: (app: App): Promise<OneShotResult & { readonly taken: number }> => {
      const end = pushed;
      const run = tail.then(async () => {
        const taken = Math.max(0, Math.min(chunks.length, end - released));
        const raw = chunks.slice(0, taken).join(" ").trim();
        if (raw.length === 0) {
          release(taken);
          return { status: "empty" as const, text: "", raw: "", failed: false, taken };
        }
        const cleaned = await io.clean(raw, app).catch(() => null);
        const { text, failed } = settleOneShot(raw, cleaned);
        const fitted = await io.fit(text, app).catch(() => text);
        const pasted = await io.paste(fitted, app).catch(() => false);
        // The chunks stay on disk until the paste has landed; words of a newer dictation stay after them.
        if (pasted) release(taken);
        return {
          status: pasted ? ("pasted" as const) : ("kept" as const),
          text: fitted,
          raw,
          failed,
          taken,
          ...(cleaned?.level === undefined ? {} : { level: cleaned.level }),
        };
      });
      tail = run.catch(() => undefined);
      return run;
    },
  };
};
