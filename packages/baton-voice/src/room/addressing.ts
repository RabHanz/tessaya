/**
 * Whether a room turn was said to her: a persona's name leading or closing what he said, as the recogniser spells it
 * from across the room. Everything else in the room (his dictation, a call, the TV) is not hers to answer.
 * @module baton-voice/room/addressing
 */
import { wakeWordHeard, wakeWordLead } from "@t3tools/baton-shared/wakeVerify";

/** His "Tessaya" on its own, as the R1 hears it: "Say yeah.", "You say ya?" (12 Nov). */
const TESSAYA_ALONE = /^(?:you |to |tuh )?say (?:yeah|ya|yah)$/;

/** The name he called her by, from `names` (the first is the lead), or null when he did not call one. */
export const calledName = (text: string, names: ReadonlyArray<string>): string | null => {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lead = names.find((n) => wakeWordLead(words, [n]) > 0);
  if (lead !== undefined) return lead;
  const plain = text
    .toLowerCase()
    .replace(/[^a-z ]/g, "")
    .trim();
  if (TESSAYA_ALONE.test(plain) && names[0] !== undefined) return names[0];
  return names.find((n) => wakeWordHeard(text, n)) ?? null;
};

/** He is done with her for now: no follow-up window after her reply, only her name or S2 wakes her. */
export const isDismissal = (text: string): boolean =>
  /\b(?:dismissed|that'?s all|that will be all|that'?ll be all|go to sleep|goodbye|good night|stop listening)\b/i.test(
    text,
  );
