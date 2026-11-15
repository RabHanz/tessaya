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

export const saveDictionary = (stateDir: string, list: ReadonlyArray<VocabEntry>): void =>
  writeJsonFile(NodePath.join(stateDir, "voice", "dictionary.json"), list);
