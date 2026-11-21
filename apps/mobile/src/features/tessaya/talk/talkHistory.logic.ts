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
      readonly where: string;
      readonly private: boolean;
    };

/** A vessel's id as a place: this phone, or its name ("tumble" → "Tumble", "desk-voice" → "Desk voice"). */
export const vesselLabel = (vessel: string, thisDevice: string | null): string => {
  if (vessel === thisDevice) return "this phone";
  const words = vessel.replace(/[-_]+/g, " ").trim();
  return words === "" ? "somewhere" : `${words[0]!.toUpperCase()}${words.slice(1)}`;
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

const clock = (at: number) => {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
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

/** The conversation as rows: a heading per day, then each line with where and when it was said, in the phone's clock. */
export const talkRows = (
  lines: ReadonlyArray<TalkLine>,
  thisDevice: string | null,
  now: number,
): ReadonlyArray<TalkRow> => {
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
      where: `on ${vesselLabel(l.vessel, thisDevice)} · ${clock(l.at)}`,
      private: l.private,
    });
  });
  return rows;
};
