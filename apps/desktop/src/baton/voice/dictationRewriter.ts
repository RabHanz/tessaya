// @effect-diagnostics globalTimers:off globalDate:off nodeBuiltinImport:off
/**
 * The optional second pass: his own `claude` through the companion's session, so it bills his plan
 * and has no tools (D84). It can never hold dictation up: past `HARD_LIMIT_MS` the local text goes
 * in, the session is dropped, and the next dictation starts another.
 */
import * as NodeFS from "node:fs";
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

import {
  biasTranscript,
  mergeWispr,
  parseVocabulary,
  type NeverList,
  type VocabularyEntry,
  type WisprRow,
} from "@t3tools/baton-shared/vocabulary";
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
  readonly clean: (
    input: CleanInput,
  ) => Promise<CleanedText & { readonly ms: number; readonly speculated: boolean }>;
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
  /**
   * While true (a dictation key is bound at the claude level), a session is always up: one that ends is replaced
   * at once and idling never ends it, so no dictation waits for Claude Code to start (about 2 s of 3.4 s cold).
   */
  readonly keepWarm?: () => boolean;
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
  /** Drops the session; the next is started now when it should stay warm. */
  const renew = () => {
    drop();
    if (input.keepWarm?.() === true) warm();
  };
  let prompt = "";
  const get = (): VisionSession => {
    // A word he just taught is in the next clean-up, not the next session.
    const current = rewriteSystemPrompt(input.dictionary());
    if (current !== prompt || session?.alive() === false) drop();
    prompt = current;
    if (idle !== null) clearTimeout(idle);
    idle = setTimeout(() => {
      if (input.keepWarm?.() !== true) drop();
    }, IDLE_MS);
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

  /** The session's turn in flight, by its own answer: the next question waits for it, not for a timer. */
  let busy: Promise<unknown> = Promise.resolve();
  const send = (text: string, mode: DictationMode): Promise<string> => {
    const answer = get().ask([{ type: "text", text: rewriteMessage(text, mode) }]);
    busy = answer.catch(() => undefined);
    return answer.then((a) => a.trim());
  };
  /** The real clean's question, against a deadline counted from when `clean` was called. */
  const askBy =
    (deadline: number) =>
    async (text: string, mode: DictationMode): Promise<string> => {
      let sent = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const answer = await Promise.race([
          busy.then(() => {
            if (Date.now() >= deadline) throw new Error("timed out");
            sent = true;
            return send(text, mode);
          }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("timed out")), deadline - Date.now());
          }),
        ]);
        turns += 1;
        return answer;
      } catch (error) {
        // Our own late answer would be read as the next dictation's, so that session goes and the next starts now.
        // Still waiting behind a guess, nothing of ours was asked: the session stays.
        if (sent) {
          drop();
          warm();
        }
        throw error;
      } finally {
        clearTimeout(timer);
        if (turns >= TURNS_PER_SESSION) renew();
      }
    };

  const run = (
    { raw, mode, level }: CleanInput,
    ask: (text: string, mode: DictationMode) => Promise<string>,
  ) =>
    cleanDictation({
      // His own names put back first; Raw and Off keep exactly what was heard.
      raw: mode === "raw" || level === "off" ? raw : biasTranscript(raw, input.dictionary()),
      mode,
      level,
      dictionary: input.dictionary(),
      ask,
      ...(input.always === undefined ? {} : { always: input.always }),
    });
  const keyOf = (c: CleanInput) => `${c.level}\n${c.mode}\n${c.raw.trim()}`;
  /** The latest guess started, one at most in flight, and the newest waiting behind it; older ones are never asked. */
  let guess: { readonly key: string; readonly cleaned: Promise<CleanedText> } | null = null;
  let guessing = false;
  let waiting: CleanInput | null = null;
  const startGuess = (c: CleanInput) => {
    const key = keyOf(c);
    guessing = true;
    // A guess is not counted against the session's turns, and is never timed out here: the session's own limit holds.
    const cleaned = run(c, (text, mode) =>
      busy.then(() => (guess?.key === key ? send(text, mode) : Promise.reject(new Error("stale")))),
    );
    guess = { key, cleaned };
    void cleaned
      .catch(() => undefined)
      .then(() => {
        guessing = false;
        const next = waiting;
        waiting = null;
        if (next !== null) startGuess(next);
      });
  };

  return {
    warm,
    speculate: (c) => {
      if (c.level !== "claude") return;
      const key = keyOf(c);
      if (guess?.key === key || (waiting !== null && keyOf(waiting) === key)) return;
      if (guessing) waiting = c;
      else startGuess(c);
    },
    clean: async (c) => {
      const started = Date.now();
      const deadline = started + (input.limitMs ?? hardLimitMs(c.raw));
      // The real clean goes before any guess still waiting, and only a guess for these exact words is taken.
      waiting = null;
      const ready = guess?.key === keyOf(c) ? guess.cleaned : null;
      guess = null;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const guessed =
        ready === null
          ? null
          : await Promise.race([
              ready.catch(() => null),
              new Promise<null>((resolve) => {
                timer = setTimeout(() => resolve(null), deadline - Date.now());
              }),
            ]);
      clearTimeout(timer);
      const cleaned =
        guessed !== null && (guessed.stage === "model" || guessed.stage === "local")
          ? guessed
          : await run(c, askBy(deadline));
      return { ...cleaned, ms: Date.now() - started, speculated: cleaned === guessed };
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

/** Set once Wispr's table has been read in, so a word he deleted since does not come back from there. */
const wisprMarker = (stateDir: string) => NodePath.join(stateDir, "voice", "wispr-imported.json");

/**
 * Wispr's table, read-only, once: what he taught it should not have to be taught twice. The words join his
 * vocabulary with the forms Wispr mis-heard them as; the snippets go to `putSnippet`. A missing Wispr changes
 * nothing and is looked for again next start.
 */
export const importWispr = async (input: {
  readonly stateDir: string;
  readonly appData: string | undefined;
  readonly entries: ReadonlyArray<VocabularyEntry>;
  readonly never?: NeverList;
  readonly putSnippet?: (snippet: { readonly cue: string; readonly text: string }) => void;
}): Promise<ReadonlyArray<VocabularyEntry>> => {
  if (input.appData === undefined || NodeFS.existsSync(wisprMarker(input.stateDir)))
    return input.entries;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(NodePath.join(input.appData, "Wispr Flow", "flow.sqlite"), {
      readOnly: true,
    });
    const rows = db
      .prepare(
        "select phrase, replacement, observedSource, isSnippet, frequencyUsed from Dictionary where isDeleted = 0",
      )
      .all() as unknown as ReadonlyArray<WisprRow>;
    db.close();
    const merged = mergeWispr(
      input.entries,
      rows,
      input.never,
      !NodeFS.existsSync(dictionaryPath(input.stateDir)),
    );
    for (const snippet of merged.snippets) input.putSnippet?.(snippet);
    writeJsonFile(dictionaryPath(input.stateDir), merged.entries);
    writeJsonFile(wisprMarker(input.stateDir), { at: new Date().toISOString() });
    return merged.entries;
  } catch {
    return input.entries;
  }
};
