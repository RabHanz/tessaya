// @effect-diagnostics nodeBuiltinImport:off
/**
 * The Vocabulary editor's writes (D140). The file is the one the sidecar already reads
 * (`<state dir>/voice/dictionary.json`, a list of phrase and replacement); the dictation clean-up reads
 * the in-memory copy, so a change here takes effect on the next dictation with no restart.
 */
import * as NodePath from "node:path";

import { removeEntry, type VocabularyEntry } from "@t3tools/baton-shared/vocabulary";

import { writeJsonFile } from "../writing/jsonStore.ts";

/** A word, with where it came from: the one vocabulary model. A file written before it has none of the extras, and is "added". */
export type VocabEntry = VocabularyEntry;
export { removeEntry };

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Adds or replaces: one entry per phrase, ignoring case. An empty phrase changes nothing. */
export const addEntry = (
  list: ReadonlyArray<VocabEntry>,
  entry: { readonly phrase: string; readonly replacement: string | null },
): ReadonlyArray<VocabEntry> => {
  const phrase = entry.phrase.trim();
  if (phrase.length === 0) return list;
  const replacement =
    entry.replacement === null || entry.replacement.trim().length === 0
      ? null
      : entry.replacement.trim();
  const heard = list.find((e) => same(e.phrase, phrase))?.heard;
  return [
    { phrase, replacement, source: "added", ...(heard === undefined ? {} : { heard }) },
    ...list.filter((e) => !same(e.phrase, phrase)),
  ];
};

/** Changes the spelling or the phrase of one word and keeps what Baton learned about it. */
export const editEntry = (
  list: ReadonlyArray<VocabEntry>,
  from: string,
  to: { readonly phrase: string; readonly replacement: string | null },
): ReadonlyArray<VocabEntry> => {
  const old = list.find((e) => same(e.phrase, from));
  const phrase = to.phrase.trim();
  if (old === undefined || phrase.length === 0) return list;
  const replacement =
    to.replacement === null || to.replacement.trim().length === 0 ? null : to.replacement.trim();
  return list
    .map((e) => (e === old ? { ...e, phrase, replacement } : e))
    .filter((e, i, all) => e === old || !same(e.phrase, phrase) || all.indexOf(e) === i);
};

/** Drops every word Baton picked up by itself; what he added stays. */
export const forgetLearned = (list: ReadonlyArray<VocabEntry>): ReadonlyArray<VocabEntry> =>
  list.filter((e) => e.source !== "learned");

export const saveDictionary = (stateDir: string, list: ReadonlyArray<VocabEntry>): void =>
  writeJsonFile(NodePath.join(stateDir, "voice", "dictionary.json"), list);
