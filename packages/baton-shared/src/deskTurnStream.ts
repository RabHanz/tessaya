/** Her words from the server's desk turn (`/tessaya/desk/turn`): `data: {"words"}` events until `data: [DONE]`. */
export const readDeskTurn = async (
  body: ReadableStream<Uint8Array>,
  onWords: (words: string) => void,
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
      const words = (JSON.parse(data) as { words?: unknown }).words;
      if (typeof words === "string") onWords(words);
    }
  }
  throw new Error("The server brain stopped before it finished.");
};
