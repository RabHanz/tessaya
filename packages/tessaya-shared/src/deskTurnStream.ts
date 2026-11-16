/** A persona layer's tone for the reply that follows: its voice's affect clip says the whole line (VOXTA I5). */
export interface DeskAffect {
  readonly affect: string;
}
/** A group turn (M-021): the words that follow are this persona's, in its own voice and face. */
export interface DeskSpeaker {
  readonly persona: string;
}
/** What a desk turn streams: her words, at most one affect before them, and in a group who speaks. */
export type DeskSaid = string | DeskAffect | DeskSpeaker;

/** One server-sent event of a desk turn. */
export const deskEvent = (said: DeskSaid): string =>
  `data: ${JSON.stringify(typeof said === "string" ? { words: said } : said)}\n\n`;

/**
 * Her words from the server's desk turn (`/tessaya/desk/turn`): `data: {"words"}` events, and a layer's
 * `data: {"affect"}` and a group's `data: {"persona"}`, until `data: [DONE]`.
 */
export const readDeskTurn = async (
  body: ReadableStream<Uint8Array>,
  onWords: (words: string) => void,
  onAffect?: (affect: string) => void,
  onSpeaker?: (persona: string) => void,
): Promise<void> => {
  const decoder = new TextDecoder();
  let held = "";
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    held += decoder.decode(chunk, { stream: true });
    let end = held.indexOf("\n\n");
    while (end >= 0) {
      const event = held.slice(0, end);
      held = held.slice(end + 2);
      end = held.indexOf("\n\n");
      if (!event.startsWith("data: ")) continue;
      const data = event.slice(6);
      if (data === "[DONE]") return;
      const said = JSON.parse(data) as { words?: unknown; affect?: unknown; persona?: unknown };
      if (typeof said.persona === "string") onSpeaker?.(said.persona);
      if (typeof said.affect === "string") onAffect?.(said.affect);
      if (typeof said.words === "string") onWords(said.words);
    }
  }
  throw new Error("The server brain stopped before it finished.");
};
