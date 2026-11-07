/* oxlint-disable t3code/no-low-value-comments -- Baton file predating upstream's rule (D82) */
// @effect-diagnostics globalDate:off - audio time is anchored to the wall clock once, at creation.
/**
 * §12.2's pipeline: frames → wake → VAD segmentation → STT → mode machine →
 * router → acknowledgement. Implements the desktop's `VoiceCore` seam and adds
 * what the local API needs (snapshot, event stream, direct-session toggle).
 *
 * Time is audio time (samples pushed ÷ 16) from a wall-clock origin: frames
 * arrive in real time on a live microphone, and a test that feeds a WAV gets
 * the same timeline every run.
 *
 * @module baton-voice/core
 */
import type { EchoGuard } from "./echoGuard.ts";
import type { ContextBusState } from "@t3tools/baton-shared/contextBus";
import { emptyContextBus } from "@t3tools/baton-shared/contextBus";
import {
  JOIN_WITHIN_MS,
  WAIT_DEFAULT_MS,
  commitMs,
  thinkAheadMs,
} from "@t3tools/baton-shared/endOfTurn";
import { isAddressedFollowUp } from "@t3tools/baton-shared/followUp";
import { isDismissPhrase } from "@t3tools/baton-shared/voiceTurn";

import {
  DEFAULT_TIMINGS,
  initialVoiceState,
  reduceVoice,
  type VoiceEffect,
  type VoiceEvent,
  type VoiceMachineState,
  type VoiceTimings,
  echoesSpeech,
  isAffirmative,
  isFiller,
  isStopPhrase,
  namedWake,
  plainWords,
  stripWake,
} from "./modeMachine.ts";
import type { RouteOutcome, VoiceRouter } from "./router.ts";
import {
  SET_ASIDE,
  VOICE_SAMPLE_RATE,
  type SttProvider,
  type TtsProvider,
  type VadProvider,
  type VoiceActivation,
  type VoiceCore,
  type VoiceState,
  type VoiceUtterance,
  type WakeProvider,
} from "./types.ts";

export interface SegmenterConfig {
  /** Silence that ends an utterance. */
  readonly endSilenceMs: number;
  /** Shorter speech is a cough, not a sentence. */
  readonly minSpeechMs: number;
  readonly maxUtteranceMs: number;
  /** Audio kept from before speech onset so the first syllable survives. */
  readonly preRollMs: number;
}

export const DEFAULT_SEGMENTER: SegmenterConfig = {
  endSilenceMs: 800,
  minSpeechMs: 250,
  maxUtteranceMs: 15_000,
  preRollMs: 300,
};

/** Reasons a drop happened over her voice: none of them is his turn, so the pill and Home stay quiet. */
export const OVER_HER_VOICE: ReadonlySet<string> = new Set([
  "own voice",
  "not a stop, said over her voice",
  "recogniser busy",
  "recognition failed",
]);

export type VoiceCoreEvent =
  | { readonly type: "state"; readonly state: VoiceState; readonly target: string | null }
  | {
      readonly type: "wake";
      readonly score: number;
      readonly at: number;
      /** Null for a hotkey, or a provider with one word. */
      readonly word: string | null;
      /** How long after the name the wake was accepted, and how much of that was the second check. */
      readonly lateMs?: number;
      readonly checkMs?: number;
    }
  /** His speech ended (silence long enough): from here the pill must not say Listening. */
  | {
      readonly type: "speech_end";
      readonly at: number;
      /** The silence after his last word that it took to say so. */
      readonly quietMs: number;
    }
  /** The audio of a segment that is going to recognition, for the history's kept clips. */
  | { readonly type: "audio"; readonly pcm: Int16Array; readonly at: number }
  /** A segment went to speech recognition. */
  /** Someone is cutting in over Baton's own voice (a wake word, or his voice heard through the echo). */
  | { readonly type: "barge_in" }
  /** Probably him over it: lower the voice now; `on: false` when it turned out not to be. */
  | { readonly type: "barge_duck"; readonly on: boolean }
  | { readonly type: "thinking" }
  /** Speech recognition came back with nothing usable. */
  | { readonly type: "nothing" }
  /** Heard and set aside: silence after a wake, a lone filler, its own voice over the speakers. */
  | {
      readonly type: "dropped";
      readonly text: string;
      readonly reason: string;
      /** The wake model's score, for a wake set aside as her own voice. */
      readonly score?: number;
    }
  /** He said only a dismissal ("never mind"): the window ended at once, no model was asked. */
  | { readonly type: "dismissed"; readonly text: string; readonly at: number }
  /** He said a stop phrase over Baton's voice. No wake word needed. */
  | { readonly type: "stop_heard"; readonly text: string; readonly at: number }
  | {
      readonly type: "transcript";
      readonly text: string;
      readonly at: number;
      /** For the turn log: how long recognition took, and the end-of-turn wait after it. */
      readonly recogniseMs?: number;
      readonly holdMs?: number;
    }
  | { readonly type: "effect"; readonly effect: VoiceEffect }
  | { readonly type: "outcome"; readonly outcome: RouteOutcome }
  | { readonly type: "error"; readonly message: string };

export interface VoiceCoreSnapshot {
  readonly state: VoiceState;
  readonly machine: VoiceMachineState;
  readonly lastTranscript: string | null;
  readonly currentTarget: string | null;
}

export interface SpokenQuestion {
  readonly answer: Promise<"yes" | "no" | "expired">;
  /** Answered some other way. */
  readonly cancel: () => void;
}

export interface BatonVoiceCore extends VoiceCore {
  readonly snapshot: () => VoiceCoreSnapshot;
  readonly subscribe: (listener: (event: VoiceCoreEvent) => void) => () => void;
  readonly setDirectSession: (enabled: boolean) => void;
  /** Start or stop dictation as "Tessaya, dictate" does; resolves with whether it is now dictating. */
  readonly setDictation: (on: boolean) => Promise<boolean>;
  /**
   * Baton's voice started or stopped, wherever it came from. While it plays, and for a moment
   * after, the mic hears Baton: only a wake word gets through.
   */
  readonly setSpeaking: (active: boolean) => void;
  /** What the player is about to play (16 kHz mono) and when it will sound, so his voice can be told from it. */
  readonly reference: (pcm: Int16Array, soundsAtMs: number) => void;
  /**
   * A cue (a short sound of Baton's own) will play for this long: for that long the wake detector and
   * the segmenter are given silence instead of the microphone, so the cue can neither wake it nor
   * be written into a dictation. Gating, not subtracting: the cue's exact place in the capture
   * depends on the output device's latency, which is not known.
   */
  readonly playingCue: (ms: number) => void;
  /** He is in the middle of an utterance right now. */
  readonly hearingSpeech: () => boolean;
  /** A sentence Baton is saying, so a stop phrase in it is not taken for his. */
  readonly noteSpoken: (text: string) => void;
  readonly setContext: (bus: ContextBusState) => void;
  /**
   * A yes or no asked aloud, on the same rules as any confirmation: a later utterance, never the
   * wake word, and never Baton's own voice. Runs out to "expired".
   */
  readonly confirm: (prompt: string) => SpokenQuestion;
  /** Feed a typed/known utterance as if transcribed (tests, push-to-talk text). */
  readonly hear: (text: string) => Promise<void>;
  /** Resolves when every queued transcription and route has finished. */
  readonly idle: () => Promise<void>;
}

/** Speech ends a little after the player says so, and a room rings on. */
const ECHO_TAIL_MS = 500;
/** How far back a wake check listens: the name and what came just before it. */
const WAKE_LOOKBACK_MS = 1_600;
/** The wake word's own tail reads as speech: it opens no turn by itself. */
const WAKE_TAIL_MS = 200;
/** Audio kept behind the newest frame, so a wake scored late (a busy computer just after launch) still finds the name and what followed. */
const RECENT_MS = 30_000;
/** However long the speech after held words takes to recognise, they are let go after this. */
const JOIN_WAIT_MAX_MS = 15_000;
const STOP_MIN_SPEECH_MS = 120;
const STOP_END_SILENCE_MS = 350;
/** Over the speakers his voice never falls silent to the VAD, so a window this long is cut. */
const STOP_MAX_MS = 2_000;
/** Generation reads ahead of playback, so this covers what is playing now. */
const SPOKEN_KEPT = 12;
/** Speech over her voice for this long ducks it, and for this long cuts in: well inside the 300 ms to stop. */
const DUCK_MS = 40;
const BARGE_MS = 120;

const NOISE = /^(?:\[[^\]]*\]|\([^)]*\)|\s|[.,!?…-])*$/;

export const createVoiceCore = (input: {
  readonly wake: WakeProvider;
  readonly vad: VadProvider;
  readonly stt: SttProvider;
  /** The stop listener's recogniser: always this computer's, since it hears the room while she talks. `stt` when absent. */
  readonly stopStt?: SttProvider;
  readonly tts?: TtsProvider | null;
  /** Absent: the core only emits utterances and the host routes them. */
  readonly router?: VoiceRouter | null;
  readonly timings?: VoiceTimings;
  readonly segmenter?: SegmenterConfig;
  readonly directSession?: boolean;
  readonly origin?: number;
  /** How long he must be quiet for a turn to be over: his setting, read each turn. */
  readonly waitMs?: () => number;
  /**
   * The second check before a wake from sleep: the audio just before the model fired. False drops the
   * wake as if it never happened. Absent, the model alone decides.
   */
  readonly verifyWake?: (pcm: Int16Array, word: string | null, score: number) => Promise<boolean>;
  /** The model is sure enough of this word that her saying the name too cannot make it her echo. */
  readonly trustWake?: (word: string, score: number) => boolean;
  /** Hears him over Baton's own voice through the speakers (docs/baton/BARGE_IN.md). Absent: only a wake or stop phrase gets through. */
  readonly echo?: EchoGuard;
  /** Headphones: the mic cannot hear the voice, so it listens all the time and his speech over it is a barge-in. */
  readonly speakerMode?: () => "speakers" | "headphones";
}): BatonVoiceCore => {
  const timings = input.timings ?? DEFAULT_TIMINGS;
  const seg = input.segmenter ?? DEFAULT_SEGMENTER;
  const origin = input.origin ?? Date.now();
  let samples = 0;
  const now = () => origin + (samples * 1000) / VOICE_SAMPLE_RATE;

  let machine = initialVoiceState(input.directSession ?? false);
  let bus: ContextBusState = emptyContextBus;
  let lastTranscript: string | null = null;
  let lastTarget: string | null = null;
  let disposed = false;

  const stateListeners = new Set<(state: VoiceState) => void>();
  const utteranceListeners = new Set<(u: VoiceUtterance) => void>();
  const listeners = new Set<(event: VoiceCoreEvent) => void>();
  const emit = (event: VoiceCoreEvent) => listeners.forEach((l) => l(event));

  // Segmentation state.
  const msToSamples = (ms: number) => Math.round((ms * VOICE_SAMPLE_RATE) / 1000);
  const preRoll: Int16Array[] = [];
  let preRollSamples = 0;
  /** The last few seconds, by where each frame ends, for the audio a wake check looks back over. */
  const recent: Array<{ readonly frame: Int16Array; readonly end: number }> = [];
  /**
   * A wake waiting on its second check. The sentence after the name is segmented as it is said and waits
   * for the answer, so a slow check (right after launch) neither swallows the next sentence nor repeats this one.
   */
  interface Fire {
    readonly verdict: Promise<boolean>;
    /** The fire opened the segment (rather than landing in one already being heard). */
    made: boolean;
    /** Its segment: being heard, gone to recognition, or never opened (or thrown away under her voice). */
    segment: "open" | "finished" | "none";
    ok: boolean | null;
  }
  let segmentFire: Fire | null = null;
  /** The wake word the sentence being routed answers to, set in queue order so each sentence has its own. */
  let addressee: string | null = null;
  let segment: Int16Array[] | null = null;
  let speechSamples = 0;
  let silenceSamples = 0;
  let segmentSamples = 0;
  let work: Promise<void> = Promise.resolve();

  const publicState = (): VoiceState => {
    if (machine.mode !== "sleeping") return machine.mode;
    // A wake the check has not confirmed shows nothing.
    const unconfirmed = segmentFire !== null && segmentFire.made && segmentFire.ok !== true;
    return segment !== null && !unconfirmed ? "listening" : "sleeping";
  };
  let shown: VoiceState | null = null;
  let shownTarget: string | null = null;
  const show = () => {
    const state = publicState();
    const target = machine.conversationTarget;
    if (state === shown && target === shownTarget) return;
    shown = state;
    shownTarget = target;
    stateListeners.forEach((l) => l(state));
    emit({ type: "state", state, target });
  };

  const asked = new Map<string, (answer: "yes" | "no" | "expired") => void>();
  let questions = 0;
  const confirm = (prompt: string): SpokenQuestion => {
    questions += 1;
    const token = `spoken-${questions}`;
    const answer = new Promise<"yes" | "no" | "expired">((resolve) => asked.set(token, resolve));
    enqueue(() => dispatch({ type: "request_confirmation", token, prompt, at: now() }));
    return {
      answer,
      cancel: () => {
        asked.delete(token);
        enqueue(() => dispatch({ type: "clear_pending", token, at: now() }));
      },
    };
  };

  const modeOf = (
    effect: VoiceEffect,
    before: VoiceMachineState,
  ): VoiceUtterance["mode"] | null => {
    if (effect.kind === "dictate") return "dictation";
    if (effect.kind === "session_message") return "direct_session";
    if (effect.kind === "command")
      return before.mode === "conversation" ? "conversation" : "command_window";
    return null;
  };

  /** A turn handed to the router whose reply has not started: later speech can still join it. */
  interface Flight {
    readonly text: string;
    readonly endAt: number;
    readonly abort: () => void;
  }
  let flight: Flight | null = null;
  /** Words heard and waiting out the end-of-turn pause before the router sees them. */
  interface Held {
    readonly text: string;
    readonly endAt: number;
    releaseAt: number;
    /** When to start thinking out the reply (`thinkAhead`), and whether it has. */
    readonly thinkAt: number;
    thought: boolean;
    readonly settle: (kept: boolean) => void;
  }
  let held: Held | null = null;
  /**
   * A command thought out during the end-of-turn pause, read-only (`VoiceRouter.prepare`). It goes on only
   * when the same words reach the router with the same context; otherwise it is never sent.
   */
  let ahead: {
    readonly effect: VoiceEffect;
    readonly bus: ContextBusState;
    readonly target: string | null;
    readonly wake: string | null;
    readonly go: Promise<() => Promise<RouteOutcome>>;
  } | null = null;
  const wakeOf = (text: string) => namedWake(text, timings.wakeWords ?? []) ?? addressee;
  const thinkAhead = (text: string) => {
    ahead = null;
    const prepare = input.router?.prepare;
    if (prepare === undefined) return;
    const { effects } = reduceVoice(machine, { type: "utterance", text, at: now() }, timings);
    const [effect] = effects;
    if (effects.length !== 1 || effect?.kind !== "command") return;
    const wake = wakeOf(text);
    const context = { bus, now: now(), mostRecentWorkSessionId: lastTarget, wake };
    const go = prepare(effect, context);
    // A discarded one fails quietly; a kept one fails where it is awaited.
    go.catch(() => undefined);
    ahead = { effect, bus, target: lastTarget, wake, go };
  };
  let transcribing = 0;
  /** Where each segment still being recognised began, so held words wait for speech that may join them. */
  const recognising = new Set<number>();
  let current: { readonly text: string; readonly endAt: number } = { text: "", endAt: 0 };
  const waitMs = () => input.waitMs?.() ?? WAIT_DEFAULT_MS;

  const dismissNow = (text: string) => {
    held?.settle(false);
    flight?.abort();
    flight = null;
    const result = reduceVoice(machine, { type: "dismiss", at: now() }, timings);
    machine = result.state;
    for (const effect of result.effects) {
      if (effect.kind !== "cancelled") continue;
      asked.get(effect.token)?.("no");
      asked.delete(effect.token);
    }
    show();
    emit({ type: "dismissed", text, at: now() });
  };

  const handle = async (effects: ReadonlyArray<VoiceEffect>, before: VoiceMachineState) => {
    for (const effect of effects) {
      emit({ type: "effect", effect });
      if (effect.kind === "confirmed" || effect.kind === "cancelled") {
        const answer = asked.get(effect.token);
        if (answer !== undefined) {
          asked.delete(effect.token);
          answer(
            // Superseded by another sentence or question is a no: the turn waiting on it must end, not wait on.
            effect.kind === "confirmed" ? "yes" : effect.reason === "expired" ? "expired" : "no",
          );
          continue;
        }
      }
      const mode = modeOf(effect, before);
      if (mode !== null && "text" in effect)
        utteranceListeners.forEach((l) => l({ text: effect.text, mode }));
      if (effect.kind === "speak") await say(effect.text);
      if (input.router == null) continue;
      const turn = effect.kind === "command" || effect.kind === "session_message";
      let abort = () => {};
      const dropped = new Promise<null>((resolve) => {
        abort = () => resolve(null);
      });
      const mine: Flight = { text: current.text, endAt: current.endAt, abort };
      if (turn) flight = mine;
      // "Tessaya, …" said in Freya's open window is for Tessaya, and so is what he says next without a name.
      if (turn) addressee = wakeOf(current.text);
      const early = effect.kind === "command" ? ahead : null;
      if (effect.kind === "command") ahead = null;
      const thought =
        early !== null &&
        JSON.stringify(early.effect) === JSON.stringify(effect) &&
        early.bus === bus &&
        early.target === lastTarget &&
        early.wake === addressee;
      const outcome = await Promise.race([
        thought
          ? // He may carry on while it is still being thought out: then it never acts.
            early.go.then((go) => (flight === mine ? go() : null))
          : input.router.route(effect, {
              bus,
              now: now(),
              mostRecentWorkSessionId: lastTarget,
              wake: addressee,
            }),
        ...(turn ? [dropped] : []),
      ]);
      if (flight === mine) flight = null;
      // He carried on or dismissed: this turn's reply is not wanted.
      if (outcome === null || outcome.kind === "none") continue;
      emit({ type: "outcome", outcome });
      if (outcome.kind === "needs_confirmation") {
        await dispatch({
          type: "request_confirmation",
          token: outcome.token,
          prompt: outcome.prompt,
          at: now(),
        });
        continue;
      }
      const target =
        outcome.kind === "ran"
          ? outcome.workSessionId
          : outcome.kind === "sent_to_session"
            ? outcome.workSessionId
            : null;
      if (target !== null) {
        lastTarget = target;
        // Follow-ups inherit what this command touched (§12.3 conversation mode).
        await dispatch({ type: "set_target", workSessionId: target, at: now() });
      }
      if ("reply" in outcome && outcome.reply) await say(outcome.reply);
    }
  };

  const say = async (text: string) => {
    if (input.tts == null) return;
    setSpeaking(true);
    try {
      await input.tts.speak(text);
    } catch (error) {
      emit({ type: "error", message: `TTS: ${(error as Error).message}` });
    } finally {
      setSpeaking(false);
    }
  };

  const dispatch = async (event: VoiceEvent) => {
    const before = machine;
    const result = reduceVoice(machine, event, timings);
    machine = result.state;
    show();
    if (result.effects.length > 0) await handle(result.effects, before);
  };

  const enqueue = (job: () => Promise<void>) => {
    work = work
      .then(job)
      .catch((error: unknown) => emit({ type: "error", message: (error as Error).message }));
  };

  const hear = (text: string) => {
    enqueue(async () => {
      const cleaned = text.trim();
      if (NOISE.test(cleaned)) return;
      lastTranscript = cleaned;
      emit({ type: "transcript", text: cleaned, at: now() });
      await dispatch({ type: "utterance", text: cleaned, at: now() });
    });
    return work;
  };

  const finishSegment = () => {
    const parts = segment;
    const spoken = speechSamples;
    const overItself = barged;
    barged = false;
    const fire = segmentFire;
    segmentFire = null;
    if (fire !== null) fire.segment = "finished";
    // A segment its wake opened waits for the check: nothing is shown or recognised for a fire that was not the name.
    const waitFor = fire !== null && fire.made && fire.ok !== true ? fire.verdict : null;
    const after = (show: () => void) =>
      waitFor === null ? show() : void waitFor.then((ok) => ok && !disposed && show());
    if (speakingLater !== null) {
      const latest = speakingLater;
      speakingLater = null;
      setSpeaking(latest);
    }
    const quietMs = Math.round((silenceSamples * 1000) / VOICE_SAMPLE_RATE);
    segment = null;
    speechSamples = 0;
    silenceSamples = 0;
    segmentSamples = 0;
    input.vad.reset();
    // Ended while its wake was still being checked (a busy machine): the detector may not have scored his
    // command yet, so recognition decides whether there were words, once the wake is confirmed.
    const checking = waitFor !== null;
    // Some speech, however little: a clip the detector scored as all silence is not worth recognising.
    if (parts === null || (spoken < msToSamples(seg.minSpeechMs) && !(checking && spoken > 0))) {
      // Only the name and the pause after it, its check still running: once confirmed, the wake opens
      // again from the audio kept since it fired, so "Freya, … bring Notepad to the front" keeps its words.
      if (parts !== null && checking && fire !== null) {
        fire.segment = "none";
        return show();
      }
      if (parts !== null) after(() => emit({ type: "dropped", text: "", reason: "no speech" }));
      return show();
    }
    const pcm = joined(parts);
    const endAt = now();
    after(() => {
      emit({ type: "speech_end", at: endAt, quietMs });
      emit({ type: "audio", pcm, at: endAt });
      emit({ type: "thinking" });
    });
    const turn = {
      startAt: endAt - (pcm.length * 1000) / VOICE_SAMPLE_RATE,
      endAt,
      prefix: null as string | null,
      consumed: false,
      /** Its own wake word was said: it starts a new turn, never the end of the last one. */
      woken: fire !== null,
    };
    transcribing += 1;
    recognising.add(turn.startAt);
    let recogniseMs = 0;
    const recognise = () => {
      const began = Date.now();
      return input.stt.transcribe(pcm).finally(() => (recogniseMs = Date.now() - began));
    };
    const heard = (
      waitFor === null ? recognise() : waitFor.then((ok) => (ok ? recognise() : ""))
    ).finally(() => {
      transcribing -= 1;
      recognising.delete(turn.startAt);
    });
    // Read the moment recognition returns, not when the queue behind a reply frees: a dismissal
    // ends everything at once, and speech that resumes soon after joins the turn before it.
    void heard.then((text) => readEarly(text.trim(), turn)).catch(() => undefined);
    enqueue(async () => {
      if (waitFor !== null && !(await waitFor)) return;
      const text = await heard;
      const cleaned = text.trim();
      const dictating = machine.mode === "dictation";
      if (text === SET_ASIDE) return;
      if (NOISE.test(cleaned)) return dictating ? undefined : emit({ type: "nothing" });
      if (turn.consumed) return;
      if (
        !dictating &&
        machine.pending === null &&
        isFiller(stripWake(cleaned, timings.wakeWords))
      ) {
        return emit({ type: "dropped", text: cleaned, reason: "filler" });
      }
      // Baton's own reply can say a wake word and "confirm": a yes must not start over its voice.
      // Stop and cancel still count, and the question just runs out.
      if (
        overItself &&
        machine.pending !== null &&
        isAffirmative(stripWake(cleaned, timings.wakeWords))
      ) {
        return emit({ type: "nothing" });
      }
      const said = turn.prefix === null ? cleaned : `${turn.prefix} ${cleaned}`;
      // In the follow-up window nobody said the name: only what reads as meant for Tessaya goes on, and
      // the rest is let go without extending the window, so a TV in the room cannot keep it open.
      // Her own last sentence was a question: whatever he says next is the answer.
      if (
        machine.mode === "conversation" &&
        machine.pending === null &&
        stripWake(cleaned, timings.wakeWords) === cleaned &&
        !(spokenLately.at(-1)?.trim().endsWith("?") ?? false) &&
        !isAddressedFollowUp(said)
      ) {
        return emit({ type: "dropped", text: cleaned, reason: "not addressed" });
      }
      const joinable =
        machine.pending === null &&
        (machine.mode === "command_window" || machine.mode === "conversation");
      const holding = Date.now();
      if (joinable && waitMs() > 0) {
        const kept = await holdForMore(said, turn.endAt, turn.endAt - quietMs);
        if (!kept) return;
      }
      lastTranscript = said;
      emit({
        type: "transcript",
        text: said,
        at: now(),
        recogniseMs,
        holdMs: Date.now() - holding,
      });
      current = { text: said, endAt: turn.endAt };
      // Begun while the window was open: a slow recogniser (right after launch) must not let it close under these words.
      if (machine.deadline !== null && turn.startAt <= machine.deadline)
        await dispatch({ type: "keep_open", at: now() });
      await dispatch({ type: "utterance", text: said, at: now() });
      ahead = null;
    });
    show();
  };

  const readEarly = (
    cleaned: string,
    turn: { startAt: number; prefix: string | null; consumed: boolean; woken: boolean },
  ) => {
    if (
      cleaned === SET_ASIDE ||
      NOISE.test(cleaned) ||
      machine.mode === "dictation" ||
      machine.pending !== null
    )
      return;
    const words = stripWake(cleaned, timings.wakeWords);
    const awake = machine.mode === "command_window" || machine.mode === "conversation";
    if (isDismissPhrase(words) && (awake || words !== cleaned)) {
      turn.consumed = true;
      return dismissNow(cleaned);
    }
    if (!awake || isFiller(words) || turn.woken) return;
    const near = (endAt: number) => turn.startAt - endAt <= JOIN_WITHIN_MS;
    if (held !== null && near(held.endAt)) {
      turn.prefix = held.text;
      held.settle(false);
    } else if (flight !== null && near(flight.endAt)) {
      turn.prefix = flight.text;
      flight.abort();
      flight = null;
    }
  };

  /** Wait out the end-of-turn pause for these words; false when later speech took them over. */
  const holdForMore = (text: string, endAt: number, lastWordAt: number): Promise<boolean> =>
    new Promise((resolve) => {
      const words = stripWake(text, timings.wakeWords);
      const mine: Held = {
        text,
        endAt,
        // commitMs is silence after his last word, and the segmenter has already waited out part of it.
        releaseAt: lastWordAt + commitMs(waitMs(), words),
        thinkAt: lastWordAt + thinkAheadMs(waitMs(), words),
        thought: false,
        settle: (kept) => {
          if (held === mine) held = null;
          if (!kept) ahead = null;
          resolve(kept);
        },
      };
      held = mine;
    });

  const joined = (parts: ReadonlyArray<Int16Array>) => {
    const pcm = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
      pcm.set(p, o);
      o += p.length;
    }
    return pcm;
  };

  // A separate path from `work`: that queue waits on routing and on speech, which is what he
  // is trying to stop. One transcription at a time; a window that arrives during one is skipped.
  const spokenLately: string[] = [];
  const noteSpoken = (text: string) => {
    spokenLately.push(text);
    spokenLately.splice(0, Math.max(0, spokenLately.length - SPOKEN_KEPT));
  };
  let stopFrames: Int16Array[] = [];
  let stopSamples = 0;
  let stopSpeech = 0;
  let stopQuiet = 0;
  let stopBusy = false;
  const clearStop = () => {
    stopFrames = [];
    stopSamples = 0;
    stopSpeech = 0;
    stopQuiet = 0;
  };
  const finishStop = () => {
    const parts = stopFrames;
    const spoken = stopSpeech;
    clearStop();
    if (spoken < msToSamples(STOP_MIN_SPEECH_MS)) return;
    // Busy: the newest clip waits its turn, so his latest words are heard; only an older waiting one goes.
    if (stopBusy) {
      if (stopWaiting !== null) emit({ type: "dropped", text: "", reason: "recogniser busy" });
      stopWaiting = parts;
      return;
    }
    recogniseStop(parts);
  };
  let stopWaiting: Int16Array[] | null = null;
  const recogniseStop = (parts: Int16Array[]) => {
    stopBusy = true;
    void (input.stopStt ?? input.stt)
      .transcribe(joined(parts))
      .then((text) => {
        // Over speakers the window starts inside her sentence, so his stop is at the end of it.
        const words = text.trim().split(/\s+/).filter(Boolean);
        const said = [1, 2, 3, 4]
          .map((n) => stripWake(words.slice(-n).join(" "), timings.wakeWords))
          .find(isStopPhrase);
        const hers = spokenLately.slice(-2);
        if (said === undefined) {
          if (words.length > 0)
            emit({
              type: "dropped",
              text: text.trim(),
              reason: echoesSpeech(text, hers) ? "own voice" : "not a stop, said over her voice",
            });
          return;
        }
        // Only the sentence she is saying (or just said) can have put the word there. A clip that is
        // nothing but the command ("Stop.") is his, unless she said that command on its own too.
        const whole = isStopPhrase(stripWake(words.join(" "), timings.wakeWords));
        const sheSaidIt = hers
          .flatMap((sentence) => sentence.split(/(?<=[.!?])\s+/))
          .some((part) => isStopPhrase(part) && plainWords(part) === plainWords(said));
        if ((!whole || sheSaidIt) && echoesSpeech(said, hers)) {
          return emit({ type: "dropped", text: said, reason: "own voice" });
        }
        // Stopped: whatever waited behind this clip was said over a voice that has gone.
        stopWaiting = null;
        emit({ type: "stop_heard", text: said, at: now() });
      })
      .catch(() => emit({ type: "dropped", text: "", reason: "recognition failed" }))
      .finally(() => {
        stopBusy = false;
        const next = stopWaiting;
        stopWaiting = null;
        if (next === null || disposed) return;
        // Only while she still speaks: once she has stopped, the stop listener has nothing to stop.
        if (hearingItself()) recogniseStop(next);
        else emit({ type: "dropped", text: "", reason: "recogniser busy" });
      });
  };
  const watchForStop = (frame: Int16Array) => {
    const speech = input.vad.isSpeech(frame);
    if (stopFrames.length === 0) {
      if (!speech) return;
      stopFrames = [...preRoll];
      stopSamples = preRollSamples;
    }
    stopFrames.push(frame);
    stopSamples += frame.length;
    if (speech) {
      stopSpeech += frame.length;
      stopQuiet = 0;
    } else stopQuiet += frame.length;
    if (stopQuiet >= msToSamples(STOP_END_SILENCE_MS) || stopSamples >= msToSamples(STOP_MAX_MS)) {
      finishStop();
    }
  };

  let speaking = false;
  let spokeFrom = 0;
  let echoUntil = 0;
  /** Speech before this sample is the wake word's tail. */
  let creditFrom = 0;
  /** A wake word cut in, and what he says next is being heard. Nothing may drop it. */
  let barged = false;
  /** What the speaker did while his words were being heard, applied when they end. */
  let speakingLater: boolean | null = null;
  const setSpeaking = (active: boolean) => {
    if (barged) {
      speakingLater = active;
      return;
    }
    if (active && !speaking) spokeFrom = samples;
    speaking = active;
    if (active) {
      // What was being heard is now mixed with Baton's own voice.
      if (segmentFire !== null) segmentFire.segment = "none";
      segmentFire = null;
      segment = null;
      speechSamples = 0;
      silenceSamples = 0;
      segmentSamples = 0;
    } else echoUntil = samples + msToSamples(ECHO_TAIL_MS);
    enqueue(() => dispatch({ type: "keep_open", at: now() }));
  };
  const headphones = () => input.speakerMode?.() === "headphones";
  const hearingItself = () => !headphones() && (speaking || samples < echoUntil);
  /** Was the microphone hearing her at this sample? A name the scorer reports late is judged by when it was said. */
  const heardItselfAt = (at: number) =>
    !headphones() && at >= spokeFrom && (speaking || at < echoUntil);
  let bargeRun = 0;
  /** The last sample the echo guard (or, on headphones, the detector) heard him over her voice. */
  let lastNearEndAt = -Infinity;
  /** The detector's scored speech, as of the last frame. */
  let scoredSpeech = 0;
  let ducked = false;
  let cueUntil = 0;

  /** Should speech be segmented right now? Only when something will listen. */
  const listening = () => machine.mode !== "sleeping" || segment !== null;

  /** Hear what follows a name said at `firedAt`, starting the utterance there if none is being heard. */
  const openAt = (firedAt: number, late: boolean): boolean => {
    const made = segment === null;
    // Start the utterance at the wake: "hey jarvis, what's…" is one breath. A wake confirmed late keeps
    // everything said since it fired, so the first words after the name are not lost to the check.
    if (segment === null) {
      const from = firedAt - msToSamples(seg.preRollMs);
      const upTo = from + msToSamples(seg.maxUtteranceMs);
      const kept = late
        ? recent.filter((r) => r.end > from && r.end <= upTo).map((r) => r.frame)
        : [...preRoll];
      segment = kept;
      segmentSamples = late ? kept.reduce((n, f) => n + f.length, 0) : preRollSamples;
      scoredSpeech = input.vad.scored?.().speech ?? 0;
      // The detector did not run while asleep, so what came after the name counts as speech until it says
      // otherwise; recognition decides whether it was words.
      speechSamples = late
        ? recent
            .filter((r) => r.end > firedAt + msToSamples(WAKE_TAIL_MS))
            .reduce((n, r) => n + r.frame.length, 0)
        : 0;
    }
    creditFrom = firedAt + msToSamples(WAKE_TAIL_MS);
    silenceSamples = 0;
    return made;
  };

  const acceptWake = (
    score: number,
    firedAt: number,
    word: string | null,
    late: boolean,
    checkMs?: number,
    open = true,
  ) => {
    if (speaking || hearingItself()) {
      speaking = false;
      echoUntil = 0;
      barged = true;
      clearStop();
      emit({ type: "barge_in" });
    }
    emit({
      type: "wake",
      score,
      at: now(),
      word,
      lateMs: Math.round(((samples - firedAt) * 1000) / VOICE_SAMPLE_RATE),
      ...(checkMs === undefined ? {} : { checkMs }),
    });
    if (open) openAt(firedAt, late);
  };
  /** The machine's side of a wake, in queue order: every sentence queued after it answers to this word. */
  const woke = (word: string | null) => async () => {
    addressee = word;
    await dispatch({ type: "wake", at: now() });
  };

  const pushAudio = (heard: Int16Array) => {
    if (disposed) return;
    // Inside a cue's window the microphone is replaced by silence for everything downstream.
    const frame = samples < cueUntil ? new Int16Array(heard.length) : heard;
    samples += frame.length;

    const score = input.wake.process(frame);
    const wakeWord = score === null ? null : (input.wake.lastWord?.() ?? null);
    const firedAt = samples - Math.min(samples, input.wake.firedAgo?.() ?? 0);
    // The model at its ceiling is his: unless she was speaking then, where her own clean "Tessaya" scores the
    // same, and only his voice heard over hers around then makes it his.
    const sure =
      score !== null &&
      wakeWord !== null &&
      input.trustWake?.(wakeWord, score) === true &&
      (!heardItselfAt(firedAt) || lastNearEndAt >= firedAt - msToSamples(WAKE_LOOKBACK_MS));
    if (
      score !== null &&
      heardItselfAt(firedAt) &&
      wakeWord !== null &&
      echoesSpeech(wakeWord, spokenLately) &&
      !sure
    ) {
      // The reply itself says the name: it is its own voice, never a barge-in.
      emit({ type: "dropped", text: wakeWord, reason: "own voice", score });
    } else if (score !== null) {
      // Over its own voice too: a barge-in needs the recogniser to hear the name, not just the model.
      if (input.verifyWake !== undefined && machine.mode !== "dictation" && !sure) {
        // The model alone is not enough, asleep or in a follow-up window (where a false fire would play the
        // cue, flash the pill and extend the window): recognise what was just said first.
        const checkFrom = samples;
        const fire: Fire = {
          verdict: input
            .verifyWake(
              joined(
                recent
                  .filter(
                    (r) => r.end > firedAt - msToSamples(WAKE_LOOKBACK_MS) && r.end <= firedAt,
                  )
                  .map((r) => r.frame),
              ),
              wakeWord,
              score,
            )
            .catch(() => true),
          made: false,
          segment: "none",
          ok: null,
        };
        // Over her voice the segment waits for the answer: a barge-in then takes what he said from `recent`.
        if (!hearingItself()) {
          fire.made = openAt(firedAt, firedAt < samples);
          fire.segment = "open";
          segmentFire = fire;
        }
        enqueue(async () => {
          if (await fire.verdict) await woke(wakeWord)();
        });
        void fire.verdict.then((ok) => {
          fire.ok = ok;
          if (disposed) return;
          if (!ok) emit({ type: "dropped", text: "", reason: "wake not confirmed" });
          else {
            const checkMs = Math.round(((samples - checkFrom) * 1000) / VOICE_SAMPLE_RATE);
            acceptWake(score, firedAt, wakeWord, true, checkMs, fire.segment === "none");
          }
          show();
        });
      } else {
        acceptWake(score, firedAt, wakeWord, firedAt < samples);
        enqueue(woke(wakeWord));
      }
    } else if (machine.deadline !== null || machine.pending !== null) {
      const at = now();
      // The window waits only for speech to START. Words that have begun, or are being recognised, are never
      // cut off by it, however long they go on; the end-of-speech silence ends them.
      const hearingHim = segment !== null || transcribing > 0;
      enqueue(() => dispatch({ type: speaking || hearingHim ? "keep_open" : "tick", at }));
    }

    if (held !== null) {
      const at = now();
      // Still speaking, or recognition still running on more of it: not yet.
      const busy = segment !== null || transcribing > 0;
      const endAt = held.endAt;
      const joins = (start: number) => start - endAt <= JOIN_WITHIN_MS;
      // Speech that began inside the pause will join these words once recognised, however slowly.
      const coming =
        (segment !== null && joins(at - (segmentSamples * 1000) / VOICE_SAMPLE_RATE)) ||
        [...recognising].some(joins);
      const cap = coming ? JOIN_WAIT_MAX_MS : 3_000;
      // Probably the end: the reply is thought out while the pause runs, and kept only if he stays quiet.
      if (!held.thought && !busy && at >= held.thinkAt && at < held.releaseAt) {
        held.thought = true;
        thinkAhead(held.text);
      }
      if (at >= held.releaseAt && (!busy || at >= held.releaseAt + cap)) held.settle(true);
    }

    // His voice over hers: through the echo guard over speakers, or plain speech detection on headphones.
    if (speaking && !barged) {
      const flagged = headphones()
        ? input.vad.isSpeech(frame)
        : input.echo !== undefined &&
          ((v) => v.ready && v.nearEnd)(input.echo.process(frame, Date.now()));
      bargeRun = flagged ? bargeRun + frame.length : 0;
      if (flagged) lastNearEndAt = samples;
      if (bargeRun >= msToSamples(BARGE_MS)) {
        const onset = bargeRun;
        bargeRun = 0;
        if (ducked) emit({ type: "barge_duck", on: false });
        ducked = false;
        acceptWake(1, samples - onset, null, true);
        enqueue(woke(null));
      } else if (bargeRun >= msToSamples(DUCK_MS) && !ducked) {
        ducked = true;
        emit({ type: "barge_duck", on: true });
      } else if (bargeRun === 0 && ducked) {
        ducked = false;
        emit({ type: "barge_duck", on: false });
      }
    } else if (bargeRun > 0) {
      bargeRun = 0;
      if (ducked) emit({ type: "barge_duck", on: false });
      ducked = false;
    }

    if (hearingItself()) watchForStop(frame);
    else if (stopFrames.length > 0) clearStop();

    if (listening() && !hearingItself()) {
      const speech = input.vad.isSpeech(frame);
      // Counted from what the detector has scored, not its last answer: frames it has not reached (a burst after a
      // stall) are neither speech nor silence yet.
      const scored = input.vad.scored?.();
      const freshSpeech = scored === undefined ? 0 : scored.speech - scoredSpeech;
      if (scored !== undefined) scoredSpeech = scored.speech;
      if (segment === null && speech) {
        segment = [...preRoll];
        segmentSamples = preRollSamples;
      }
      if (segment !== null) {
        segment.push(frame);
        segmentSamples += frame.length;
        if (scored !== undefined) {
          if (samples >= creditFrom) speechSamples += freshSpeech;
          silenceSamples = Math.min(scored.quiet, segmentSamples);
        } else if (speech) {
          if (samples >= creditFrom) speechSamples += frame.length;
          silenceSamples = 0;
        } else {
          silenceSamples += frame.length;
        }
        if (
          silenceSamples >=
            msToSamples(machine.mode === "dictation" ? seg.endSilenceMs : seg.endSilenceMs * 0.7) ||
          segmentSamples >= msToSamples(seg.maxUtteranceMs)
        ) {
          finishSegment();
        }
      }
    }

    recent.push({ frame, end: samples });
    while (recent.length > 0 && recent[0]!.end < samples - msToSamples(RECENT_MS)) recent.shift();
    preRoll.push(frame);
    preRollSamples += frame.length;
    while (preRollSamples - (preRoll[0]?.length ?? 0) >= msToSamples(seg.preRollMs)) {
      preRollSamples -= preRoll.shift()!.length;
    }
    show();
  };

  const activate = (activation: VoiceActivation) => {
    if (activation === "wake") {
      emit({ type: "wake", score: 1, at: now(), word: null });
      enqueue(woke(null));
    } else if (activation === "dismiss") enqueue(() => dispatch({ type: "dismiss", at: now() }));
    else if (activation === "toggle_direct_session") {
      enqueue(() =>
        dispatch({ type: "set_direct_session", enabled: !machine.directSession, at: now() }),
      );
    }
    // toggle_mute is the desktop's: it stops frames before they reach here.
  };

  show();
  return {
    pushAudio,
    activate,
    onState: (l) => {
      stateListeners.add(l);
      return () => stateListeners.delete(l);
    },
    onUtterance: (l) => {
      utteranceListeners.add(l);
      return () => utteranceListeners.delete(l);
    },
    dispose: () => {
      disposed = true;
      stateListeners.clear();
      utteranceListeners.clear();
      listeners.clear();
    },
    snapshot: () => ({
      state: publicState(),
      machine,
      lastTranscript,
      currentTarget: machine.conversationTarget ?? lastTarget,
    }),
    setSpeaking,
    reference: (pcm, soundsAtMs) => input.echo?.reference(pcm, soundsAtMs),
    playingCue: (ms) => {
      cueUntil = Math.max(cueUntil, samples + msToSamples(ms));
    },
    hearingSpeech: () => segment !== null,
    noteSpoken,
    confirm,
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    setDirectSession: (enabled) =>
      enqueue(() => dispatch({ type: "set_direct_session", enabled, at: now() })),
    setDictation: async (on) => {
      enqueue(() => dispatch({ type: "set_dictation", on, at: now() }));
      await work;
      return machine.mode === "dictation";
    },
    setContext: (next) => {
      bus = next;
    },
    hear,
    idle: async () => {
      await Promise.all([input.wake.drain?.(), input.vad.drain?.()]);
      await work;
    },
  };
};
