/**
 * Wake words a settings file starts with (D135). A fresh install gets the public set. A settings
 * file that already exists but has no wake-word list was written before the list was saved, when
 * Freya was on, so it keeps that set: an update never turns a word off for someone who had it.
 */
import { WAKE_WORDS } from "@t3tools/tessaya-shared/wakeWords";

import type { WakeWordSetting } from "./desktopVoiceCore.ts";

// A fresh install wakes to Tessaya, Alfred and Freya; any number can be on, his choice. Each word on adds its own
// false wakes, which the text check after a wake removes. Sebastian answers to his name in text until his false
// wakes are measured.
export const FRESH_WAKE_WORDS: ReadonlyArray<WakeWordSetting> = WAKE_WORDS.map((w) => ({
  word: w.word,
  enabled: w.onByDefault,
  threshold: w.threshold,
}));

// What a settings file from before the list was saved held: frozen, whatever the table says now.
const LEGACY_WAKE_WORDS: ReadonlyArray<WakeWordSetting> = [
  { word: "Sebastian", enabled: true, threshold: 0.97 },
  { word: "Alfred", enabled: true, threshold: 0.9 },
  { word: "Freya", enabled: true, threshold: 0.95 },
  { word: "Onyx", enabled: false, threshold: 0.9 },
];

// Defaults the table shipped before (Alfred 0.95 until 20 Nov): a saved threshold still equal to one was never his
// choice, so it follows the table; any other value he set stays.
const RETIRED_DEFAULTS: Readonly<Record<string, ReadonlyArray<number>>> = { Alfred: [0.95] };
const followTable = (w: WakeWordSetting): WakeWordSetting => {
  const now = FRESH_WAKE_WORDS.find((d) => d.word === w.word)?.threshold;
  return now !== undefined && RETIRED_DEFAULTS[w.word]?.includes(w.threshold) === true
    ? { ...w, threshold: now }
    : w;
};

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
  if ((saved as { wakeDefaults?: unknown }).wakeDefaults === WAKE_DEFAULTS)
    return words.some((w) => followTable(w) !== w) ? words.map(followTable) : words;
  const on = FRESH_WAKE_WORDS.filter((d) => d.enabled);
  const isDefault = (w: WakeWordSetting) => on.some((d) => d.word === w.word);
  return [
    ...words.map((w) => followTable(isDefault(w) ? { ...w, enabled: true } : w)),
    ...on.filter((d) => !words.some((w) => w.word === d.word)),
  ];
};
