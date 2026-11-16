/**
 * The pulse's kinds and its decision log as Settings shows them, on web and mobile: no model, no jobs, nothing a
 * phone build cannot load (`pulse.ts` holds the rest).
 */

export const PULSE_CATEGORIES = [
  "jobs",
  "sessions",
  "messages",
  "reminders",
  "calendar",
  "people",
  "home",
  "mood",
  "patterns",
] as const;
export type PulseCategory = (typeof PULSE_CATEGORIES)[number];

/** Settings → Brain → Pulse, one row per kind she may raise: web and mobile show the same list. */
export const PULSE_ROWS = [
  { key: "jobs", title: "Jobs", description: "A job that failed, stopped or waits on you." },
  {
    key: "sessions",
    title: "Sessions",
    description: "A session stuck, waiting or finished unseen.",
  },
  { key: "messages", title: "Messages", description: "Notes and calls waiting for you." },
  {
    key: "reminders",
    title: "Reminders",
    description: "What you asked her to keep track of, when due.",
  },
  {
    key: "calendar",
    title: "Coming up",
    description: "Birthdays, plans and dates from your memories.",
  },
  { key: "people", title: "People", description: "Who arrived or left, and who has gone quiet." },
  { key: "home", title: "Home", description: "Device and house events." },
  { key: "mood", title: "Her mood", description: "When her own mood shifts." },
  {
    key: "patterns",
    title: "Patterns",
    description:
      "Routines, unusual hours and what usually follows what, raised rarely, as a question.",
  },
] as const;

/** Pulse rows that are his reactions (or his silence), not her decisions. */
export const PULSE_REACTIONS: ReadonlySet<string> = new Set(["liked", "told_off", "ignored"]);

const DID: Readonly<Record<string, string>> = {
  speak: "Said it",
  ask: "Asked",
  act: "Set a reminder",
  note: "Kept a note",
  nothing: "Stayed quiet",
};

/**
 * The decision log as rows, newest first: each review with what she did and why, and his reaction to it (a reaction row
 * names its decision as `row: <id>`; the newest reaction wins).
 */
export const pulseLog = (
  entries: ReadonlyArray<{
    readonly id: number;
    readonly at: string;
    readonly subject: string;
    readonly outcome: string;
    readonly detail: string;
  }>,
) => {
  const reacted = new Map<number, "liked" | "told_off" | "stopped">();
  // Entries come newest first, so the first reaction seen for a row is his latest.
  for (const e of entries) {
    const row = /row: (\d+)/.exec(e.detail)?.[1];
    if (row === undefined || !PULSE_REACTIONS.has(e.outcome) || reacted.has(Number(row))) continue;
    reacted.set(
      Number(row),
      e.detail.includes("stopped") ? "stopped" : e.outcome === "liked" ? "liked" : "told_off",
    );
  }
  return entries
    .filter((e) => !PULSE_REACTIONS.has(e.outcome))
    .map((e) => {
      const parts = e.detail.split(" · ");
      return {
        id: e.id,
        at: e.at,
        event: e.subject,
        decision: DID[e.outcome] ?? e.outcome,
        reason: parts.filter((p) => !p.startsWith("category: ")).join(" · "),
        category: PULSE_CATEGORIES.find((c) => parts.includes(`category: ${c}`)) ?? null,
        reaction: reacted.get(e.id) ?? null,
      };
    });
};
