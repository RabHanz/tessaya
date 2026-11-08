// @effect-diagnostics globalDate:off globalTimers:off
/**
 * The assistant's memory as the desktop sees it (D150): the server's store when it answers, and his
 * plain notes folder (D146) when it does not, so "remember that" never silently does nothing. The
 * server owns the rules (what is never kept, decay, conflicts); this only asks and phrases.
 */
import {
  MEMORY_TEXT_MAX,
  detectSecret,
  type MemoryClient,
  type MemoryHit,
  type MemoryItem,
  type MemoryVersion,
} from "@t3tools/baton-shared/memory";

import type { NotesStore } from "./memoryNotes.ts";

/** One call to the server's `baton.memory.*` through the window; rejects with a reason in plain words. */
export type MemoryCall = (op: string, args: Record<string, unknown>) => Promise<unknown>;

/** Waiting for memory must never slow a spoken answer. */
const RECALL_MS = 800;

const line = (item: MemoryItem): string =>
  `[id: ${item.id}] ${item.text} (${item.kind}${item.pinned ? ", pinned" : ""}, ${item.source === "user" ? "his own words" : `${Math.round(item.confidence * 100)}% sure`}${item.proposed ? ", waiting for his yes" : ""})`;

export const createDesktopMemory = (input: {
  /** Absent or failing: the notes folder answers. */
  readonly call?: MemoryCall | undefined;
  readonly notes: NotesStore;
  /** A secret was about to be remembered: keep it out of memory and return the offer to put it in the vault. */
  readonly onSecret?: ((text: string, what: string) => string | null) | undefined;
  /** The persona answering (its pack id), so a walled project's memories reach only its team. */
  readonly agent?: (() => string | undefined) | undefined;
}) => {
  const agent = () => {
    const who = input.agent?.();
    return who === undefined ? {} : { agent: who };
  };
  let turn = 0;
  let lastTurnRef: string | null = null;
  let notesMoved = false;
  // Notes kept while the server was away join memory once it answers, so they are not out of view.
  const moveNotes = async (call: MemoryCall): Promise<void> => {
    notesMoved = true;
    for (const note of input.notes.list()) {
      const out = await call("add", { kind: "note", text: note.text, source: "user", pinned: true })
        .then(() => true)
        .catch(() => false);
      if (out) input.notes.remove(note.id);
    }
  };
  const ask = async <T>(op: string, args: Record<string, unknown>): Promise<T | null> => {
    if (input.call === undefined) return null;
    try {
      const out = (await input.call(op, args)) as T;
      if (!notesMoved) await moveNotes(input.call);
      return out;
    } catch (error) {
      if (op === "add" || op === "edit") throw error;
      return null;
    }
  };

  return {
    /** The turn the next recall belongs to; "what did you use?" is asked of the last one. */
    beginTurn: (): string => {
      turn += 1;
      lastTurnRef = `turn-${Date.now()}-${turn}`;
      return lastTurnRef;
    },
    /**
     * Standing memory for a persona's first prompt: pinned and what he told it about working with him, as that persona
     * may recall it (P3): a walled project's items reach only its team, and a session is never shared by two personas.
     */
    standing: async (persona?: string): Promise<string> => {
      const out = await ask<{ block: string }>("recall", {
        budgetTokens: 600,
        ...(persona === undefined ? {} : { agent: persona }),
      });
      return out?.block ?? "";
    },
    /** What matches this sentence, for the turn; empty when the server is slow or has nothing. */
    forSentence: async (text: string, project: string | null = null): Promise<string> => {
      const call = ask<{ block: string }>("recall", {
        text,
        budgetTokens: 300,
        ...agent(),
        ...(project === null ? {} : { scopeRef: project }),
        ...(lastTurnRef === null ? {} : { turnRef: lastTurnRef }),
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), RECALL_MS);
      });
      try {
        return (await Promise.race([call, timeout]))?.block ?? "";
      } finally {
        clearTimeout(timer);
      }
    },
    search: async (query: string): Promise<ReadonlyArray<string>> => {
      const out = await ask<{ hits: ReadonlyArray<MemoryHit> }>("search", {
        text: query,
        limit: 12,
        ...agent(),
      });
      if (out !== null) return out.hits.map((h) => line(h.item));
      return input.notes.search(query).map((n) => `his note [id: ${n.id}]: ${n.text}`);
    },
    remember: async (text: string): Promise<string> => {
      const clean = text.trim().slice(0, MEMORY_TEXT_MAX);
      const secret = detectSecret(clean);
      if (secret !== null) {
        const offer = input.onSecret?.(clean, secret);
        if (offer !== undefined && offer !== null) return offer;
      }
      try {
        const out = await ask<{ item: MemoryItem }>("add", {
          kind: "note",
          text: clean,
          source: "user",
        });
        if (out !== null) return `Kept [id: ${out.item.id}].`;
      } catch (error) {
        return error instanceof Error ? error.message : "That was not kept.";
      }
      return `Kept as a note [id: ${input.notes.add(clean).id}].`;
    },
    forget: async (id: string): Promise<string> => {
      const out = await ask<{ forgotten: boolean }>("forget", { id });
      if (out !== null) return out.forgotten ? "Forgotten." : "There is no memory by that id.";
      return input.notes.remove(id) ? "Forgotten." : "There is no note by that id.";
    },
    pin: async (id: string, pinned: boolean): Promise<string> => {
      const out = await ask<{ item: MemoryItem }>("pin", { id, pinned });
      return out === null
        ? "Memory is not reachable, so nothing was pinned."
        : pinned
          ? "Pinned."
          : "Unpinned.";
    },
    /** What the last answer drew on. */
    used: async (): Promise<string> => {
      if (lastTurnRef === null) return "Nothing yet this session.";
      const out = await ask<{ items: ReadonlyArray<MemoryItem> }>("used", { turnRef: lastTurnRef });
      if (out === null) return "Memory is not reachable.";
      return out.items.length === 0
        ? "That answer did not draw on any memory."
        : out.items.map((i) => `- ${i.text} (${i.kind})`).join("\n");
    },
    /** An item's earlier wordings, as this persona may see it: walls hold here as for the item. */
    history: async (id: string): Promise<string> => {
      const out = await ask<{ versions: ReadonlyArray<MemoryVersion> }>("history", {
        id,
        ...agent(),
      });
      if (out === null) return "Memory is not reachable.";
      return out.versions.length === 0
        ? "It has not been changed."
        : out.versions
            .map(
              (v) =>
                `- version ${v.version}, ${v.at.slice(0, 10)}, by ${v.by} (${v.why}): ${v.text}`,
            )
            .join("\n");
    },
    /** After a turn: fire and forget, never read aloud and never in the way. */
    learn: (
      said: string,
      reply: string,
      tainted: boolean,
      project: string | null = null,
      previous = "",
    ): void => {
      void ask("learn", {
        said,
        reply,
        tainted,
        ...agent(),
        ...(project === null ? {} : { project }),
        ...(previous === "" ? {} : { previous }),
        ...(lastTurnRef === null ? {} : { turnRef: lastTurnRef }),
      });
    },
  };
};

export type DesktopMemory = ReturnType<typeof createDesktopMemory>;

/**
 * `MemoryClient` (the interface other lanes call: presence, commitments) over the window's memory
 * calls. Every method rejects with the server's reason in plain words when it refuses.
 */
export const createMemoryClient = (call: MemoryCall): MemoryClient => {
  const item = async (op: string, args: Record<string, unknown>) =>
    ((await call(op, args)) as { item: MemoryItem }).item;
  return {
    list: async (query) =>
      ((await call("list", { ...query })) as { items: ReadonlyArray<MemoryItem> }).items,
    search: async (query) =>
      ((await call("search", { ...query })) as { hits: ReadonlyArray<MemoryHit> }).hits,
    add: (draft) => item("add", { ...draft }),
    edit: (id, patch) => item("edit", { id, ...patch }),
    pin: (id, pinned) => item("pin", { id, pinned }),
    forget: async (id) => ((await call("forget", { id })) as { forgotten: boolean }).forgotten,
    accept: (id) => item("accept", { id }),
    recall: async (context) =>
      (await call("recall", { ...context })) as { block: string; ids: ReadonlyArray<string> },
    exportMarkdown: async () => ((await call("export", {})) as { markdown: string }).markdown,
  };
};
