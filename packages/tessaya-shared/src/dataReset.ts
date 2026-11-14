/** Erasing what Tessaya holds about him, only after he types the word. Pure: the word, the scopes and what each one removes. */
export const ERASE_WORD = "erase";

export const RESET_SCOPES = ["history", "recordings", "memory"] as const;
export type ResetScope = (typeof RESET_SCOPES)[number];

export const RESET_LABEL: Readonly<Record<ResetScope, { label: string; hint: string }>> = {
  history: {
    label: "Erase History",
    hint: "Every dictation and spoken turn listed in History, with their recordings. It cannot be undone.",
  },
  recordings: {
    label: "Erase voice recordings",
    hint: "Only the saved audio. The words in History stay.",
  },
  memory: {
    label: "Erase memory",
    hint: "Everything Tessaya remembers about you and your work, including held proposals, and your notes folder. It cannot be undone.",
  },
};

export const confirmed = (typed: string): boolean => typed.trim().toLowerCase() === ERASE_WORD;

export const resetPrompt = `Type ${ERASE_WORD} to confirm`;
