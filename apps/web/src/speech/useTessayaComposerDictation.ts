/**
 * Dictation drawn inside the chat box (Tessaya's composer dictation), from either source: T3's own voice input
 * (its server's speech stream) or, on the desktop, Tessaya's dictation, which streams here instead of pasting.
 * The state machine is shared with mobile (`@t3tools/baton-shared/composerDictation`); this only feeds it.
 */
import { batonDesktopBridge, type ComposerDictationMessage } from "@t3tools/baton-contracts";
import {
  CANCEL_MS,
  IDLE_DICTATION,
  PAUSE_MS,
  SETTLE_MS,
  draftAround,
  insertWords,
  stepDictation,
  type ComposerDictation,
  type DictationDraft,
} from "@t3tools/baton-shared/composerDictation";
import { waveEngine } from "@t3tools/baton-shared/waveform";
import type { VoiceInputState } from "@t3tools/client-runtime/voice-input";
import type { SpeechStreamText } from "@t3tools/contracts";
import { useEffect, useReducer, useRef, useSyncExternalStore, type RefObject } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";
import { isDictationKeyHeld, subscribeDictationKey } from "./dictationKey";

const { dbOf } = waveEngine();
const SILENT_DB = dbOf(0);

const ACTIVE = new Set<VoiceInputState["phase"]>([
  "preparing",
  "recording",
  "transcribing",
  "post-processing",
]);

/** The chat boxes on this page that can take the desktop's dictation; the one with the keyboard claims it. */
interface Composer {
  readonly take: (message: ComposerDictationMessage) => boolean | null;
  /** Its form, while it can take a dictation (not disabled). */
  readonly root: () => HTMLElement | null;
}
const composers = new Set<Composer>();
let unsubscribeBridge: (() => void) | null = null;
let reportedFocus: boolean | null = null;

/** Tells the desktop whether a chat box here has the keyboard, so it can claim a dictation before any pill shows. */
const reportFocus = (focused: Element | null) => {
  const now = focused !== null && [...composers].some((c) => c.root()?.contains(focused) === true);
  if (now === reportedFocus) return;
  reportedFocus = now;
  batonDesktopBridge()?.setComposerFocus?.(now);
};
// On focusout the element taking the keyboard is the event's relatedTarget; activeElement is not updated yet.
const onFocusIn = (event: FocusEvent) => reportFocus(event.target as Element | null);
const onFocusOut = (event: FocusEvent) => reportFocus(event.relatedTarget as Element | null);

const listen = (composer: Composer) => {
  composers.add(composer);
  const bridge = batonDesktopBridge();
  if (unsubscribeBridge === null && bridge?.onComposerDictation !== undefined) {
    const off = bridge.onComposerDictation((message) => {
      // The first composer that answers owns this dictation; the rest ignore its id.
      for (const { take } of composers) {
        const ok = take(message);
        if (ok === null) continue;
        if (message.type === "start") return { type: "claimed", id: message.id, ok };
        if (message.type === "commit") return { type: "took", id: message.id, ok };
        return null;
      }
      return message.type === "start" || message.type === "commit"
        ? { type: message.type === "start" ? "claimed" : "took", id: message.id, ok: false }
        : null;
    });
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    unsubscribeBridge = () => {
      off();
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
    };
  }
  reportFocus(document.activeElement);
  return () => {
    composers.delete(composer);
    reportFocus(document.activeElement);
    if (composers.size === 0) {
      unsubscribeBridge?.();
      unsubscribeBridge = null;
      reportedFocus = null;
    }
  };
};

export interface TessayaComposerDictation {
  readonly state: ComposerDictation;
  /** The microphone's level now in dBFS (read by the waveform each frame, never rendered). */
  readonly level: RefObject<number>;
  /** The editor stays as it was while the words are drawn over it. */
  readonly freezesEditor: boolean;
  readonly confirm: () => void;
  readonly cancel: () => void;
}

export function useTessayaComposerDictation(input: {
  readonly speech: {
    readonly state: VoiceInputState;
    readonly preview: SpeechStreamText | null;
    readonly level: number;
    stop(): Promise<void>;
    cancel(): void;
    skipPostProcessing(): void;
  };
  readonly readDraft: () => DictationDraft;
  readonly commitDraft: (text: string, selection: DictationDraft["selection"]) => void;
  readonly rootRef: RefObject<HTMLElement | null>;
  readonly disabled: boolean;
}): TessayaComposerDictation {
  const [state, dispatch] = useReducer(stepDictation, IDLE_DICTATION);
  const latest = useRef(state);
  const level = useRef(SILENT_DB);
  /** The desktop dictation this composer claimed, or null while T3's voice input drives it. */
  const desktopId = useRef<number | null>(null);
  const step = useStableCallback((event: Parameters<typeof stepDictation>[1]) => {
    latest.current = stepDictation(latest.current, event);
    dispatch(event);
  });
  const readDraft = useStableCallback(input.readDraft);
  const keyHeld = useSyncExternalStore(subscribeDictationKey, isDictationKeyHeld, () => false);

  // T3's voice input: its phases and words, mirrored into the display machine.
  const phase = input.speech.state.phase;
  const active = ACTIVE.has(phase);
  const lastPhase = useRef(phase);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mirrors the voice controller's phase changes (an external machine) into the display machine
  useEffect(() => {
    const was = lastPhase.current;
    lastPhase.current = phase;
    if (desktopId.current !== null) return;
    const wasActive = ACTIVE.has(was);
    if (!wasActive && active)
      step({ type: "start", mode: keyHeld ? "held" : "free", base: readDraft() });
    else if (was === "recording" && (phase === "transcribing" || phase === "post-processing"))
      step({ type: "finish" });
    else if (wasActive && !active) {
      // T3's voice input has placed its words already, or ended with none: the draft says which.
      const now = latest.current;
      const draft = readDraft();
      if ((now.phase !== "listening" && now.phase !== "working") || draft.text === now.base.text)
        return step({ type: "cancel" });
      const { before, after } = draftAround(now.base);
      step({
        type: "final",
        text: draft.text.slice(before.length, draft.text.length - after.length),
        committed: draft,
      });
    }
  }, [phase, active, keyHeld, readDraft, step]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a hold that turned into a tap (auto mode) is hands-free from then on
  useEffect(() => {
    if (desktopId.current === null && !keyHeld) step({ type: "mode", mode: "free" });
  }, [keyHeld, step]);
  const preview = input.speech.preview;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the speech stream's words arrive as props from the voice controller
  useEffect(() => {
    if (desktopId.current === null && preview !== null)
      step({ type: "heard", text: preview.committed, tentative: preview.tentative });
  }, [preview, step]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the waveform reads the level each animation frame, outside React
  useEffect(() => {
    if (desktopId.current === null) level.current = dbOf(input.speech.level);
  }, [input.speech.level]);

  // The settle and the fade, then plain again; a pause in his words strikes a correction.
  const heard = state.phase === "listening" || state.phase === "working" ? state.heard : null;
  const paused = (state.phase === "listening" || state.phase === "working") && state.paused;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- timers: the pause after the last words, and the end of the settle or fade
  useEffect(() => {
    if (state.phase === "settling" || state.phase === "cancelling") {
      const timer = setTimeout(
        () => step({ type: "done" }),
        state.phase === "settling" ? SETTLE_MS : CANCEL_MS,
      );
      return () => clearTimeout(timer);
    }
    if (heard === null || heard === "" || paused) return;
    const timer = setTimeout(() => step({ type: "pause" }), PAUSE_MS);
    return () => clearTimeout(timer);
  }, [state.phase, heard, paused, step]);

  // Tessaya's dictation on the desktop: the composer with the keyboard claims it and takes its words.
  const onDesktop = useStableCallback((message: ComposerDictationMessage): boolean | null => {
    if (message.type === "start") {
      const root = input.rootRef.current;
      const mine =
        !input.disabled &&
        root !== null &&
        root.contains(document.activeElement) &&
        latest.current.phase === "idle" &&
        !ACTIVE.has(input.speech.state.phase);
      if (!mine) return null;
      desktopId.current = message.id;
      level.current = SILENT_DB;
      step({ type: "start", mode: message.mode, base: input.readDraft() });
      return true;
    }
    if (message.id !== desktopId.current) return null;
    if (message.type === "mode") step({ type: "mode", mode: message.mode });
    else if (message.type === "level") level.current = message.db;
    else if (message.type === "words") step({ type: "heard", text: message.text });
    else if (message.type === "finish") step({ type: "finish" });
    else if (message.type === "cancel") {
      desktopId.current = null;
      step({ type: "cancel" });
    } else if (message.type === "commit") {
      desktopId.current = null;
      const now = latest.current;
      if (now.phase !== "listening" && now.phase !== "working") return false;
      // The draft moved under the dictation (another device, an agent): the desktop pastes it instead.
      const draft = input.readDraft();
      if (draft.text !== now.base.text) {
        step({ type: "cancel" });
        return false;
      }
      const committed = insertWords(now.base, message.text.trim());
      step({ type: "final", text: message.text, committed });
      input.commitDraft(committed.text, committed.selection);
      return true;
    }
    return true;
  });
  const root = useStableCallback(() => (input.disabled ? null : input.rootRef.current));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes this composer to the desktop's dictation channel and focus reports
  useEffect(() => listen({ take: onDesktop, root }), [onDesktop, root]);

  const confirm = useStableCallback(() => {
    const id = desktopId.current;
    if (id !== null)
      batonDesktopBridge()?.replyComposerDictation?.({ type: "action", id, insert: true });
    else if (input.speech.state.phase === "post-processing") input.speech.skipPostProcessing();
    else void input.speech.stop();
  });
  const cancel = useStableCallback(() => {
    const id = desktopId.current;
    if (id !== null)
      batonDesktopBridge()?.replyComposerDictation?.({ type: "action", id, insert: false });
    else input.speech.cancel();
  });

  return {
    state,
    level,
    freezesEditor: state.phase === "listening" || state.phase === "working",
    confirm,
    cancel,
  };
}
