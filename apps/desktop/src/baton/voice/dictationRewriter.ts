// @effect-diagnostics globalTimers:off globalDate:off nodeBuiltinImport:off
/**
 * The optional second pass: his own `claude` through the companion's session, so it bills his plan
 * and has no tools (D84). It can never hold dictation up: past `HARD_LIMIT_MS` the local text goes
 * in, the session is dropped, and the next dictation starts another.
 */
import * as NodePath from "node:path";

import {
  cleanDictation,
  rewriteMessage,
  rewriteSystemPrompt,
  type CleanedText,
  type CleanupLevel,
  type DictationMode,
  type DictionaryEntry,
} from "@t3tools/baton-shared/dictationCleanup";

import { parseVocabulary, type VocabularyEntry } from "@t3tools/baton-shared/vocabulary";
import { startVisionSession, type VisionSession } from "../screen/claudeVision.ts";
import { createJsonStore, writeJsonFile } from "../writing/jsonStore.ts";

/** A long dictation takes longer to write out, so the limit grows with it, but it always ends. */
export const hardLimitMs = (text: string): number => Math.min(45_000, 2_500 + text.length * 8);
const IDLE_MS = 10 * 60_000;
/** Each dictation stays in the session's context, so it starts over before that matters. */
const TURNS_PER_SESSION = 20;

interface CleanInput {
  readonly raw: string;
  readonly mode: DictationMode;
  readonly level: CleanupLevel;
}

export interface Rewriter {
  /** Called when recording starts, so the session is up by the time he stops. */
  readonly warm: () => void;
  /**
   * The words so far, at a pause while he still holds the key: cleaned now, so a `clean` of the same words after
   * release takes this answer instead of waiting a turn (about 1.2 s through the CLI).
   */
  readonly speculate: (input: CleanInput) => void;
  readonly clean: (input: CleanInput) => Promise<CleanedText & { readonly ms: number }>;
  readonly dispose: () => void;
}

export const makeRewriter = (input: {
  readonly claudeBinary: string;
  readonly model: string;
  readonly workDir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly platform: string;
  readonly dictionary: () => ReadonlyArray<DictionaryEntry>;
  /** Replaces `hardLimitMs`, for the lab and for tests. */
  readonly limitMs?: number;
  readonly start?: typeof startVisionSession;
  readonly always?: boolean;
}): Rewriter => {
  let session: VisionSession | null = null;
  let turns = 0;
  let idle: ReturnType<typeof setTimeout> | null = null;

  const drop = () => {
    if (idle !== null) clearTimeout(idle);
    idle = null;
    session?.dispose();
    session = null;
    turns = 0;
  };
  let prompt = "";
  const get = (): VisionSession => {
    // A word he just taught is in the next clean-up, not the next session.
    const current = rewriteSystemPrompt(input.dictionary());
    if (current !== prompt) drop();
    prompt = current;
    if (idle !== null) clearTimeout(idle);
    idle = setTimeout(drop, IDLE_MS);
    session ??= (input.start ?? startVisionSession)({
      claudeBinary: input.claudeBinary,
      model: input.model,
      systemPrompt: current,
      workDir: input.workDir,
      env: input.env,
      platform: input.platform,
      timeoutMs: 60_000,
    });
    return session;
  };

  const warm = () => {
    try {
      get();
    } catch {
      drop();
    }
  };

  // One session answers one question at a time: a speculative clean and the real one never overlap on it.
  let line: Promise<unknown> = Promise.resolve();
  const ask = (text: string, mode: DictationMode): Promise<string> => {
    const turn = line.then(() => askNow(text, mode));
    line = turn.catch(() => undefined);
    return turn;
  };
  const askNow = async (text: string, mode: DictationMode): Promise<string> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const answer = await Promise.race([
        get().ask([{ type: "text", text: rewriteMessage(text, mode) }]),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("timed out")),
            input.limitMs ?? hardLimitMs(text),
          );
        }),
      ]);
      turns += 1;
      return answer.trim();
    } catch (error) {
      // A late answer would be read as the next dictation's. The next session starts now: left
      // to the next dictation, its cold start would use up that one's limit too.
      drop();
      warm();
      throw error;
    } finally {
      clearTimeout(timer);
      if (turns >= TURNS_PER_SESSION) drop();
    }
  };

  const run = ({ raw, mode, level }: CleanInput) =>
    cleanDictation({
      raw,
      mode,
      level,
      dictionary: input.dictionary(),
      ask,
      ...(input.always === undefined ? {} : { always: input.always }),
    });
  /** Only the latest guess is kept: words said after it make it stale. */
  let guess: { readonly key: string; readonly cleaned: Promise<CleanedText> } | null = null;
  const keyOf = (c: CleanInput) => `${c.level}\n${c.mode}\n${c.raw}`;

  return {
    warm,
    speculate: (c) => {
      if (c.level !== "claude" || guess?.key === keyOf(c)) return;
      const cleaned = run(c);
      cleaned.catch(() => undefined);
      guess = { key: keyOf(c), cleaned };
    },
    clean: async (c) => {
      const started = Date.now();
      const ready = guess?.key === keyOf(c) ? guess.cleaned : null;
      guess = null;
      const cleaned = await (ready ?? run(c)).catch(() => run(c));
      return { ...cleaned, ms: Date.now() - started };
    },
    dispose: drop,
  };
};

const fileName = "dictionary.json";

const isEntry = (value: unknown): value is DictionaryEntry =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as DictionaryEntry).phrase === "string";

export const dictionaryPath = (stateDir: string): string =>
  NodePath.join(stateDir, "voice", fileName);

const isList = (value: unknown): value is ReadonlyArray<unknown> => Array.isArray(value);

/**
 * `<state dir>/voice/dictionary.json`, a list he can edit by hand. A missing or damaged file gives
 * `fallback`, never an empty list, and a damaged one is kept aside as `.bad` for him to mend.
 */
export const readDictionary = (
  stateDir: string,
  fallback: ReadonlyArray<VocabularyEntry>,
): ReadonlyArray<VocabularyEntry> =>
  parseVocabulary(
    createJsonStore(dictionaryPath(stateDir), fallback, isList).read().filter(isEntry),
  );

/** Wispr's table, read-only, once: what he taught it should not have to be taught twice. */
export const importWisprDictionary = async (input: {
  readonly stateDir: string;
  readonly appData: string | undefined;
}): Promise<ReadonlyArray<DictionaryEntry>> => {
  if (input.appData === undefined) return [];
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(NodePath.join(input.appData, "Wispr Flow", "flow.sqlite"), {
      readOnly: true,
    });
    const rows = db
      .prepare("select phrase, replacement from Dictionary where isDeleted = 0")
      .all() as unknown as ReadonlyArray<{ phrase: string | null; replacement: string | null }>;
    db.close();
    const entries = rows.flatMap((row): ReadonlyArray<DictionaryEntry> =>
      row.phrase === null || row.phrase.length === 0
        ? []
        : [{ phrase: row.phrase, replacement: row.replacement?.length ? row.replacement : null }],
    );
    writeJsonFile(dictionaryPath(input.stateDir), entries);
    return entries;
  } catch {
    return [];
  }
};
