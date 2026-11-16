/**
 * Dictation drawn inside the chat box (Tessaya's composer dictation), from either source: T3's own voice input
 * (its server's speech stream) or, on the desktop, Tessaya's dictation, which streams here instead of pasting.
 * The state machine is shared with mobile (`@t3tools/tessaya-shared/composerDictation`); this only feeds it.
 */
import { batonDesktopBridge, type ComposerDictationMessage } from "@t3tools/tessaya-contracts";
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
} from "@t3tools/tessaya-shared/composerDictation";
import { waveEngine } from "@t3tools/tessaya-shared/waveform";
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

/** The chat boxes on this page that can take the desktop's dictation; `target` claims it. */
interface Composer {
  readonly take: (message: ComposerDictationMessage) => boolean | null;
  readonly root: () => HTMLElement | null;
  /** Not disabled: it can take a dictation. */
  readonly ready: () => boolean;
  /** What the desktop's clean-up should know as this box claims: the message so far and the reply he is answering. */
  readonly said: () => { readonly prior?: string; readonly replyingTo?: string };
}
const composers = new Set<Composer>();
/**
 * The chat box a dictation starts in: the one he last focused or clicked (its microphone keeps the keyboard where it
 * was), or the one in the pane he last clicked. Another text field taking the keyboard clears it, so the desktop pastes.
 */
let target: Composer | null = null;
let unsubscribeBridge: (() => void) | null = null;
let reportedFocus: boolean | null = null;

const holding = (node: Node | null) =>
  node === null ? null : ([...composers].find((c) => c.root()?.contains(node) === true) ?? null);
/** The only chat box inside the closest ancestor of `node` that holds any; null on a tie (outside every pane). */
const nearest = (node: Node | null): Composer | null => {
  for (let at = node; at !== null; at = at.parentNode) {
    const box = at;
    const inside = [...composers].filter((c) => {
      const root = c.root();
      return root !== null && box.contains(root);
    });
    if (inside.length > 0) return inside.length === 1 ? (inside[0] ?? null) : null;
  }
  return null;
};
const TEXT_FIELD =
  "textarea, [contenteditable]:not([contenteditable='false']), input:not([type=button], [type=submit], [type=checkbox], [type=radio], [type=range])";

/** Tells the desktop whether a chat box here takes the next dictation, so it can claim it before any pill shows. */
const reportFocus = () => {
  const now = target?.ready() === true;
  if (now === reportedFocus) return;
  reportedFocus = now;
  batonDesktopBridge()?.setComposerFocus?.(now);
};
const onPointerDown = (event: PointerEvent) => {
  target = nearest(event.target as Node | null) ?? target;
  reportFocus();
};
const onFocusIn = (event: FocusEvent) => {
  const element = event.target as Element | null;
  const composer = holding(element);
  if (composer !== null) target = composer;
  else if (element?.matches(TEXT_FIELD) === true) target = null;
  reportFocus();
};

const listen = (composer: Composer) => {
  composers.add(composer);
  const bridge = batonDesktopBridge();
  if (unsubscribeBridge === null && bridge?.onComposerDictation !== undefined) {
    const off = bridge.onComposerDictation((message) => {
      // A start goes to the target alone; after that its id routes every message, wherever focus went since.
      const asked = message.type === "start" ? (target === null ? [] : [target]) : composers;
      for (const { take, said } of asked) {
        const ok = take(message);
        if (ok === null) continue;
        if (message.type === "start")
          return { type: "claimed", id: message.id, ok, ...(ok ? said() : {}) };
        if (message.type === "commit") return { type: "took", id: message.id, ok };
        return null;
      }
      return message.type === "start" || message.type === "commit"
        ? { type: message.type === "start" ? "claimed" : "took", id: message.id, ok: false }
        : null;
    });
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("focusin", onFocusIn);
    unsubscribeBridge = () => {
      off();
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("focusin", onFocusIn);
    };
  }
  // A chat box that took the keyboard as it mounted did so before this listened.
  target ??= holding(document.activeElement);
  reportFocus();
  return () => {
    composers.delete(composer);
    if (target === composer) target = holding(document.activeElement);
    reportFocus();
    if (composers.size === 0) {
      unsubscribeBridge?.();
      unsubscribeBridge = null;
      target = null;
      reportedFocus = null;
    }
  };
};

export interface TessayaComposerDictation {
  readonly state: ComposerDictation;
  /** The microphone's level now in dBFS (read by the waveform each frame, never rendered). */
  readonly level: RefObject<number>;
  /** Words are coming: a send now would leave them behind. */
  readonly live: boolean;
  readonly confirm: () => void;
  readonly cancel: () => void;
  /** He sent `text`: what Tessaya's dictation put in goes to the desktop beside it, so his fixes teach. */
  readonly sent: (text: string) => void;
}

/** The message so far that his dictations made, if the text before the caret still ends with it. */
const priorAt = (draft: DictationDraft, dictated: string): string | undefined => {
  const prior = dictated.trim();
  return prior !== "" && draftAround(draft).before.trimEnd().endsWith(prior) ? prior : undefined;
};

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
  /** The reply he is answering, read as a dictation starts. */
  readonly replyingTo?: () => string | undefined;
}): TessayaComposerDictation {
  /** What Tessaya's dictations put in this draft since it was last sent, as one message. */
  const dictated = useRef("");
  /** The draft as his last dictation left it: what he sends is read against it, whatever he fixed since. */
  const leftAs = useRef("");
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

  // Tessaya's dictation on the desktop: the target composer (`listen`) claims it and takes its words.
  const onDesktop = useStableCallback((message: ComposerDictationMessage): boolean | null => {
    if (message.type === "start") {
      const mine =
        !input.disabled &&
        input.rootRef.current !== null &&
        // A press right after the last one lands here too, cutting its settle or fade short.
        latest.current.phase !== "listening" &&
        latest.current.phase !== "working" &&
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
      // At the caret as it is now, wherever he moved it or whatever changed in the draft while he spoke.
      const draft = input.readDraft();
      const replace = message.replace?.trim() ?? "";
      const replacing = replace !== "" && priorAt(draft, replace) !== undefined;
      // The whole message cleaned again goes in place of his earlier dictations; if he changed them, these words only.
      const words = (replace !== "" && !replacing ? (message.alone ?? "") : message.text).trim();
      const { before, after } = draftAround(draft);
      const cut = before.trimEnd().length - replace.length;
      const base = replacing
        ? { text: before.slice(0, cut) + after, selection: { start: cut, end: cut } }
        : draft;
      const prior = replacing ? undefined : priorAt(draft, dictated.current);
      dictated.current = prior === undefined ? words : `${prior} ${words}`;
      const committed = insertWords(base, words);
      leftAs.current = committed.text;
      // Words he selected and said again (a mis-heard word put right by voice) teach as a fix he typed would.
      const selected = draft.text.slice(draft.selection.start, draft.selection.end).trim();
      if (!replacing && selected !== "" && words !== "")
        batonDesktopBridge()?.replyComposerDictation?.({
          type: "sent",
          id: 0,
          written: selected,
          kept: words,
        });
      step({ type: "final", text: words, committed });
      input.commitDraft(committed.text, committed.selection);
      return true;
    }
    return true;
  });
  const cancel = useStableCallback(() => {
    const id = desktopId.current;
    if (id === null) return input.speech.cancel();
    batonDesktopBridge()?.replyComposerDictation?.({ type: "action", id, insert: false });
    // Cleared here too: a desktop that has already let this dictation go never answers.
    desktopId.current = null;
    step({ type: "cancel" });
  });
  // While Tessaya's dictation runs here he can still click or move the caret: the words follow it, and a field outside
  // this chat box taking the keyboard hands the dictation back to the desktop, which pastes it there.
  const listening = state.phase === "listening" || state.phase === "working";
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- follows the document's caret and focus, outside React, while words are coming
  useEffect(() => {
    if (!listening) return;
    const inside = () => input.rootRef.current?.contains(document.activeElement) === true;
    const onSelection = () => {
      if (desktopId.current !== null && inside()) step({ type: "rebase", base: readDraft() });
    };
    // While the desktop records it holds Esc itself, so an Esc that reaches the page is ✕.
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && desktopId.current !== null && !event.defaultPrevented) cancel();
    };
    const onFocus = (event: FocusEvent) => {
      const id = desktopId.current;
      const element = event.target as Element | null;
      if (id === null || inside() || element?.matches(TEXT_FIELD) !== true) return;
      desktopId.current = null;
      step({ type: "cancel" });
      batonDesktopBridge()?.replyComposerDictation?.({ type: "released", id });
    };
    // Capture: a text box's own selection changes are fired at the box, not the document, and not by every browser.
    const moves = ["selectionchange", "select", "keyup", "pointerup"] as const;
    for (const type of moves) document.addEventListener(type, onSelection, true);
    document.addEventListener("focusin", onFocus);
    document.addEventListener("keydown", onKey);
    return () => {
      for (const type of moves) document.removeEventListener(type, onSelection, true);
      document.removeEventListener("focusin", onFocus);
      document.removeEventListener("keydown", onKey);
    };
  }, [listening, input.rootRef, readDraft, step, cancel]);
  const root = useStableCallback(() => input.rootRef.current);
  const ready = useStableCallback(() => !input.disabled);
  const said = useStableCallback(() => {
    const prior = priorAt(input.readDraft(), dictated.current);
    const replyingTo = input.replyingTo?.()?.trim() ?? "";
    return {
      ...(prior === undefined ? {} : { prior }),
      ...(replyingTo === "" ? {} : { replyingTo }),
    };
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes this composer to the desktop's dictation channel and focus reports
  useEffect(() => listen({ take: onDesktop, root, ready, said }), [onDesktop, root, ready, said]);
  const sent = useStableCallback((text: string) => {
    const written = leftAs.current.trim();
    dictated.current = "";
    leftAs.current = "";
    if (written !== "")
      batonDesktopBridge()?.replyComposerDictation?.({ type: "sent", id: 0, written, kept: text });
  });

  const confirm = useStableCallback(() => {
    const id = desktopId.current;
    if (id !== null)
      batonDesktopBridge()?.replyComposerDictation?.({ type: "action", id, insert: true });
    else if (input.speech.state.phase === "post-processing") input.speech.skipPostProcessing();
    else void input.speech.stop();
  });

  return {
    state,
    level,
    live: listening,
    confirm,
    cancel,
    sent,
  };
}
