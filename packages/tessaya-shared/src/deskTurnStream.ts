/** A persona layer's tone for the reply that follows: its voice's affect clip says the whole line (VOXTA I5). */
export interface DeskAffect {
  readonly affect: string;
}
/** A group turn (M-021): the words that follow are this persona's, in its own voice and face. */
export interface DeskSpeaker {
  readonly persona: string;
}
/**
 * A private moment's reply follows (PersonaLayers.ts): it plays aloud only on headphones, or on speakers when `speakers`
 * (he is alone there); otherwise the vessel says `PRIVATE_HELD_LINE` instead, which gives nothing away.
 */
export interface DeskPrivate {
  readonly private: { readonly speakers: boolean };
}
/** What a desk turn streams: her words, at most one affect before them, and in a group who speaks. */
export type DeskSaid = string | DeskAffect | DeskSpeaker | DeskPrivate;

/** Said aloud instead of a private reply no output may play now, on every vessel. */
export const PRIVATE_HELD_LINE = "I'll tell you when your headphones are on.";

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
  onPrivate?: (speakers: boolean) => void,
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
      const said = JSON.parse(data) as {
        words?: unknown;
        affect?: unknown;
        persona?: unknown;
        private?: { speakers?: unknown };
      };
      if (typeof said.private === "object" && said.private !== null)
        onPrivate?.(said.private.speakers === true);
      if (typeof said.persona === "string") onSpeaker?.(said.persona);
      if (typeof said.affect === "string") onAffect?.(said.affect);
      if (typeof said.words === "string") onWords(said.words);
    }
  }
  throw new Error("The server brain stopped before it finished.");
};
