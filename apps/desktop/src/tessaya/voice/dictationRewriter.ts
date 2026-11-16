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
  type Refused,
} from "@t3tools/tessaya-shared/dictationCleanup";
import type { StylePair } from "@t3tools/tessaya-shared/stylePairs";

import {
  biasTranscript,
  mergeWispr,
  parseVocabulary,
  type NeverList,
  type VocabularyEntry,
  type WisprRow,
} from "@t3tools/tessaya-shared/vocabulary";
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
  if (mode === "email" || LIST_CUE.test(text)) return [text];
  // A sentence that opens by taking back words ("Sorry, creators.", "No, I mean…") belongs with the one it corrects.
  const pieces: string[] = [];
  for (const piece of text.split(/(?<=[.!])\s+(?=\S)/)) {
    if (pieces.length > 0 && TAKES_BACK.test(piece)) pieces[pieces.length - 1] += ` ${piece}`;
    else pieces.push(piece);
  }
  return pieces;
};
const TAKES_BACK = /^(?:sorry|no|i mean|i meant|actually|or rather|scratch that|make that|wait)\b/i;

/** The whole-dictation pass writes all of it out again, so it gets longer than release's budget for what is left. */
export const wholeLimitMs = (text: string): number => Math.min(8_000, 1_500 + text.length * 4);
/** A long dictation takes longer to write out, so the limit grows with it, but it always ends. */
export const hardLimitMs = (text: string): number => Math.min(45_000, 2_500 + text.length * 8);
const IDLE_MS = 10 * 60_000;
/** Each dictation stays in the session's context, so it starts over before that matters. */
const TURNS_PER_SESSION = 20;
/**
 * Once his key answers, release waits this long for what is left, then pastes the local text. On 0.1.107 his key's
 * Haiku answered in 1.05 to 1.3 s and three of four release clean-ups were cut at the old 0.9 and 1.2 s limits
 * (2026-11-12), so this is his p90 with room for the hop to his server.
 */
const RELEASE_BUDGET_MS = 1_800;
/** Recording starts closer together than this share one warm call. */
const KEY_WARM_GAP_MS = 2_000;
/**
 * His plan's warm session, at release: Sonnet answered his presses in 0.96 s p50 and 1.28 s p95 (16 Nov, warm, effort
 * low), so past this the local text goes in and the session is let rest.
 */
const SESSION_BUDGET_MS = 3_000;
/** A plan that failed or hit its limit rests this long, his key answering meanwhile, then is tried again. */
const SESSION_REST_MS = 5 * 60_000;

interface CleanInput {
  readonly raw: string;
  readonly mode: DictationMode;
  readonly level: CleanupLevel;
  readonly context?: DictationContext;
  /**
   * The message so far right before the caret, made of his earlier dictations into this chat box: with his key it is
   * cleaned again with these words as one, so a repeat or correction across presses is settled (`message` says it was).
   */
  readonly prior?: string;
}

/** The words the model reads: his earlier dictations in this message, then these. */
const allSaid = (c: CleanInput): string =>
  c.prior === undefined || c.prior.trim() === "" ? c.raw : `${c.prior.trim()} ${c.raw.trim()}`;

export interface Rewriter {
  /** Called when recording starts, so the session is up by the time he stops. */
  readonly warm: () => void;
  /**
   * The words so far while he still holds the key: each finished sentence is cleaned now, and at a pause (`pause`,
   * the default) the last one too, so after release only what changed since is left to clean (about 1 s a turn).
   */
  readonly speculate: (input: CleanInput & { readonly pause?: boolean }) => void;
  readonly clean: (input: CleanInput) => Promise<
    CleanedText & {
      readonly ms: number;
      readonly speculated: boolean;
      /** The text is the whole message (`prior` and these words), to go in place of `prior`. */
      readonly message: boolean;
    }
  >;
  readonly dispose: () => void;
}

export const makeRewriter = (input: {
  readonly claudeBinary: string;
  /** A model he can change in Settings: a session on another model is replaced at the next clean-up. */
  readonly model: string | (() => string);
  readonly workDir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly platform: string;
  readonly dictionary: () => ReadonlyArray<DictionaryEntry>;
  /** Replaces `hardLimitMs`, for the lab and for tests. */
  readonly limitMs?: number;
  /** Replaces `wholeLimitMs`, for the lab and for tests. */
  readonly wholeLimitMs?: number;
  /** Replaces `RELEASE_BUDGET_MS`, for the lab and for tests. */
  readonly releaseBudgetMs?: number;
  readonly start?: typeof startVisionSession;
  readonly always?: boolean;
  /**
   * The optional direct API path: his own Anthropic key, kept by the server and used for nothing else. With a key
   * saved, every clean-up goes to it and a failure inserts the local text; only with none (null) does the session answer.
   */
  /** `refused` makes it the one retry: the refused answer and the reason go as their own turns after `message`. */
  readonly api?: (
    system: string,
    message: string,
    maxTokens: number,
    refused?: Refused,
  ) => Promise<string | null>;
  /**
   * While true (a dictation key is bound at the claude level), a session is always up: one that ends is replaced
   * at once and idling never ends it, so no dictation waits for Claude Code to start (about 2 s of 3.4 s cold).
   */
  readonly keepWarm?: () => boolean;
  /** His own past dictations most like this one, with what he kept (stylePairs.ts); shown to the model as examples. */
  readonly examples?: (text: string, mode: DictationMode) => ReadonlyArray<StylePair>;
  /**
   * "subscription": his own Claude plan answers first, his key only while the plan is out or at its limit (the
   * Director, 16 Nov). "key": his key first, as before. Absent is "key".
   */
  readonly route?: () => "subscription" | "key";
  /** Each answer from his plan's session, for the usage record. */
  readonly onSessionResult?: (event: Record<string, unknown>) => void;
}): Rewriter => {
  // Text already set out on this machine (a list) is only polished: examples there cost lists (18 → 12 of his 52).
  const message = (
    text: string,
    mode: DictationMode,
    context?: DictationContext,
    refused?: Refused,
  ) =>
    rewriteMessage(
      text,
      mode,
      context,
      text.includes("\n") ? [] : (input.examples?.(text, mode) ?? []),
      refused,
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
    if (input.keepWarm?.() === true) warmSession();
  };
  let prompt = "";
  let sessionModel = "";
  const get = (): VisionSession => {
    // A word he just taught is in the next clean-up, not the next session.
    const current = rewriteSystemPrompt(input.dictionary());
    const model = typeof input.model === "string" ? input.model : input.model();
    if (current !== prompt || model !== sessionModel || session?.alive() === false) drop();
    sessionModel = model;
    prompt = current;
    if (idle !== null) clearTimeout(idle);
    idle = setTimeout(() => {
      if (input.keepWarm?.() !== true) drop();
    }, IDLE_MS);
    session ??= (input.start ?? startVisionSession)({
      claudeBinary: input.claudeBinary,
      model,
      systemPrompt: current,
      workDir: input.workDir,
      env: input.env,
      platform: input.platform,
      timeoutMs: 60_000,
      // A clean-up is a rewrite, not a problem to think through: Sonnet at low effort answered in about 1 s.
      effort: "low",
      ...(input.onSessionResult === undefined ? {} : { onResult: input.onSessionResult }),
    });
    return session;
  };

  let keyWarmedAt = 0;
  /**
   * A call that writes nothing (0 tokens) as he starts speaking, so the prompt cache and the connection are ready by
   * release. Cold, his laptop's first byte took 0.96 s against 0.26 s warm (16 Nov).
   */
  const warmKey = () => {
    if (input.api === undefined || Date.now() - keyWarmedAt < KEY_WARM_GAP_MS) return;
    keyWarmedAt = Date.now();
    void input
      .api(rewriteSystemPrompt(input.dictionary()), rewriteMessage("", "default"), 0)
      .then((answer) => {
        if (answer === null) noKey = true;
      })
      .catch(() => undefined);
  };
  const warmSession = () => {
    // Key first: no subscription session is kept for clean-up, it only answers when there is no key.
    if (!planFirst() && keyRoute() && keySeen) return;
    try {
      get();
    } catch {
      drop();
    }
  };
  const warm = () => {
    if (keyRoute() && !planFirst()) warmKey();
    warmSession();
  };

  /** The session's turn in flight, by its own answer: the next question waits for it, not for a timer. */
  let busy: Promise<unknown> = Promise.resolve();
  const viaSession = (
    text: string,
    mode: DictationMode,
    context?: DictationContext,
    refused?: Refused,
  ): Promise<string> => {
    const answer = get().ask([{ type: "text", text: message(text, mode, context, refused) }]);
    busy = answer.catch(() => undefined);
    return answer.then((a) => a.trim());
  };
  /** The server said no key is saved: only then does the subscription session clean up. */
  let noKey = false;
  const keyRoute = () => input.api !== undefined && !noKey;
  /** Until then his plan rests (it failed, timed out or hit its limit) and his key answers. */
  let restUntil = 0;
  const planFirst = () => input.route?.() === "subscription" && Date.now() >= restUntil;
  const rest = () => {
    restUntil = Date.now() + SESSION_REST_MS;
  };
  /** Either route answers a whole dictation in about a second: release cleans it whole, and pauses guess the whole. */
  const quick = () => keyRoute() || planFirst();
  /** His key has answered or failed at least once, so a key is saved and the session is not needed. */
  let keySeen = false;
  /** His key answered the last clean, so release gets the short budget; until then the first call has the full limit. */
  let apiAnswers = false;
  /** Why his key last failed, so a clean that then runs out of time says what took it. */
  let apiWhy: string | null = null;
  const viaApi = async (
    text: string,
    mode: DictationMode,
    context?: DictationContext,
    refused?: Refused,
  ): Promise<string | null> => {
    if (input.api === undefined) return null;
    try {
      const answer = await input.api(
        rewriteSystemPrompt(input.dictionary()),
        message(text, mode, context),
        64 + Math.ceil(text.length / 2),
        refused,
      );
      apiAnswers = answer !== null;
      noKey = answer === null;
      keySeen = apiAnswers;
      apiWhy = null;
      if (keySeen && !planFirst()) drop();
      return answer;
    } catch (error) {
      apiAnswers = false;
      keySeen = true;
      if (!planFirst()) drop();
      apiWhy = (error instanceof Error ? error.message : "") || "failed";
      throw new Error(`key ${apiWhy}`);
    }
  };
  /**
   * With a key, the clean after release and the guesses while he speaks all go to it, from the first dictation on
   * (14 Nov: first guesses on a cold or limited session held release past its limit). No key: the subscription, and
   * each release still asks the server, so a key saved later is used at once.
   */
  const send = async (
    text: string,
    mode: DictationMode,
    final: boolean,
    context?: DictationContext,
    refused?: Refused,
  ): Promise<string> => {
    if (planFirst()) {
      try {
        return await viaSession(text, mode, context, refused);
      } catch (error) {
        // Out, or at its limit: his key answers this one and the next few minutes.
        rest();
        drop();
        if (!keyRoute()) throw error;
      }
      const paid = await viaApi(text, mode, context, refused);
      if (paid === null) throw new Error("no plan and no key");
      return paid.trim();
    }
    const paid = final || keyRoute() ? await viaApi(text, mode, context, refused) : null;
    return paid === null ? viaSession(text, mode, context, refused) : paid.trim();
  };
  const timedOut = () => new Error(apiWhy === null ? "timed out" : `timed out after key ${apiWhy}`);
  /** The real clean's question, against a deadline counted from when `clean` was called. */
  const askBy =
    (deadline: number, context?: DictationContext) =>
    async (text: string, mode: DictationMode, refused?: Refused): Promise<string> => {
      let sent = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const answer = await Promise.race([
          busy.then(() => {
            if (Date.now() >= deadline) throw timedOut();
            sent = true;
            return send(text, mode, true, context, refused);
          }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(timedOut()), deadline - Date.now());
          }),
        ]);
        turns += 1;
        return answer;
      } catch (error) {
        // Our own late answer would be read as the next dictation's, so that session goes and the next starts now.
        // Still waiting behind a guess, nothing of ours was asked: the session stays.
        if (sent) {
          // His plan too slow at release: it rests, and his key takes the next ones.
          if (planFirst() && keyRoute()) rest();
          drop();
          warmSession();
        }
        throw error;
      } finally {
        clearTimeout(timer);
        if (turns >= TURNS_PER_SESSION) renew();
      }
    };

  const run = (
    { raw, mode, level, context }: CleanInput,
    ask: (text: string, mode: DictationMode, refused?: Refused) => Promise<string>,
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
    const cleaned = run(job.input, (text, mode, refused) =>
      busy.then(() => send(text, mode, false, job.input.context, refused)),
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
    speculate: ({ pause = true, ...said }) => {
      if (said.level !== "claude") return;
      // With his key release cleans the message whole, so that is what a pause guesses.
      const c = quick() ? { ...said, raw: allSaid(said) } : said;
      // His key cleans the whole dictation at release, so a pause guesses the whole: if he stops there, release takes it.
      const pieces = quick()
        ? pause && c.raw.trim() !== ""
          ? [c.raw]
          : []
        : dictationPieces(c.raw, c.mode);
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
    clean: async (said) => {
      const started = Date.now();
      // The real clean goes before any guess still waiting.
      queue = [];
      const ready = new Map(guesses);
      const done = new Map(answered);
      guesses.clear();
      answered.clear();
      const cleanAlone = async (
        c: CleanInput,
        wholeOnly = false,
      ): Promise<CleanedText & { readonly ms: number; readonly speculated: boolean }> => {
        const limit = input.limitMs ?? hardLimitMs(c.raw);
        const deadline =
          started +
          (planFirst()
            ? Math.min(limit, SESSION_BUDGET_MS)
            : apiAnswers
              ? Math.min(limit, input.releaseBudgetMs ?? RELEASE_BUDGET_MS)
              : limit);
        const waitFor = async (cleaned: Promise<CleanedText>, by = deadline) => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const answer = await Promise.race([
            cleaned.catch(() => null),
            new Promise<null>((resolve) => {
              timer = setTimeout(() => resolve(null), by - Date.now());
            }),
          ]);
          clearTimeout(timer);
          return answer;
        };
        const wholeBy = started + (input.wholeLimitMs ?? wholeLimitMs(c.raw));
        if (quick()) {
          // The whole guessed at his last pause, answered or still on its way, is sooner than asking again now.
          const key = keyOf(c, c.raw);
          const pending = ready.get(key);
          const guessed =
            done.get(key) ?? (pending === undefined ? null : await waitFor(pending, wholeBy));
          if (guessed !== null && usable(guessed))
            return { ...guessed, ms: Date.now() - started, speculated: true };
        }
        // One call against the whole limit: the message pass, whose fallback is cleaned alongside it, and anything his
        // plan answers, one question at a time, so sentences asked one by one would only queue behind it.
        if (wholeOnly || planFirst()) {
          const by = planFirst() ? Math.max(wholeBy, deadline) : wholeBy;
          const cleaned = await run(c, askBy(by, c.context));
          return { ...cleaned, ms: Date.now() - started, speculated: false };
        }
        const pieces = dictationPieces(c.raw, c.mode);
        // With his key, more than one sentence is also cleaned whole, so a correction or fragment that crosses a
        // sentence is settled; the pieces below, cleaned meanwhile, are pasted only if the whole does not come back.
        const whole = pieces.length > 1 && quick() ? run(c, askBy(wholeBy, c.context)) : null;
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
        for (const piece of pieces) {
          const key = keyOf(c, piece);
          const guess = ready.get(key);
          // A guess still running is waited for on the subscription, where a new ask would queue behind it anyway; with
          // his key the piece is asked again at once instead, which is faster than the session's turn.
          const guessed =
            done.get(key) ?? (guess === undefined || keyRoute() ? null : await waitFor(guess));
          if (guessed === null || !usable(guessed)) {
            left.push(piece);
            continue;
          }
          await cleanLeft();
          parts.push(guessed);
        }
        await cleanLeft();
        if (parts.length === 0) parts.push(await run(c, askBy(deadline, c.context)));
        const settled = await whole?.catch(() => null);
        if (settled?.stage === "model")
          return { ...settled, ms: Date.now() - started, speculated: false };
        // The whole did not come back, so the sentences cleaned on their own go in, and the reason goes with them.
        const fellBack = parts.find((part) => part.stage === "fallback");
        const why =
          fellBack?.why ?? (whole === null ? undefined : `whole pass ${settled?.why ?? "failed"}`);
        const cleaned: CleanedText = {
          text: parts
            .map((part) => part.text.trim())
            .filter((text) => text !== "")
            .join(" "),
          stage:
            fellBack?.stage ??
            (parts.some((part) => part.stage === "model") ? "model" : parts[0]!.stage),
          ...(why === undefined ? {} : { why }),
        };
        return { ...cleaned, ms: Date.now() - started, speculated: guessedAll };
      };
      const all = allSaid(said);
      if (all === said.raw || !quick() || said.level !== "claude")
        return { ...(await cleanAlone(said)), message: false };
      // The message guessed at his last pause, answered or on its way: nothing else is asked unless it fails.
      const pendingWhole = ready.get(keyOf(said, all));
      let timer: ReturnType<typeof setTimeout> | undefined;
      const answeredWhole =
        done.get(keyOf(said, all)) ??
        (pendingWhole === undefined
          ? undefined
          : await Promise.race([
              pendingWhole.catch(() => undefined),
              new Promise<undefined>((resolve) => {
                timer = setTimeout(
                  () => resolve(undefined),
                  input.wholeLimitMs ?? wholeLimitMs(all),
                );
              }),
            ]));
      clearTimeout(timer);
      if (answeredWhole !== undefined && usable(answeredWhole))
        return { ...answeredWhole, ms: Date.now() - started, speculated: true, message: true };
      // These words on their own run meanwhile: if the message pass fails or runs out of time, they go in instead.
      const message = cleanAlone({ ...said, raw: all }, true).catch(() => null);
      // His plan answers one question at a time: the press alone is asked only if the message pass fails.
      const alone = planFirst() ? null : cleanAlone(said);
      const whole = await message;
      if (whole?.stage === "model") {
        void alone?.catch(() => undefined);
        return { ...whole, message: true };
      }
      const drafted = await (alone ?? cleanAlone(said, true));
      return {
        ...drafted,
        why: drafted.why ?? `message pass ${whole?.why ?? "failed"}`,
        ms: Date.now() - started,
        message: false,
      };
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
