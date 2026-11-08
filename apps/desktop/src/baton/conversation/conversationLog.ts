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
  /** The rotated older half, when it is not `<file>.1` (a move to the persona folder only half done). */
  readonly older?: string;
  readonly now?: () => Date;
}): ConversationLog => {
  const now = input.now ?? (() => new Date());
  let turns: ConversationTurn[] = [
    ...readTurns(input.older ?? `${input.file}.1`),
    ...readTurns(input.file),
  ].slice(-LOADED_TURNS);
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
  /**
   * That persona's turns sharing words with the query, most relevant first; with no words, its latest turns, or
   * with `since` the first turns from then on. `since` is any date `Date.parse` reads.
   */
  readonly search: (
    persona: string | undefined,
    query: string | undefined,
    options?: { readonly limit?: number; readonly since?: string },
  ) => ReadonlyArray<ConversationTurn>;
  /** The persona speaking now, for the routes that do not know it (dictation stubs, refusals, notes). */
  readonly setCurrent: (persona: string | undefined) => void;
  /** The conversation of the persona speaking now. */
  readonly current: ConversationLog;
  /** The persona whose file holds the newest turn: who he spoke to last, after a restart or an instant reply too. */
  readonly latest: () => string | undefined;
  /** The speaker's latest turns and every other persona's not private: what he may ask to have typed back. */
  readonly heard: (
    count: number,
    isPrivate: (persona: string) => boolean,
  ) => ReadonlyArray<ConversationTurn>;
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
  readonly rename?: (from: string, to: string) => void;
}): PersonaConversations => {
  const rename = input.rename ?? NodeFS.renameSync;
  const fileOf = (persona: string) => {
    if (!PERSONA_ID.test(persona)) throw new Error(`Not a persona id: ${persona}`);
    return NodePath.join(input.dir, `${persona}.ndjson`);
  };
  const leadFile = fileOf(input.lead);
  /** True once `to` is the one to use: moved, or already there (a restore); a failed move is tried again next start. */
  const move = (from: string, to: string): boolean => {
    try {
      if (NodeFS.existsSync(from) && !NodeFS.existsSync(to)) {
        NodeFS.mkdirSync(input.dir, { recursive: true });
        rename(from, to);
      }
    } catch {
      // Left where it was, and still read from there below.
    }
    return !NodeFS.existsSync(from) || NodeFS.existsSync(to);
  };
  // The main file first: until it moves, the lead keeps reading and writing the old one, so nothing is orphaned.
  const moved = move(input.legacy, leadFile);
  if (moved) move(`${input.legacy}.1`, `${leadFile}.1`);
  const leadPath = moved ? leadFile : input.legacy;
  const leadOlder = [`${leadPath}.1`, `${input.legacy}.1`, `${leadFile}.1`].find((f) =>
    NodeFS.existsSync(f),
  );
  const logs = new Map<string, ConversationLog>();
  const of = (persona: string | undefined): ConversationLog => {
    const id = persona ?? input.lead;
    const found = logs.get(id);
    if (found !== undefined) return found;
    const made = createConversationLog({
      file: id === input.lead ? leadPath : fileOf(id),
      ...(id === input.lead && leadOlder !== undefined ? { older: leadOlder } : {}),
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
  /** The lead, and every persona with a file. */
  const personas = (): ReadonlyArray<string> => {
    let files: ReadonlyArray<string> = [];
    try {
      files = NodeFS.readdirSync(input.dir);
    } catch {
      // No conversation yet.
    }
    const ids = files
      .filter((f) => f.endsWith(".ndjson") && PERSONA_ID.test(f.slice(0, -7)))
      .map((f) => f.slice(0, -7));
    return [...new Set([input.lead, ...ids])];
  };
  return {
    of,
    search: (persona, query, options = {}) => {
      const limit = options.limit ?? 5;
      const from = options.since === undefined ? null : Date.parse(options.since);
      const after = (t: ConversationTurn) => from === null || Date.parse(t.at) >= from;
      const log = of(persona);
      if (query === undefined || query.trim() === "")
        return from === null
          ? log.recent(limit)
          : log.recent(LOADED_TURNS).filter(after).slice(0, limit);
      return log.search(query, LOADED_TURNS).filter(after).slice(0, limit);
    },
    setCurrent: (persona) => {
      speaking = persona;
    },
    current,
    latest: () =>
      personas()
        .map((id) => ({ id, at: of(id).recent(1)[0]?.at ?? "" }))
        .filter((x) => x.at !== "")
        .toSorted((a, b) => b.at.localeCompare(a.at))[0]?.id,
    heard: (count, isPrivate) => {
      const self = speaking ?? input.lead;
      return [self, ...personas().filter((id) => id !== self && !isPrivate(id))].flatMap((id) =>
        of(id).recent(count),
      );
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

/**
 * The `conversation_search` tool's answer: the named persona's turns (by pack name), or the speaker's own. A private
 * persona's are refused to any other. Each reply is labelled by who gave it, since the lead's file holds the turns of
 * the one shared file from before P2.
 */
export const answerConversationSearch = (
  input: {
    readonly conversations: PersonaConversations;
    readonly personas: ReadonlyArray<{ readonly id: string; readonly name: string }>;
    readonly speaking: { readonly id: string; readonly name: string };
    readonly isPrivate: (persona: string) => boolean;
  },
  ask: {
    readonly persona?: string | undefined;
    readonly words?: string | undefined;
    readonly since?: string | undefined;
  },
): string => {
  const { personas, speaking } = input;
  const named =
    ask.persona === undefined
      ? speaking
      : personas.find((p) => p.name.toLowerCase() === ask.persona!.trim().toLowerCase());
  if (named === undefined)
    return `There is no persona called ${ask.persona}. The personas are ${personas.map((p) => p.name).join(", ")}.`;
  if (named.id !== speaking.id && input.isPrivate(named.id))
    return `That's private to ${named.name}; you can share it in Settings.`;
  if (ask.since !== undefined && Number.isNaN(Date.parse(ask.since)))
    return `I can't read the date "${ask.since}"; give it like 2026-11-07.`;
  const turns = input.conversations.search(
    named.id,
    ask.words,
    ask.since === undefined ? {} : { since: ask.since },
  );
  const by = (t: ConversationTurn) => {
    const id = t.persona ?? named.id;
    return id === speaking.id ? "you" : (personas.find((p) => p.id === id)?.name ?? named.name);
  };
  return turns.length === 0
    ? `Nothing in what he and ${named.name} said matches.`
    : turns
        .map(
          (t) =>
            `${t.at.slice(0, 16).replace("T", " ")}\nhe said: ${t.said}\n${by(t)} replied: ${t.reply}`,
        )
        .join("\n\n");
};
