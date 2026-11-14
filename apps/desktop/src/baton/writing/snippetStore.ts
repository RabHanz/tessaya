// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import { importSnippets, putSnippet, type Snippet } from "@t3tools/tessaya-shared/snippets";

import { createJsonStore } from "./jsonStore.ts";

const isSnippets = (v: unknown): v is ReadonlyArray<Snippet> =>
  Array.isArray(v) &&
  v.every(
    (s) =>
      typeof s === "object" &&
      s !== null &&
      typeof (s as Snippet).cue === "string" &&
      typeof (s as Snippet).text === "string" &&
      Array.isArray((s as Snippet).apps),
  );

export const createSnippetStore = (stateDir: string) => {
  const store = createJsonStore<ReadonlyArray<Snippet>>(
    NodePath.join(stateDir, "snippets.json"),
    [],
    isSnippets,
  );
  return {
    list: store.read,
    /** False when the list is full. */
    put: (s: Snippet): boolean => {
      const next = putSnippet(store.read(), s);
      if (next === null) return false;
      store.write(next);
      return true;
    },
    remove: (cue: string): void => store.write(store.read().filter((s) => s.cue !== cue)),
    /** Adds what a file holds; same cues are replaced. */
    importText: (raw: string): { added: number; skipped: number } => {
      const { snippets, skipped } = importSnippets(raw);
      let list = store.read();
      let added = 0;
      for (const s of snippets) {
        const next = putSnippet(list, s);
        if (next === null)
          return (store.write(list), { added, skipped: skipped + snippets.length - added });
        list = next;
        added += 1;
      }
      store.write(list);
      return { added, skipped };
    },
  };
};
export type SnippetStore = ReturnType<typeof createSnippetStore>;
