export type MicAwake = "off" | "15m" | "always";

const AWAKE_MS: Readonly<Record<MicAwake, number>> = {
  off: 0,
  "15m": 15 * 60_000,
  // The helper reads a whole number of ms; this is about 24 days, longer than any session runs.
  always: 2 ** 31,
};

export const micAwakeOf = (saved: unknown): MicAwake =>
  saved === "off" || saved === "always" ? saved : "15m";

/**
 * How long the helper holds his microphone open after a dictation, so the next press starts at once: his Scarlett took
 * 0.7 to 0.9 s to wake after a long idle (2026-11-12). Never in quiet hours, when the mic light should be off.
 */
export const micAwakeMs = (setting: MicAwake, quiet: boolean): number =>
  quiet ? 0 : AWAKE_MS[setting];
