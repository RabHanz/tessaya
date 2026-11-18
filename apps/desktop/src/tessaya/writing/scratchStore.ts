// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";

import type { TessayaScratchpadAct } from "@t3tools/tessaya-contracts";
import { addNote, removeNote, type ScratchNote } from "@t3tools/tessaya-shared/scratchpad";

import { createJsonStore } from "./jsonStore.ts";

/**
 * His Scratchpad lives on her brain (`baton.scratchpad.call`); this file is its cache. What he wrote or removed while
 * the brain was away waits in `unsent` and `removed` and goes up, by id, at the next sync.
 */
interface ScratchFile {
  readonly notes: ReadonlyArray<ScratchNote>;
  /** The hotkey that makes the next dictation a note. Off until he turns it on. */
  readonly hotkey: boolean;
  /** Absent in a file from before the brain kept the notes: every note in it is still to send. */
  readonly unsent?: ReadonlyArray<string>;
  readonly removed?: ReadonlyArray<string>;
}

const valid = (v: unknown): v is ScratchFile =>
  typeof v === "object" && v !== null && Array.isArray((v as ScratchFile).notes);

export type ScratchCall = (
  act: TessayaScratchpadAct,
) => Promise<{ readonly notes: ReadonlyArray<ScratchNote> }>;

export const createScratchStore = (
  stateDir: string,
  now: () => number = Date.now,
  newId: () => string = () => NodeCrypto.randomUUID().slice(0, 8),
  call?: ScratchCall,
) => {
  const store = createJsonStore<ScratchFile>(
    NodePath.join(stateDir, "scratchpad.json"),
    { notes: [], hotkey: false, unsent: [], removed: [] },
    valid,
  );
  const unsentOf = (f: ScratchFile) => f.unsent ?? f.notes.map((n) => n.id);
  let running: Promise<void> | null = null;
  /** Sends what waits, then takes her brain's list; a brain that can't be reached leaves the cache as it is. */
  const sync = (): Promise<void> => {
    if (call === undefined) return Promise.resolve();
    running ??= (async () => {
      const file = store.read();
      const unsent = unsentOf(file);
      const removed = file.removed ?? [];
      const toSend = file.notes.filter((n) => unsent.includes(n.id));
      if (toSend.length > 0) await call({ op: "add", notes: toSend });
      if (removed.length > 0) await call({ op: "remove", ids: removed });
      const { notes } = await call({ op: "list" });
      // What he wrote or removed during this sync waits for the next.
      const after = store.read();
      const stillUnsent = unsentOf(after).filter((id) => !unsent.includes(id));
      const stillRemoved = (after.removed ?? []).filter((id) => !removed.includes(id));
      store.write({
        ...after,
        notes: [
          ...after.notes.filter((n) => stillUnsent.includes(n.id)),
          ...notes.filter((n) => !stillRemoved.includes(n.id)),
        ],
        unsent: stillUnsent,
        removed: stillRemoved,
      });
    })()
      .catch(() => undefined)
      .finally(() => {
        running = null;
      });
    return running;
  };
  return {
    notes: (): ReadonlyArray<ScratchNote> => store.read().notes,
    hotkeyOn: (): boolean => store.read().hotkey === true,
    setHotkey: (hotkey: boolean) => store.write({ ...store.read(), hotkey }),
    add: (text: string): ScratchNote => {
      const file = store.read();
      const id = newId();
      const notes = addNote(file.notes, text, now(), id);
      store.write({ ...file, notes, unsent: [...unsentOf(file), id] });
      void sync();
      return notes[0]!;
    },
    remove: (id: string) => {
      const file = store.read();
      store.write({
        ...file,
        notes: removeNote(file.notes, id),
        unsent: unsentOf(file).filter((u) => u !== id),
        removed: [...(file.removed ?? []), id],
      });
      void sync();
    },
    sync,
  };
};
export type ScratchStore = ReturnType<typeof createScratchStore>;
