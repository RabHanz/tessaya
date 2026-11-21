import type { TranscriptLine } from "./TessayaTurn.ts";

/** How far back one page of a person's conversation reaches, and how many lines it carries at most. */
export const HISTORY_PAGE_MS = 2 * 86_400_000;
export const HISTORY_LINES = 400;

/**
 * One person's conversation with her, from the room transcript, newest last. The owner sees every line of each
 * conversation he spoke in (a persona joining, others in the room); anyone else sees only their own words and her
 * answers to them (one exchange shares its time). A private moment stays its placeholder.
 */
export const conversationOf = (
  rows: ReadonlyArray<TranscriptLine>,
  member: string,
  owner: boolean,
): ReadonlyArray<TranscriptLine> => {
  const mine = rows.filter((r) => r.role === "them" && r.who === member);
  const conversations = new Set(mine.map((r) => r.conversation));
  const exchanges = new Set(mine.map((r) => `${r.conversation}|${r.at}`));
  return rows
    .filter((r) =>
      owner
        ? conversations.has(r.conversation)
        : r.role === "them"
          ? r.who === member
          : exchanges.has(`${r.conversation}|${r.at}`),
    )
    .slice(-HISTORY_LINES);
};
