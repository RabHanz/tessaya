// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";

import { addNote, removeNote, type ScratchNote } from "@t3tools/tessaya-shared/scratchpad";

import { createJsonStore } from "./jsonStore.ts";

interface ScratchFile {
  readonly notes: ReadonlyArray<ScratchNote>;
  /** The hotkey that makes the next dictation a note. Off until he turns it on. */
  readonly hotkey: boolean;
}

const valid = (v: unknown): v is ScratchFile =>
  typeof v === "object" && v !== null && Array.isArray((v as ScratchFile).notes);

export const createScratchStore = (
  stateDir: string,
  now: () => number = Date.now,
  newId: () => string = () => NodeCrypto.randomUUID().slice(0, 8),
) => {
  const store = createJsonStore<ScratchFile>(
    NodePath.join(stateDir, "scratchpad.json"),
    { notes: [], hotkey: false },
    valid,
  );
  return {
    notes: (): ReadonlyArray<ScratchNote> => store.read().notes,
    hotkeyOn: (): boolean => store.read().hotkey === true,
    setHotkey: (hotkey: boolean) => store.write({ ...store.read(), hotkey }),
    add: (text: string): ScratchNote => {
      const file = store.read();
      const id = newId();
      const notes = addNote(file.notes, text, now(), id);
      store.write({ ...file, notes });
      return notes[0]!;
    },
    remove: (id: string) => {
      const file = store.read();
      store.write({ ...file, notes: removeNote(file.notes, id) });
    },
  };
};
export type ScratchStore = ReturnType<typeof createScratchStore>;
