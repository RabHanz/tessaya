/** One line of his conversation with her, as the brain's `conversation` read gives it (the room transcript). */
export interface TalkLine {
  readonly at: number;
  readonly vessel: string;
  readonly role: "them" | "her";
  readonly text: string;
  readonly private: boolean;
}

export type TalkRow =
  | { readonly kind: "day"; readonly key: string; readonly label: string }
  | {
      readonly kind: "line";
      readonly key: string;
      readonly role: "them" | "her";
      readonly text: string;
      readonly private: boolean;
    };

const dayOf = (at: number) => {
  const d = new Date(at);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
};

const dayLabel = (at: number, now: number) => {
  if (dayOf(at) === dayOf(now)) return "Today";
  if (dayOf(at) === dayOf(now - 86_400_000)) return "Yesterday";
  return new Date(at).toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
};

/** Pages of history merged oldest first, each line once (pages may overlap at their edges). */
export const mergeLines = (
  older: ReadonlyArray<TalkLine>,
  newer: ReadonlyArray<TalkLine>,
): ReadonlyArray<TalkLine> => {
  const seen = new Set<string>();
  return [...older, ...newer]
    .filter((l) => {
      const key = `${l.at}|${l.role}|${l.text}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.at - b.at);
};

/** The conversation as rows: a heading per day, then each line. Lines carry no device label (one conversation, wherever said). */
export const talkRows = (lines: ReadonlyArray<TalkLine>, now: number): ReadonlyArray<TalkRow> => {
  const rows: Array<TalkRow> = [];
  let day = "";
  lines.forEach((l, i) => {
    if (dayOf(l.at) !== day) {
      day = dayOf(l.at);
      rows.push({ kind: "day", key: `day-${day}`, label: dayLabel(l.at, now) });
    }
    rows.push({
      kind: "line",
      key: `${l.at}-${l.role}-${i}`,
      role: l.role,
      text: l.private ? "A private moment" : l.text,
      private: l.private,
    });
  });
  return rows;
};
