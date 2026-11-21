/**
 * After an answer the voice window stays open for a follow-up, with no wake word. Anything said in
 * the room then (a TV, a near-miss name) would be taken as a request. A follow-up is taken only when it
 * reads as addressed to Tessaya: a question, a command or request, a continuation of the topic, or the
 * name. A statement is let go in silence, and does not keep the window open.
 */

const OPENERS = new Set(
  (
    "what what's whats who whom whose where when why how which can could would will should shall " +
    "do does did is are was were am have has tell show open read send stop start run make find look " +
    "explain give list check close go create add remove delete set turn play pause repeat again next " +
    "summarise summarize remind schedule write type paste copy save search call ask let please yes " +
    "no yeah yep sure continue more also and then but so"
  ).split(" "),
);

const REQUEST =
  /^(?:i (?:want|need|would like|wanna|'d like|'d love)|i (?:wanted|needed|was hoping) (?:you to|to (?:ask|know|check|see|test|try|find out|hear))|i'd (?:like|love)|let's|let me|how about|what about)\b/;
const NAMED = /\b(?:tessaya|baton|assistant)\b/;

/** True when words said inside the follow-up window read as meant for the assistant. */
export const isAddressedFollowUp = (words: string): boolean => {
  const text = words.trim().toLowerCase().replace(/[’]/g, "'");
  if (text === "") return false;
  if (text.endsWith("?")) return true;
  if (NAMED.test(text)) return true;
  if (REQUEST.test(text)) return true;
  const first = text.split(/[^a-z']+/).find((w) => w !== "") ?? "";
  return OPENERS.has(first);
};

/** Openers that carry on a talk already going: fine in a follow-up, never a fresh request on their own (M-144). */
const CHATTER = new Set("yes no yeah yep sure continue more also and then but so".split(" "));

/**
 * A wake on the name model alone, no recogniser in time (M-144): its first turn is taken only as a fresh request to
 * her (a question, a request, a command, or led by her name), never chatter or talk about her.
 */
export const isFreshRequest = (words: string): boolean => {
  const text = words.trim().toLowerCase().replace(/[’]/g, "'");
  if (text === "") return false;
  if (text.endsWith("?") || REQUEST.test(text)) return true;
  const first = text.split(/[^a-z']+/).find((w) => w !== "") ?? "";
  return NAMED.test(first) || (OPENERS.has(first) && !CHATTER.has(first));
};
