/** Scratchpad (Wispr parity): quick voice notes kept apart from History. Pure: adding, searching and the one-line preview. */
export interface ScratchNote {
  readonly id: string;
  /** Epoch ms. */
  readonly at: number;
  readonly text: string;
}

export const NOTE_TEXT_MAX = 20_000;
export const NOTES_MAX = 1_000;

export const addNote = (
  list: ReadonlyArray<ScratchNote>,
  text: string,
  now: number,
  id: string,
): ReadonlyArray<ScratchNote> => {
  const clean = text.trim();
  if (clean === "") throw new Error("There is nothing to note.");
  if (clean.length > NOTE_TEXT_MAX) throw new Error("That note is too long.");
  // Newest first; the oldest fall off past the limit.
  return [{ id, at: now, text: clean }, ...list].slice(0, NOTES_MAX);
};

export const removeNote = (
  list: ReadonlyArray<ScratchNote>,
  id: string,
): ReadonlyArray<ScratchNote> => list.filter((n) => n.id !== id);

/** Every word typed must appear (any case); an empty query is everything. */
export const searchNotes = (
  list: ReadonlyArray<ScratchNote>,
  query: string,
): ReadonlyArray<ScratchNote> => {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w !== "");
  return words.length === 0
    ? list
    : list.filter((n) => {
        const text = n.text.toLowerCase();
        return words.every((w) => text.includes(w));
      });
};

export const previewOf = (text: string, max = 160): string => {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length <= max ? one : `${one.slice(0, max).replace(/\s+\S*$/, "")}...`;
};
