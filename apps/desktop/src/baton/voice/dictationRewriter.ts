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
  type DictationContext,
  type DictationMode,
  type DictionaryEntry,
} from "@t3tools/baton-shared/dictationCleanup";
import type { StylePair } from "@t3tools/baton-shared/stylePairs";

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

/** He is about to list things ("a few things", "two problems", "firstly… secondly…", "here's what"). */
const LIST_CUE =
  /\b(?:a (?:few|couple of)|several|two|three|four|five|six|some|these|the following|multiple) (?:things|problems|issues|questions|points|reasons|steps|items|changes|bugs|tasks|ideas|types|options|features|parts)\b|\bhere(?:'s| is) what\b|\b(?:first(?:ly)?|number one)\b[\s\S]*\b(?:second(?:ly)?|number two)\b/i;

/**
 * A dictation in the pieces cleaned on their own while he speaks: split after a full stop or "!". Never after "?",
 * since a question often runs on with "and also"; never in an email, whose greeting and sign-off need the whole, or in
 * a list, which spans its sentences.
 */
export const dictationPieces = (raw: string, mode: DictationMode): ReadonlyArray<string> => {
  const text = raw.trim();
  if (text === "") return [];
  return mode === "email" || LIST_CUE.test(text) ? [text] : text.split(/(?<=[.!])\s+(?=\S)/);
};

/** A long dictation takes longer to write out, so the limit grows with it, but it always ends. */
export const hardLimitMs = (text: string): number => Math.min(45_000, 2_500 + text.length * 8);
const IDLE_MS = 10 * 60_000;
/** Each dictation stays in the session's context, so it starts over before that matters. */
const TURNS_PER_SESSION = 20;
const API_REST_MS = 60_000;
const API_SLOW_REST_MS = 15_000;

interface CleanInput {
  readonly raw: string;
  readonly mode: DictationMode;
  readonly level: CleanupLevel;
  readonly context?: DictationContext;
}

export interface Rewriter {
  /** Called when recording starts, so the session is up by the time he stops. */
  readonly warm: () => void;
  /**
   * The words so far while he still holds the key: each finished sentence is cleaned now, and at a pause (`pause`,
   * the default) the last one too, so after release only what changed since is left to clean (about 1 s a turn).
   */
  readonly speculate: (input: CleanInput & { readonly pause?: boolean }) => void;
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
   * The optional direct API path: his own Anthropic key, kept by the server and used for nothing else. It answers null
   * when no key is saved, and the subscription session answers instead.
   */
  readonly api?: (system: string, message: string, maxTokens: number) => Promise<string | null>;
  /**
   * While true (a dictation key is bound at the claude level), a session is always up: one that ends is replaced
   * at once and idling never ends it, so no dictation waits for Claude Code to start (about 2 s of 3.4 s cold).
   */
  readonly keepWarm?: () => boolean;
  /** His own past dictations most like this one, with what he kept (stylePairs.ts); shown to the model as examples. */
  readonly examples?: (text: string, mode: DictationMode) => ReadonlyArray<StylePair>;
}): Rewriter => {
  // Text already set out on this machine (a list) is only polished: examples there cost lists (18 → 12 of his 52).
  const message = (text: string, mode: DictationMode, context?: DictationContext) =>
    rewriteMessage(
      text,
      mode,
      context,
      text.includes("\n") ? [] : (input.examples?.(text, mode) ?? []),
    );
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
  const viaSession = (
    text: string,
    mode: DictationMode,
    context?: DictationContext,
  ): Promise<string> => {
    const answer = get().ask([{ type: "text", text: message(text, mode, context) }]);
    busy = answer.catch(() => undefined);
    return answer.then((a) => a.trim());
  };
  /** After a refused key or a rate limit the paid path rests for a minute, so a bad key costs one try, not every one. */
  let apiRestsUntil = 0;
  /** His key answered the last paid clean: release then asks it again rather than wait for a running guess. */
  let apiAnswers = false;
  const viaApi = async (
    text: string,
    mode: DictationMode,
    context?: DictationContext,
  ): Promise<string | null> => {
    if (input.api === undefined || Date.now() < apiRestsUntil) return null;
    try {
      const answer = await input.api(
        rewriteSystemPrompt(input.dictionary()),
        message(text, mode, context),
        64 + Math.ceil(text.length / 2),
      );
      apiAnswers = answer !== null;
      return answer;
    } catch (error) {
      apiAnswers = false;
      // A slow or unreachable API rests too, for less: each try costs his dictation up to 1.5 s before the session.
      const why = error instanceof Error ? error.message : "";
      apiRestsUntil =
        Date.now() + (/invalid-key|rate-limit/.test(why) ? API_REST_MS : API_SLOW_REST_MS);
      return null;
    }
  };
  /** Only the final clean after release goes to the paid API; the guesses while he speaks use the subscription. */
  const send = async (
    text: string,
    mode: DictationMode,
    final: boolean,
    context?: DictationContext,
  ): Promise<string> => {
    const paid = final ? await viaApi(text, mode, context) : null;
    return paid === null ? viaSession(text, mode, context) : paid.trim();
  };
  /** The real clean's question, against a deadline counted from when `clean` was called. */
  const askBy =
    (deadline: number, context?: DictationContext) =>
    async (text: string, mode: DictationMode): Promise<string> => {
      let sent = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const answer = await Promise.race([
          busy.then(() => {
            if (Date.now() >= deadline) throw new Error("timed out");
            sent = true;
            return send(text, mode, true, context);
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
    { raw, mode, level, context }: CleanInput,
    ask: (text: string, mode: DictationMode) => Promise<string>,
  ) =>
    cleanDictation({
      ...(context === undefined ? {} : { context }),
      // His own names put back first; Raw and Off keep exactly what was heard.
      raw:
        mode === "raw" || level === "off" ? raw : biasTranscript(raw, input.dictionary(), context),
      mode,
      level,
      dictionary: input.dictionary(),
      ask,
      ...(input.always === undefined ? {} : { always: input.always }),
    });
  const keyOf = (c: CleanInput, piece: string) => `${c.level}\n${c.mode}\n${piece.trim()}`;
  /** Pieces cleaned or being cleaned while he speaks, by their words; one runs at a time, the rest wait in order. */
  const guesses = new Map<string, Promise<CleanedText>>();
  /** The guesses already answered, so release can take them without waiting. */
  const answered = new Map<string, CleanedText>();
  let queue: Array<{ readonly key: string; readonly input: CleanInput }> = [];
  let guessing = false;
  const nextGuess = () => {
    const job = queue.shift();
    guessing = job !== undefined;
    if (job === undefined) return;
    // A guess is not counted against the session's turns, and is never timed out here: the session's own limit holds.
    const cleaned = run(job.input, (text, mode) =>
      busy.then(() => send(text, mode, false, job.input.context)),
    );
    guesses.set(job.key, cleaned);
    void cleaned
      .then((answer) => void answered.set(job.key, answer))
      .catch(() => undefined)
      .then(nextGuess);
  };
  /** Until the words before it are, nothing of a guess is taken: an answer that fell back is asked again. */
  const usable = (cleaned: CleanedText | null) =>
    cleaned !== null && (cleaned.stage === "model" || cleaned.stage === "local");

  return {
    warm,
    speculate: ({ pause = true, ...c }) => {
      if (c.level !== "claude") return;
      const pieces = dictationPieces(c.raw, c.mode);
      const keys = new Set(pieces.map((piece) => keyOf(c, piece)));
      // Waiting guesses his newer words no longer hold are never asked.
      queue = queue.filter((job) => keys.has(job.key));
      // Mid-speech the last sentence is still growing; at a pause it may be all of it.
      for (const piece of pause ? pieces : pieces.slice(0, -1)) {
        const key = keyOf(c, piece);
        if (guesses.has(key) || queue.some((job) => job.key === key)) continue;
        queue.push({ key, input: { ...c, raw: piece } });
      }
      if (!guessing) nextGuess();
    },
    clean: async (c) => {
      const started = Date.now();
      const deadline = started + (input.limitMs ?? hardLimitMs(c.raw));
      // The real clean goes before any guess still waiting.
      queue = [];
      const ready = new Map(guesses);
      const done = new Map(answered);
      guesses.clear();
      answered.clear();
      const waitFor = async (cleaned: Promise<CleanedText>) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const answer = await Promise.race([
          cleaned.catch(() => null),
          new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), deadline - Date.now());
          }),
        ]);
        clearTimeout(timer);
        return answer;
      };
      // Each piece cleaned while he spoke is taken as it is; the pieces left, side by side, are cleaned together now.
      const parts: CleanedText[] = [];
      let left: string[] = [];
      let guessedAll = true;
      const cleanLeft = async () => {
        if (left.length === 0) return;
        parts.push(await run({ ...c, raw: left.join(" ") }, askBy(deadline, c.context)));
        left = [];
        guessedAll = false;
      };
      for (const piece of dictationPieces(c.raw, c.mode)) {
        const key = keyOf(c, piece);
        const guess = ready.get(key);
        // A guess still running is waited for on the subscription, where a new ask would queue behind it anyway; with
        // his key the piece is asked again at once instead, which is faster than the session's turn.
        const guessed =
          done.get(key) ?? (guess === undefined || apiAnswers ? null : await waitFor(guess));
        if (guessed === null || !usable(guessed)) {
          left.push(piece);
          continue;
        }
        await cleanLeft();
        parts.push(guessed);
      }
      await cleanLeft();
      if (parts.length === 0) parts.push(await run(c, askBy(deadline, c.context)));
      const fellBack = parts.find((part) => part.stage === "fallback");
      const cleaned: CleanedText = {
        text: parts
          .map((part) => part.text.trim())
          .filter((text) => text !== "")
          .join(" "),
        stage:
          fellBack?.stage ??
          (parts.some((part) => part.stage === "model") ? "model" : parts[0]!.stage),
        ...(fellBack?.why === undefined ? {} : { why: fellBack.why }),
      };
      return { ...cleaned, ms: Date.now() - started, speculated: guessedAll };
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
