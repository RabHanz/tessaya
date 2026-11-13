/**
 * Whether a room turn was said to her: a persona's name leading or closing what he said, as the recogniser spells it
 * from across the room. Everything else in the room (his dictation, a call, the TV) is not hers to answer.
 * @module baton-voice/room/addressing
 */
import { wakeWordHeard, wakeWordLead } from "@t3tools/baton-shared/wakeVerify";

/** His "Tessaya" on its own, as the R1 hears it: "Say yeah.", "You say ya?" (12 Nov), "To say uh" (13 Nov). */
const TESSAYA_ALONE = /^(?:you |to |tuh )?say (?:yeah|ya|yah|uh)$/;
/** The same, leading a sentence with a comma after it: "To say uh, can you hear me?" (13 Nov). */
const TESSAYA_LEAD = /^(?:to|tuh) say,? (?:yeah|ya|yah|uh),/i;

/** The name he called her by, from `names` (the first is the lead), or null when he did not call one. */
export const calledName = (text: string, names: ReadonlyArray<string>): string | null => {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lead = names.find((n) => wakeWordLead(words, [n]) > 0);
  if (lead !== undefined) return lead;
  const plain = text
    .toLowerCase()
    .replace(/[^a-z ]/g, "")
    .trim();
  if ((TESSAYA_ALONE.test(plain) || TESSAYA_LEAD.test(text.trim())) && names[0] !== undefined)
    return names[0];
  return names.find((n) => wakeWordHeard(text, n)) ?? null;
};

/** He is done with her for now: no follow-up window after her reply, only her name or S2 wakes her. */
export const isDismissal = (text: string): boolean =>
  /\b(?:dismiss(?:ed)?|that'?s all|that will be all|that'?ll be all|go to sleep|goodbye|good night|stop listening)\b/i.test(
    text,
  );

/** A bare "yes", "okay" or "yeah": an answer to her, or the room's chatter when she asked nothing (19:05, 12 Nov). */
export const isBackchannel = (text: string): boolean =>
  /^(?:yes|yeah|yep|yup|yah|no|nope|okay|ok|right|sure|alright|all right|mm+|hmm+|uh huh)[.!?]*$/i.test(
    text.trim(),
  );

/** Her reply asks him something or hands him a next step, so his answer may take longer to come. */
export const invitesReply = (said: string): boolean =>
  /\?\s*$/.test(said.trim()) ||
  /\b(?:you'?d need to|you need to|could you|would you|do you want|shall i|should i|want me to|say (?:it|that) again|let me know)\b/i.test(
    said,
  );

const words = (text: string) =>
  text
    .toLowerCase()
    .replace(/ise\b/g, "ize")
    .replace(/[^a-z0-9' ]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

/**
 * Whether what the R1 heard is her own voice coming back through its mic (firmware 0.3.33 has no working echo
 * cancellation): the heard words, mostly in order, inside what she has just been saying. One word must match exactly.
 */
export const isOwnVoice = (heard: string, herLines: ReadonlyArray<string>): boolean => {
  const h = words(heard);
  if (h.length === 0) return false;
  const need = h.length === 1 ? 1 : Math.ceil(h.length * 0.75);
  return herLines.some((line) => {
    const her = words(line);
    for (let start = 0; start < her.length; start += 1) {
      let at = start;
      let hit = 0;
      for (const w of h) {
        const found = her.indexOf(w, at);
        if (found >= 0 && found - at <= 1) {
          hit += 1;
          at = found + 1;
        }
      }
      if (hit >= need) return true;
    }
    return false;
  });
};

/** Words a sentence does not end on: "Is it possible to", "Like the", "Pages because" (13 Nov) were him pausing. */
const UNFINISHED =
  /\b(?:to|the|a|an|and|or|but|because|if|of|for|with|my|your|our|their|whose|can|could|would|should|will|shall|need|needs|want|wants|gonna|wanna)$/i;

/** He stopped mid-sentence: what he says next belongs to it, so it is not answered on its own. */
export const isUnfinished = (text: string): boolean => {
  const t = text.trim();
  return !/[?!]$/.test(t) && UNFINISHED.test(t.replace(/[.,;:…\s]+$/, ""));
};

/** What a log may keep of a line that was not for her: its length and a short hash, never its words. */
export const heldBack = (text: string): string => {
  let h = 0x811c9dc5;
  for (const c of text) h = Math.imul(h ^ c.codePointAt(0)!, 0x01000193) >>> 0;
  const n = text.trim().split(/\s+/).filter(Boolean).length;
  return `${n} word${n === 1 ? "" : "s"}, #${h.toString(16).padStart(8, "0")}`;
};
