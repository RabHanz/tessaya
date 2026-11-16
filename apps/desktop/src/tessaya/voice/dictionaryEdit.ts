// @effect-diagnostics nodeBuiltinImport:off
/**
 * The Vocabulary editor's writes (D140). The file is the one the sidecar already reads
 * (`<state dir>/voice/dictionary.json`, a list of phrase and replacement); the dictation clean-up reads
 * the in-memory copy, so a change here takes effect on the next dictation with no restart.
 */
import * as NodePath from "node:path";

import {
  addEntry,
  editEntry,
  mergeEntries,
  parseVocabulary,
  removeEntry,
  type VocabularyEntry,
} from "@t3tools/tessaya-shared/vocabulary";

import { writeJsonFile } from "../writing/jsonStore.ts";

/** A word, with where it came from: the one vocabulary model. A file written before it has none of the extras, and is "added". */
export type VocabEntry = VocabularyEntry;
export { addEntry, editEntry, removeEntry };

/** Drops every word Baton picked up by itself; what he added stays. */
export const forgetLearned = (list: ReadonlyArray<VocabEntry>): ReadonlyArray<VocabEntry> =>
  list.filter((e) => e.source !== "learned");

const keyOf = (e: VocabEntry) => `${e.phrase.trim().toLowerCase()}\u0000${e.replacement ?? ""}`;

/**
 * What his server needs to hold the same list: each word gone, then everything new or changed as one merge. Sent after
 * every save, so the server (the same file on his own machine) can tell T3's list and his other servers.
 */
export const vocabularyChanges = (
  before: ReadonlyArray<VocabEntry>,
  after: ReadonlyArray<VocabEntry>,
): ReadonlyArray<
  | { readonly verb: "remove"; readonly phrase: string }
  | { readonly verb: "learn"; readonly entries: ReadonlyArray<VocabEntry> }
> => {
  const kept = new Set(after.map((e) => e.phrase.trim().toLowerCase()));
  const old = new Map(before.map((e) => [keyOf(e), JSON.stringify(e)]));
  const removed = [...new Set(before.map((e) => e.phrase.trim()))].filter(
    (phrase) => !kept.has(phrase.toLowerCase()),
  );
  const changed = after.filter((e) => old.get(keyOf(e)) !== JSON.stringify(e));
  return [
    ...removed.map((phrase) => ({ verb: "remove" as const, phrase })),
    ...(changed.length === 0 ? [] : [{ verb: "learn" as const, entries: changed }]),
  ];
};

export const saveDictionary = (stateDir: string, list: ReadonlyArray<VocabEntry>): void =>
  writeJsonFile(NodePath.join(stateDir, "voice", "dictionary.json"), list);

/**
 * His server's list (`vocabulary` read) against this machine's: with nothing of his waiting to reach the server, its
 * stored words are the list, removals included; otherwise both, and his are sent (`push`). Names the server adds on
 * reading (personas, household, projects) carry no source and stay the server's.
 */
export const fromServer = (
  local: ReadonlyArray<VocabEntry>,
  sent: ReadonlyArray<VocabEntry>,
  server: ReadonlyArray<unknown>,
): { readonly next: ReadonlyArray<VocabEntry>; readonly push: boolean } => {
  const stored = parseVocabulary(
    server.filter((e) => typeof e === "object" && e !== null && "source" in e),
  );
  return vocabularyChanges(sent, local).length > 0
    ? { next: mergeEntries(local, stored), push: true }
    : { next: stored, push: false };
};
