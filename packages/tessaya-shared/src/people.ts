/**
 * What she is told about the voice she is talking to (HOUSEHOLD-DESIGN §11): shared, so the room eval reads the line
 * the server gives.
 * @module tessaya-shared/people
 */

export type PersonStatus = "member" | "guest" | "unknown" | "not_person";

export interface PersonView {
  readonly name: string | null;
  readonly status: PersonStatus;
  /** "the owner's cousin", "Sara's sister", "was at the party": household facts from his memory. */
  readonly relations: ReadonlyArray<string>;
  readonly firstSeen: string | null;
  readonly lastSeen: string | null;
  /** What they said when last heard, newest first. */
  readonly topics: ReadonlyArray<{ readonly at: string; readonly said: string }>;
  readonly impression: string | null;
}

const day = (iso: string | null): string => (iso === null ? "" : iso.slice(0, 10));

/**
 * What she is told about the voice she is talking to, for that person's own turn: who they are, how she knows them,
 * what they talked about last time and her own impression (MA-021), never to be read out. Empty for a non-person.
 */
export const turnLineFor = (
  p: PersonView,
  options: { readonly recognised: boolean; readonly askName: boolean },
): string => {
  if (p.status === "not_person")
    return "This voice is most likely a TV, radio or recording, not someone in the room: answer only if it clearly asks you something.";
  if (p.name === null)
    return options.askName
      ? "You don't know this voice yet: someone new. Unless they are in the middle of asking you to do something, end this reply by asking their name warmly, once, for example \"I don't think we've met. What's your name?\" When they tell you, or introduce themselves, call people_introduce with it. Don't ask again if they'd rather not say."
      : "You don't know this voice: someone new. Don't ask their name.";
  const parts = [
    options.recognised
      ? `You know this voice: it is ${p.name}.`
      : `They say they are ${p.name}, but their voice doesn't match the ${p.name} you know: call them ${p.name}, and share nothing from ${p.name}'s past conversations.`,
  ];
  if (!options.recognised) return parts.join(" ");
  if (p.relations.length > 0) parts.push(`${p.name}: ${p.relations.join("; ")}.`);
  if (p.firstSeen !== null) parts.push(`You first heard them on ${day(p.firstSeen)}.`);
  const last = p.topics.slice(0, 3);
  if (last.length > 0)
    parts.push(
      `Last time (${day(last[0]!.at)}) they said: ${last.map((t) => `"${t.said.slice(0, 120)}"`).join("; ")}.`,
    );
  if (p.impression !== null && p.impression.trim() !== "")
    parts.push(
      `Your own impression of them, for you only, never to be said: ${p.impression.trim().slice(0, 200)}.`,
    );
  parts.push("Greet them by name, as someone you know, naturally; don't recite this.");
  return parts.join(" ");
};
