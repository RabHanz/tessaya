/** How long the field a dictation went to is watched for his fixes, and how often it is read (DICT-WISPR). */
export const WATCH_MS = 60_000;
export const WATCH_EVERY_MS = 2_000;

/**
 * Reads the words before the caret after a paste until a fix has settled (two reads alike, so a word half typed is
 * never learned), focus leaves the window, the field cannot be read or a read times out (a secret field reads as
 * null), the pasted words are no longer there (`ours`), or time is up.
 * `learn` says whether the settled text taught anything; the first that does ends the watch.
 */
export const watchField = async (input: {
  readonly reads: number;
  /** Waits for the next read; false when a newer dictation took over. */
  readonly wait: () => Promise<boolean>;
  readonly stillThere: () => Promise<boolean>;
  readonly read: () => Promise<string | null>;
  readonly ours: (before: string) => boolean;
  readonly learn: (before: string) => boolean;
}): Promise<"learned" | "left" | "unreadable" | "moved on" | "cancelled" | "done"> => {
  let last: string | null = null;
  for (let i = 0; i < input.reads; i += 1) {
    if (!(await input.wait())) return "cancelled";
    if (!(await input.stillThere())) return "left";
    const before = await input.read();
    if (before === null) return "unreadable";
    if (!input.ours(before)) return "moved on";
    if (before === last && input.learn(before)) return "learned";
    last = before;
  }
  return "done";
};

const wordsOf = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/**
 * The words before the caret still end with the pasted words, as said or as he fixed them: most of them are among
 * the last few words there. Once they are not, he has moved on and the watch ends.
 */
export const stillOurs = (pasted: string, before: string): boolean => {
  const said = wordsOf(pasted);
  const near = new Set(wordsOf(before).slice(-(said.length + 2)));
  return said.length > 0 && said.filter((w) => near.has(w)).length * 2 >= said.length;
};
