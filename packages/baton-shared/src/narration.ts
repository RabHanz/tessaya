/**
 * Her reasoning written out as text, which a voice must never say (13 Nov R1 audit: "I should ask rather than guess",
 * "I'll ask him what he meant", "I'll keep it short"). She speaks to him as "you"; a sentence about "him", "the
 * conversation" or what she is about to do is her thinking aloud, not her reply.
 */
const NARRATION = [
  // Him in the third person, as the subject of her thinking.
  /\b(?:ask|tell|answer|remind|check with|reply to|respond to) him\b/i,
  /\bwhat (?:he|the director) (?:means?|meant|wants?|wanted|said|asked|is asking|was asking)\b/i,
  /\bthe (?:director|user)\b/i,
  // The conversation or his words as a thing she weighs.
  /\b(?:in|from) the conversation\b/i,
  /\b(?:the|his|this) (?:request|utterance|transcript|message) (?:is|was|seems|looks|sounds)\b/i,
  /\bmake sense as a request\b/i,
  /\bstray fragment\b/i,
  /^(?:'[^']+'|"[^"]+"|“[^”]+”) (?:is|was|sounds|seems|looks) (?:unclear|ambiguous|like)\b/i,
  // What she is about to do, said as a plan.
  /^(?:so )?i(?: should| need to| ought to| must)(?: probably)? (?:ask|clarify|confirm|keep|respond|reply|answer|avoid|not (?:guess|act|touch))\b/i,
  /^(?:so )?i(?:'ll|’ll| will) (?:keep (?:it|this) (?:short|brief)|clarify|respond)\b/i,
  /^let me (?:think|consider|work out|figure out)\b/i,
];

/** One sentence of hers is reasoning, not something to say to him. */
export const isNarration = (sentence: string): boolean => {
  const s = sentence.trim().replace(/^[…\s]+/, "");
  return s !== "" && NARRATION.some((r) => r.test(s));
};
