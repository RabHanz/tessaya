/**
 * A prosody front-end for a voice that has none of its own (Pocket): a sentence that follows another in the same reply
 * starts with a soft breath when it is long enough to need one, and a short pause otherwise. Picked over plain Pocket in
 * the bake-off (drafts/tts-bakeoff); Gemini plans its own breathing, so a cloud voice is left alone.
 */
import type { SpeechPiece } from "./interjections.ts";

/** A sentence this long or longer takes a breath first. */
export const BREATH_MIN_WORDS = 8;
export const BREATH_MS = 170;
export const SHORT_PAUSE_MS = 90;

export const withProsody = (
  pieces: ReadonlyArray<SpeechPiece>,
  context: { readonly continuing: boolean; readonly engine?: "pocket" | "gemini" },
): ReadonlyArray<SpeechPiece> => {
  if (!context.continuing || context.engine === "gemini" || pieces[0]?.kind !== "text")
    return pieces;
  const words = pieces
    .flatMap((p) => (p.kind === "text" ? p.text.split(/\s+/) : []))
    .filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  const lead: SpeechPiece =
    words >= BREATH_MIN_WORDS
      ? { kind: "sound", nonverbal: "breath", sound: { kind: "breath", ms: BREATH_MS } }
      : { kind: "sound", nonverbal: "gesture", sound: { kind: "pause", ms: SHORT_PAUSE_MS } };
  return [lead, ...pieces];
};
