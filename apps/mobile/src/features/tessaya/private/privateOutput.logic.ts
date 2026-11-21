/** Where the phone's audio goes now, as T3PhoneAudio reports it; null where the module isn't in this build. */
export type AudioOutput =
  | "bluetooth-hfp"
  | "bluetooth-a2dp"
  | "bluetooth-le"
  | "wired"
  | "speaker"
  | "receiver"
  | "other";

/**
 * Whether her private voice may play here (M-133): always into headphones, and out loud only when her brain is sure
 * he is alone. An unknown route counts as the loudspeaker.
 */
export const privateSoundAllowed = (
  output: AudioOutput | null,
  presence: "alone" | "others" | "unknown",
): boolean =>
  output === "wired" || output?.startsWith("bluetooth") === true || presence === "alone";
