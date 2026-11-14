/* oxlint-disable t3code/no-low-value-comments -- Baton file predating upstream's rule (D82) */
/**
 * Explicit activation: keys that wake Baton without a wake word.
 *
 * These are also Airdeck's seam (D64, D65). Airdeck profiles already have a
 * `"keys"` action, so a remote button bound to one of these chords wakes,
 * toggles or mutes Baton with no Airdeck code change. Chosen clear of
 * Airdeck's own Ctrl+Alt+Shift+F9…F12. Dictation's toggle is F8 here: the remote's mic button
 * is a tap, not a hold, so it cannot drive the hold key.
 */
import type { VoiceActivation } from "./voiceTypes.ts";

export const VOICE_HOTKEYS: ReadonlyArray<{
  readonly accelerator: string;
  /** The same chord in Airdeck's profile syntax. */
  readonly airdeckKeys: string;
  readonly activation: VoiceActivation;
}> = [
  { accelerator: "Control+Alt+Shift+F5", airdeckKeys: "ctrl+alt+shift+f5", activation: "wake" },
  {
    accelerator: "Control+Alt+Shift+F6",
    airdeckKeys: "ctrl+alt+shift+f6",
    activation: "toggle_direct_session",
  },
  {
    accelerator: "Control+Alt+Shift+F7",
    airdeckKeys: "ctrl+alt+shift+f7",
    activation: "toggle_mute",
  },
];

export const DICTATION_TOGGLE_HOTKEY = {
  accelerator: "Control+Alt+Shift+F8",
  airdeckKeys: "ctrl+alt+shift+f8",
} as const;
