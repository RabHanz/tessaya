/**
 * How long anything stays on screen. Pure, because "never gone mid-sentence" is a rule and this is
 * where it is kept (D111). Rates: 230 words a minute reading aloud-in-the-head, plus time to look over.
 */
const MS_PER_WORD = 260;
const LOOK_OVER_MS = 1_200;
const MIN_READ_MS = 3_000;
/** farzaa/clicky holds 3 s after its bubble finishes; that is the floor here too. */
export const AFTER_SPEECH_MS = 3_000;
/** About six lines of the card. A longer answer turns over rather than shrinking or scrolling. */
const PAGE_CHARS = 420;

export const readingMs = (text: string): number => {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(MIN_READ_MS, words * MS_PER_WORD + LOOK_OVER_MS);
};

/** What is left to hold once speech has ended: he may be a slower reader than the voice. */
export const holdAfterSpeechMs = (text: string, spokenMs: number): number =>
  Math.max(AFTER_SPEECH_MS, readingMs(text) - spokenMs);

/** The answer in card-sized pages, broken between sentences wherever one fits. */
export const pageText = (text: string, chars: number = PAGE_CHARS): ReadonlyArray<string> => {
  const sentences = text.trim().match(/[^.!?…\n]+[.!?…]*[\s]*|\n+/g) ?? [];
  const pages: string[] = [];
  let page = "";
  for (const sentence of sentences) {
    if (page.length > 0 && page.length + sentence.length > chars) {
      pages.push(page.trim());
      page = "";
    }
    page += sentence;
  }
  if (page.trim().length > 0) pages.push(page.trim());
  return pages.length > 0 ? pages : [text];
};

/**
 * Every sentence reaches the speaker the moment it exists, so a cancel can reach it. Chaining the
 * calls instead hid the waiting sentences from cancel, and they played on after a stop.
 */
export const queueSpeech = (speak: (text: string) => Promise<void>) => {
  let last: Promise<void> = Promise.resolve();
  let pending = 0;
  return {
    /** `onStart` runs as this sentence begins to sound: when everything before it has finished. */
    add: (text: string, onStart?: () => void): void => {
      pending += 1;
      if (onStart !== undefined) void last.then(onStart);
      const said = speak(text)
        .catch(() => undefined)
        .finally(() => (pending -= 1));
      last = Promise.all([last, said]).then(() => undefined);
    },
    finished: (): Promise<void> => last,
    busy: (): boolean => pending > 0,
  };
};
