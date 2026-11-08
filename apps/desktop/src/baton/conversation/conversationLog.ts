// @effect-diagnostics nodeBuiltinImport:off globalDate:off
/**
 * The conversation's files (D142): `conversation/<persona id>.ndjson` in the state folder (P2), one turn a line,
 * in full, never sent anywhere except inside the model calls that need it. It survives a restart.
 * At 20 MB the file moves to `.1` and a new one starts; both are read, so the oldest turns stay
 * searchable. Dictated words are not kept: a dictation is a stub with its length.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  RECENT_TURNS,
  parseTurn,
  searchTurns,
  currentTarget,
  type ConversationRoute,
  type ConversationTarget,
  type ConversationTurn,
} from "@t3tools/baton-shared/conversation";

const MAX_BYTES = 20 * 1024 * 1024;
/** Turns kept in memory to search; the file keeps everything. */
const LOADED_TURNS = 4_000;

export interface ConversationLog {
  readonly add: (turn: {
    readonly route: ConversationRoute;
    readonly said: string;
    readonly reply: string;
    readonly note?: string;
    readonly target?: ConversationTarget;
    readonly persona?: string;
  }) => ConversationTurn;
  /** Older turns that share words with the query, most relevant first (the agent's memory search). */
  readonly search: (query: string, limit?: number) => ReadonlyArray<ConversationTurn>;
  /** What "it" means now, if the conversation has been about something. */
  readonly target: () => ConversationTarget | null;
  readonly recent: (count?: number) => ReadonlyArray<ConversationTurn>;
}

const readTurns = (file: string): ReadonlyArray<ConversationTurn> => {
  try {
    return NodeFS.readFileSync(file, "utf8")
      .split("\n")
      .flatMap((line) => {
        const turn = line.trim() === "" ? null : parseTurn(line);
        return turn === null ? [] : [turn];
      });
  } catch {
    return [];
  }
};

export const createConversationLog = (input: {
  readonly file: string;
  readonly now?: () => Date;
}): ConversationLog => {
  const now = input.now ?? (() => new Date());
  let turns: ConversationTurn[] = [...readTurns(`${input.file}.1`), ...readTurns(input.file)].slice(
    -LOADED_TURNS,
  );
  let nextId = (turns.at(-1)?.id ?? 0) + 1;

  const append = (turn: ConversationTurn) => {
    try {
      NodeFS.mkdirSync(NodePath.dirname(input.file), { recursive: true });
      if (NodeFS.existsSync(input.file) && NodeFS.statSync(input.file).size > MAX_BYTES) {
        NodeFS.renameSync(input.file, `${input.file}.1`);
      }
      NodeFS.appendFileSync(input.file, `${JSON.stringify(turn)}\n`);
    } catch {
      // Losing a line must never stop an answer; the turn still sits in memory for this run.
    }
  };

  return {
    add: (turn) => {
      const entry: ConversationTurn = { id: nextId, at: now().toISOString(), ...turn };
      nextId += 1;
      turns = [...turns, entry].slice(-LOADED_TURNS);
      append(entry);
      return entry;
    },
    search: (query, limit = 5) => searchTurns(turns, query, { exclude: new Set(), limit }),
    target: () => currentTarget(turns),
    recent: (count = RECENT_TURNS) => turns.filter((t) => t.route !== "dictation").slice(-count),
  };
};

/** A persona id from the pack: lowercase letters, digits and dashes, so it is safe as a file name. */
const PERSONA_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface PersonaConversations {
  /** One persona's conversation (P2); `undefined` is the lead's. */
  readonly of: (persona: string | undefined) => ConversationLog;
  /** That persona's turns sharing words with the query, most relevant first, optionally since an ISO time. */
  readonly search: (
    persona: string | undefined,
    query: string,
    options?: { readonly limit?: number; readonly since?: string },
  ) => ReadonlyArray<ConversationTurn>;
  /** The persona speaking now, for the routes that do not know it (dictation stubs, refusals, notes). */
  readonly setCurrent: (persona: string | undefined) => void;
  /** The conversation of the persona speaking now. */
  readonly current: ConversationLog;
  /** The persona whose file holds the newest turn, so a restart knows who he spoke to last. */
  readonly latest: () => string | undefined;
}

/**
 * A conversation file per persona, `<dir>/<persona id>.ndjson` (INTEGRATION.md 3.1 step 1). The old shared file
 * becomes the lead's on first start; the others start empty, and their earlier turns stay readable in the lead's.
 */
export const createPersonaConversations = (input: {
  readonly dir: string;
  readonly legacy: string;
  readonly lead: string;
  readonly now?: () => Date;
}): PersonaConversations => {
  const fileOf = (persona: string) => {
    if (!PERSONA_ID.test(persona)) throw new Error(`Not a persona id: ${persona}`);
    return NodePath.join(input.dir, `${persona}.ndjson`);
  };
  const leadFile = fileOf(input.lead);
  try {
    if (NodeFS.existsSync(input.legacy) && !NodeFS.existsSync(leadFile)) {
      NodeFS.mkdirSync(input.dir, { recursive: true });
      if (NodeFS.existsSync(`${input.legacy}.1`))
        NodeFS.renameSync(`${input.legacy}.1`, `${leadFile}.1`);
      NodeFS.renameSync(input.legacy, leadFile);
    }
  } catch {
    // A move that fails leaves the old file where it was: the lead starts empty and nothing is lost.
  }
  const logs = new Map<string, ConversationLog>();
  const of = (persona: string | undefined): ConversationLog => {
    const id = persona ?? input.lead;
    const found = logs.get(id);
    if (found !== undefined) return found;
    const made = createConversationLog({
      file: fileOf(id),
      ...(input.now === undefined ? {} : { now: input.now }),
    });
    logs.set(id, made);
    return made;
  };
  let speaking: string | undefined;
  const current: ConversationLog = {
    add: (turn) => of(speaking).add(turn),
    search: (query, limit) => of(speaking).search(query, limit),
    target: () => of(speaking).target(),
    recent: (count) => of(speaking).recent(count),
  };
  return {
    of,
    search: (persona, query, options = {}) =>
      of(persona)
        .search(query, 4_000)
        .filter((t) => options.since === undefined || t.at >= options.since)
        .slice(0, options.limit ?? 5),
    setCurrent: (persona) => {
      speaking = persona;
    },
    current,
    latest: () => {
      let files: ReadonlyArray<string> = [];
      try {
        files = NodeFS.readdirSync(input.dir);
      } catch {
        // No conversation yet.
      }
      return files
        .filter((f) => f.endsWith(".ndjson") && PERSONA_ID.test(f.slice(0, -7)))
        .map((f) => f.slice(0, -7))
        .map((id) => ({ id, at: of(id).recent(1)[0]?.at ?? "" }))
        .filter((x) => x.at !== "")
        .toSorted((a, b) => b.at.localeCompare(a.at))[0]?.id;
    },
  };
};

/** The state folder's conversations; the pack's lead is always `executive` (osPack.ts). */
export const conversationsIn = (stateDir: string): PersonaConversations =>
  createPersonaConversations({
    dir: NodePath.join(stateDir, "conversation"),
    legacy: NodePath.join(stateDir, "baton-conversation.ndjson"),
    lead: "executive",
  });
