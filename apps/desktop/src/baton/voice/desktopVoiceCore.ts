/* oxlint-disable t3code/no-low-value-comments -- Baton file predating upstream's rule (D82) */
// @effect-diagnostics nodeBuiltinImport:off
/**
 * The real voice core (`@t3tools/baton-voice`) behind the desktop's
 * `makeCore` seam: openWakeWord → Silero VAD → whisper.cpp → the §12.3 mode
 * machine → the core's router, whose four intent calls are answered here.
 *
 * The router keeps its safety rules (high risk refused by voice, medium risk
 * needs a later spoken "confirm", dictation stays local); this module only
 * says where each call goes on a desktop.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { BatonFocusTarget, BatonIntentResolution } from "@t3tools/baton-contracts";
import {
  createOpenWakeWordProvider,
  createOsTts,
  createSileroVad,
  createVoiceCore,
  createVoiceRouter,
  DEFAULT_TIMINGS,
  type BatonVoiceCore,
  type EchoGuard,
  type OpenWakeWordPaths,
  type OpenWakeWordScorer,
  type RouteOutcome,
  type SileroScorer,
  type SpeakerIdentity,
  type SttProvider,
  type TtsProvider,
  type VoiceCoreEvent,
  type VoiceIntentClient,
  type VoiceRouter,
  type WakeWordModel,
} from "@t3tools/baton-voice";
import type { CutIn } from "@t3tools/baton-shared/endOfTurn";
import {
  applyContextSnapshot,
  emptyContextBus,
  resolveContextWorkSession,
  type ContextBusState,
} from "@t3tools/baton-shared/contextBus";
import type { TextInjectionAdapter } from "@t3tools/baton-shared/injection";

const VOICE_FEATURE_FILES = ["melspectrogram.onnx", "embedding_model.onnx", "silero_vad.onnx"];

/** One wake word as the tray and `fabric-voice.json` hold it. */
export interface WakeWordSetting {
  readonly word: string;
  readonly enabled: boolean;
  readonly threshold: number;
}

export interface VoiceAssets {
  /** The bundled models; a user's own `<word>.onnx` in `userModelsDir` wins. */
  readonly modelsDir: string;
  readonly userModelsDir: string;
}

/** Settings win, then the env var the core's own tests read, then what shipped with the app. */
export const resolveVoiceAssets = (input: {
  readonly stateDir: string;
  readonly resourcesPath: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly modelsDir?: string | null;
}): VoiceAssets => {
  const userModelsDir = NodePath.join(input.stateDir, "voice", "models");
  return {
    modelsDir:
      input.modelsDir ??
      input.env["BATON_VOICE_MODELS"] ??
      NodePath.join(input.resourcesPath, "baton-voice", "models"),
    userModelsDir,
  };
};

/** A wake word's model file name, in his models folder or the shipped one. */
export const wakeModelFile = (word: string) =>
  `${word.toLowerCase().replace(/[^a-z0-9]+/g, "_")}.onnx`;

/** Wake words the app can actually load: a word with no model is dropped, not a startup failure. */
export const resolveWakeModels = (
  assets: VoiceAssets,
  words: ReadonlyArray<WakeWordSetting>,
  exists: (path: string) => boolean = NodeFS.existsSync,
): { readonly models: ReadonlyArray<WakeWordModel>; readonly missing: ReadonlyArray<string> } => {
  const models: WakeWordModel[] = [];
  const missing: string[] = [];
  for (const { word, enabled, threshold } of words) {
    if (!enabled) continue;
    const file = wakeModelFile(word);
    const path = [assets.userModelsDir, assets.modelsDir]
      .map((dir) => NodePath.join(dir, file))
      .find(exists);
    if (path === undefined) missing.push(word);
    else models.push({ word, path, threshold });
  }
  return { models, missing };
};

export const missingVoiceAssets = (
  assets: VoiceAssets,
  exists: (path: string) => boolean = NodeFS.existsSync,
): ReadonlyArray<string> =>
  VOICE_FEATURE_FILES.map((file) => NodePath.join(assets.modelsDir, file)).filter(
    (path) => !exists(path),
  );

/** What the desktop's renderer answers: the intent bar's own two RPCs. */
export type VoiceIntentRequest =
  | {
      readonly kind: "resolve";
      readonly text: string;
      readonly focusedWorkSessionId: string | null;
      readonly allowModel: boolean;
    }
  | { readonly kind: "run"; readonly text: string; readonly focusedWorkSessionId: string | null };

/**
 * Direct-session speech as the grammar's colon form, with the session pinned
 * as the focus: the message reaches it word for word, through the same gates
 * as typing it would.
 */
export const sessionMessageSentence = (text: string): string => `Tell it: ${text.trim()}`;

export const makeVoiceIntentClient = (input: {
  readonly request: (request: VoiceIntentRequest) => Promise<unknown>;
  readonly injection: TextInjectionAdapter;
  readonly field: BatonFocusTarget;
}): VoiceIntentClient => {
  const run = (text: string, focusedWorkSessionId: string | null) =>
    input.request({ kind: "run", text, focusedWorkSessionId }) as Promise<{
      readonly resolution: BatonIntentResolution;
      readonly reply: string;
    }>;
  return {
    resolve: (request) =>
      input.request({ kind: "resolve", ...request }) as Promise<BatonIntentResolution>,
    run: ({ text, focusedWorkSessionId }) => run(text, focusedWorkSessionId),
    sendToSession: async ({ workSessionId, text }) => ({
      reply: (await run(sessionMessageSentence(text), workSessionId)).reply,
    }),
    insertText: async ({ text }) => {
      try {
        await input.injection.insertText({ target: input.field, text });
        return { inserted: true };
      } catch {
        return { inserted: false };
      }
    },
  };
};

/**
 * The context bus the router reads: what Baton has open (§14 rung 3) and,
 * where this desktop can paste, the focused field as a dictation target.
 */
export const desktopVoiceContext = (input: {
  readonly focusedWorkSessionId: string | null;
  readonly field: BatonFocusTarget | null;
  readonly observedAt: Date;
}): ContextBusState => {
  const base = {
    observedAt: input.observedAt.toISOString(),
    foregroundApplication: null,
    activeWindowTitle: null,
    activeThreadId: null,
    vscode: null,
    browser: null,
    recentVoiceTarget: null,
  };
  let bus = applyContextSnapshot(emptyContextBus, {
    ...base,
    producer: "fabric",
    activeWorkSessionId: input.focusedWorkSessionId as never,
    editableTarget: null,
  });
  if (input.field !== null) {
    bus = applyContextSnapshot(bus, {
      ...base,
      producer: "desktop",
      activeWorkSessionId: null,
      editableTarget: input.field,
    });
  }
  return bus;
};

/** The one brain as the voice router sees it (D100). */
export interface BrainVoiceHook {
  /** Decides what was said: already under way, or refused with the reply to speak. */
  readonly said: (
    text: string,
    input: {
      readonly direct: boolean;
      readonly typed?: boolean;
      readonly session?: string | null;
      /** The wake word that opened this window, which picks the persona; null for a hotkey. */
      readonly wake?: string | null;
      /** He cut her off: what she had said by then. */
      readonly cutIn?: CutIn | null;
      /** Whose voice said it (Voice ID). */
      readonly speaker?: SpeakerIdentity | null;
    },
  ) => Promise<{ readonly kind: "handled" } | { readonly kind: "refused"; readonly reply: string }>;
}

/**
 * Everything said outside dictation goes to the one assistant, behind One Trust.
 * Dictation is never in here: `dictate` effects pass straight through. Its only model is the
 * clean-up pass, when he has chosen it (D105).
 */
export const withBrainRoutes = (inner: VoiceRouter, brain: BrainVoiceHook): VoiceRouter => ({
  route: async (effect, context) => {
    if (effect.kind !== "command" && effect.kind !== "session_message") {
      return inner.route(effect, context);
    }
    const direct = effect.kind === "session_message";
    // Only a session he is looking at, never "the one that moved last": that is a guess.
    const focused = resolveContextWorkSession(context.bus, { now: context.now });
    const decision = await brain.said(effect.text, {
      direct,
      session:
        focused.workSessionId === null ? null : `${focused.workSessionId} (${focused.evidence})`,
      wake: context.wake ?? null,
      cutIn: context.cutIn ?? null,
      speaker: context.speaker ?? null,
    });
    return decision.kind === "refused"
      ? { kind: "refused", reply: decision.reply, reason: "high_risk" }
      : { kind: "ran", reply: "", workSessionId: null, source: "screen" };
  },
});

/** A spoken command Baton answers itself (adding a word to his dictionary) before the brain sees it. */
export const withPreempt = (
  inner: VoiceRouter,
  preempt: (text: string) => Promise<string | null>,
): VoiceRouter => {
  const answered = (reply: string): RouteOutcome => ({
    kind: "ran",
    reply,
    workSessionId: null,
    source: "intent",
  });
  const prepare = inner.prepare;
  return {
    route: async (effect, context) => {
      if (effect.kind === "command") {
        const reply = await preempt(effect.text);
        if (reply !== null) return answered(reply);
      }
      return inner.route(effect, context);
    },
    // The preempt writes his dictionary, so it waits for `go` like everything else that acts.
    ...(prepare === undefined
      ? {}
      : {
          prepare: async (effect, context) => {
            // A failed read must not lose a dictionary command: the preempt runs first, at go.
            const go = prepare(effect, context);
            go.catch(() => undefined);
            return async () => {
              const reply = await preempt(effect.text);
              return reply === null ? (await go)() : answered(reply);
            };
          },
        }),
  };
};

/** Timings read at each use, so a change in Settings counts at the next wake without restarting the voice. */
type Timings = typeof DEFAULT_TIMINGS & { readonly wakeWords?: ReadonlyArray<string> };

export const liveTimings = (
  base: Timings,
  read?: () => { readonly commandWindowMs: number; readonly conversationMs: number },
): Timings =>
  Object.defineProperties(
    { ...base },
    {
      commandWindowMs: {
        enumerable: true,
        get: () => read?.().commandWindowMs ?? base.commandWindowMs,
      },
      conversationMs: {
        enumerable: true,
        get: () => read?.().conversationMs ?? base.conversationMs,
      },
    },
  );

export const createDesktopVoiceCore = async (input: {
  readonly assets: VoiceAssets;
  readonly wakeWords: ReadonlyArray<WakeWordSetting>;
  /** Parakeet in the desktop's dictation sidecar; a test can pass anything. */
  readonly stt: SttProvider;
  /** The stop listener's recogniser: this computer's, since it hears the room while she talks. */
  readonly stopStt?: SttProvider;
  readonly platform: NodeJS.Platform;
  readonly intent: VoiceIntentClient;
  /** Replies and confirmation prompts, for the HUD's line. */
  readonly onReply?: (text: string) => void;
  readonly origin?: number;
  readonly brain?: BrainVoiceHook;
  readonly vocabulary?: (text: string) => Promise<string | null>;
  readonly waitMs?: () => number;
  /** How long the command window and the conversation stay open, read each time they are used. */
  readonly listening?: () => { readonly commandWindowMs: number; readonly conversationMs: number };
  /** The second check before a wake from sleep. */
  readonly verifyWake?: (
    pcm: Int16Array,
    word: string | null,
    score: number,
  ) => Promise<boolean | null>;
  readonly trustWake?: (word: string, score: number) => boolean;
  readonly claim?: Parameters<typeof createVoiceCore>[0]["claim"];
  /** He is recording with the dictation keys (the sidecar): a lone wake must not end that. */
  readonly recording?: () => boolean;
  /** Baton's one voice; off in tests. */
  readonly tts?: TtsProvider | null;
  /** Everything the core reports, for the cue after a wake word. */
  readonly onEvent?: (event: VoiceCoreEvent) => void;
  /** Hears him over Baton's own voice through the speakers. */
  readonly echo?: EchoGuard;
  /** Voice ID: whose voice each turn and each cut-in is (speakerIdentity.ts). */
  readonly speaker?: Parameters<typeof createVoiceCore>[0]["speaker"];
  readonly speakerMode?: () => "speakers" | "headphones";
  /** Where the wake and speech models run; in this process when absent (tests, scripts). */
  readonly scorers?: {
    readonly wake: (
      paths: OpenWakeWordPaths,
    ) => Promise<OpenWakeWordScorer & { readonly close: () => void }>;
    readonly vad: (path: string) => Promise<SileroScorer & { readonly close: () => void }>;
  };
}): Promise<{ readonly core: BatonVoiceCore; readonly drain: () => Promise<void> }> => {
  const missing = missingVoiceAssets(input.assets);
  if (missing.length > 0) {
    throw new Error(
      `Voice models missing: ${missing.map((p) => NodePath.basename(p)).join(", ")} (in ${input.assets.modelsDir}).`,
    );
  }
  const { models, missing: noModel } = resolveWakeModels(input.assets, input.wakeWords);
  if (models.length === 0) {
    throw new Error(
      noModel.length > 0
        ? `No wake model for ${noModel.join(", ")}.`
        : "Every wake word is switched off.",
    );
  }
  const at = (file: string) => NodePath.join(input.assets.modelsDir, file);
  // Voice off disposes the core; its models are then released, so a worker crash does not reload them.
  const releases: Array<() => void> = [];
  const hosted =
    <A, T extends { readonly close: () => void }>(make: (arg: A) => Promise<T>) =>
    async (arg: A) => {
      const scorer = await make(arg);
      releases.push(scorer.close);
      return scorer;
    };
  const wake = await createOpenWakeWordProvider(
    {
      melspectrogram: at("melspectrogram.onnx"),
      embedding: at("embedding_model.onnx"),
      wakes: models,
    },
    input.scorers === undefined ? undefined : hosted(input.scorers.wake),
  );
  const vad = await createSileroVad(
    at("silero_vad.onnx"),
    undefined,
    input.scorers === undefined ? undefined : hosted(input.scorers.vad),
  );
  const core = createVoiceCore({
    wake,
    vad,
    stt: input.stt,
    ...(input.stopStt === undefined ? {} : { stopStt: input.stopStt }),
    timings: liveTimings(
      { ...DEFAULT_TIMINGS, wakeWords: models.map((model) => model.word) },
      input.listening,
    ),
    tts: input.tts === undefined ? createOsTts(input.platform) : input.tts,
    router: ((router) =>
      input.vocabulary === undefined ? router : withPreempt(router, input.vocabulary))(
      input.brain === undefined
        ? createVoiceRouter(input.intent)
        : withBrainRoutes(createVoiceRouter(input.intent), input.brain),
    ),
    ...(input.origin === undefined ? {} : { origin: input.origin }),
    ...(input.waitMs === undefined ? {} : { waitMs: input.waitMs }),
    ...(input.verifyWake === undefined ? {} : { verifyWake: input.verifyWake }),
    ...(input.trustWake === undefined ? {} : { trustWake: input.trustWake }),
    ...(input.claim === undefined ? {} : { claim: input.claim }),
    ...(input.recording === undefined ? {} : { recording: input.recording }),
    ...(input.echo === undefined ? {} : { echo: input.echo }),
    ...(input.speakerMode === undefined ? {} : { speakerMode: input.speakerMode }),
    ...(input.speaker === undefined ? {} : { speaker: input.speaker }),
  });
  const dispose = core.dispose;
  Object.assign(core, {
    dispose: () => {
      dispose();
      for (const release of releases) release();
    },
  });
  if (input.onEvent !== undefined) core.subscribe(input.onEvent);
  if (input.onReply !== undefined) {
    const onReply = input.onReply;
    core.subscribe((event) => {
      if (event.type !== "outcome") return;
      const outcome = event.outcome;
      if (outcome.kind === "needs_confirmation") onReply(outcome.prompt);
      else if ("reply" in outcome && outcome.reply) onReply(outcome.reply);
    });
  }
  return {
    core,
    drain: async () => {
      await wake.drain();
      await vad.drain();
    },
  };
};
