import { batonDesktopBridge } from "@t3tools/baton-contracts";

type Draft = {
  readonly text: string;
  readonly selection: { readonly start: number; readonly end: number };
};

/** The draft with `words` in place of its selection, the caret after them. */
export const insertAtSelection = (draft: Draft, words: string): Draft => {
  const start = Math.max(0, Math.min(draft.selection.start, draft.text.length));
  const end = Math.max(start, Math.min(draft.selection.end, draft.text.length));
  const caret = start + words.length;
  return {
    text: draft.text.slice(0, start) + words + draft.text.slice(end),
    selection: { start: caret, end: caret },
  };
};

/**
 * On the desktop, T3's composer microphone is Tessaya's dictation unless he chose T3's own in Settings. True: Tessaya
 * took the press (a first press starts it; the next one ends it and its words land at the caret), so T3's stays idle.
 */
export const tryTessayaComposerMic = async (input: {
  readonly readDraft: () => Draft;
  readonly commitDraft: (text: string, selection: Draft["selection"]) => void;
}): Promise<boolean> => {
  const answer = await batonDesktopBridge()
    ?.composerMic?.()
    .catch(() => null);
  if (answer?.handled !== true) return false;
  if (answer.text !== undefined && answer.text !== "") {
    const next = insertAtSelection(input.readDraft(), answer.text);
    input.commitDraft(next.text, next.selection);
  }
  return true;
};
