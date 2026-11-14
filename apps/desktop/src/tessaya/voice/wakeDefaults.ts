/**
 * Wake words a settings file starts with (D135). A fresh install gets the public set. A settings
 * file that already exists but has no wake-word list was written before the list was saved, when
 * Freya was on, so it keeps that set: an update never turns a word off for someone who had it.
 */
import type { WakeWordSetting } from "./desktopVoiceCore.ts";

// Thresholds measured on 6.6 hours of real speech and held-out en-GB voices (D98).
const SEBASTIAN = { word: "Sebastian", enabled: true, threshold: 0.97 };
const ALFRED = { word: "Alfred", enabled: true, threshold: 0.9 };
// Off: as an ordinary word in speech it wakes too easily (D98).
const ONYX = { word: "Onyx", enabled: false, threshold: 0.9 };

// A fresh install wakes to Tessaya, Alfred and Freya; any number can be on, his choice. Each word on adds its own
// false wakes, which the text check after a wake removes. Sebastian answers to his name in text until his false
// wakes are measured.
export const FRESH_WAKE_WORDS: ReadonlyArray<WakeWordSetting> = [
  { word: "Tessaya", enabled: true, threshold: 0.99 },
  { ...SEBASTIAN, enabled: false },
  { word: "Alfred", enabled: true, threshold: 0.95 },
  { word: "Freya", enabled: true, threshold: 0.95 },
  { word: "Onyx", enabled: false, threshold: 0.95 },
];

const LEGACY_WAKE_WORDS: ReadonlyArray<WakeWordSetting> = [
  SEBASTIAN,
  ALFRED,
  { word: "Freya", enabled: true, threshold: 0.95 },
  ONYX,
];

/** Which default set an install has been given. Raised when the defaults grow; each install gets them once. */
export const WAKE_DEFAULTS = 1;

/**
 * `saved` is the parsed settings file, or null when there is none. A file not yet given this default set
 * gets its words turned on once (added where missing, his thresholds kept); a word he turns off afterwards
 * stays off, because the file then records `wakeDefaults`.
 */
export const wakeWordsFor = (saved: unknown): ReadonlyArray<WakeWordSetting> => {
  if (typeof saved !== "object" || saved === null) return FRESH_WAKE_WORDS;
  const words = Array.isArray((saved as { wakeWords?: unknown }).wakeWords)
    ? (saved as { wakeWords: ReadonlyArray<WakeWordSetting> }).wakeWords
    : LEGACY_WAKE_WORDS;
  if ((saved as { wakeDefaults?: unknown }).wakeDefaults === WAKE_DEFAULTS) return words;
  const on = FRESH_WAKE_WORDS.filter((d) => d.enabled);
  const isDefault = (w: WakeWordSetting) => on.some((d) => d.word === w.word);
  return [
    ...words.map((w) => (isDefault(w) ? { ...w, enabled: true } : w)),
    ...on.filter((d) => !words.some((w) => w.word === d.word)),
  ];
};
