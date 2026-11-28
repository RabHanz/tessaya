import { NavigationContext } from "@react-navigation/native";
import { useCallback, useContext, useEffect, useRef, useSyncExternalStore } from "react";
import {
  voiceInputBlocksSubmission,
  type VoiceInputState,
} from "@t3tools/client-runtime/voice-input";

import type { ComposerEditorSelection } from "../../components/ComposerEditor";
import { useGlobalVoiceInput } from "./VoiceInputProvider";
import { getLiveWords, subscribeLiveWords } from "./liveWords";
import { createVoiceInputTarget } from "./voiceInputSession";

const IDLE_STATE: VoiceInputState = { phase: "idle", error: null, errorAction: null };

export function useVoiceInputController(input: {
  readonly ownerKey: string | null;
  readonly label: string;
  readonly readDraftMessage: () => string | null;
  readonly selection: ComposerEditorSelection;
  readonly disabled?: boolean;
  readonly hidden?: boolean;
  readonly onChangeDraftMessage: (value: string) => void;
  readonly onChangeSelection: (selection: ComposerEditorSelection) => void;
}) {
  const global = useGlobalVoiceInput();
  const { session } = global;
  const latestInput = useRef(input);
  // oxlint-disable-next-line react/refs -- Transcription finishes asynchronously and must reach the composer's current selection setter, not the one captured at start.
  latestInput.current = input;
  const mounted = useRef(true);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tracks mount so async transcription results skip a composer that has unmounted
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // No navigator above the Sleeve, which draws Talk over the whole app: useFocusEffect would throw there.
  const navigation = useContext(NavigationContext);
  const screenFocused = useSyncExternalStore(
    useCallback(
      (listener: () => void) => {
        const offFocus = navigation?.addListener("focus", listener);
        const offBlur = navigation?.addListener("blur", listener);
        return () => {
          offFocus?.();
          offBlur?.();
        };
      },
      [navigation],
    ),
    () => navigation?.isFocused() ?? true,
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells the shared voice session which composer is on screen
  useEffect(() => {
    const ownerKey = input.ownerKey;
    if (!ownerKey || input.hidden || !screenFocused) return;
    session.setOwnerFocused(ownerKey, true);
    return () => session.setOwnerFocused(ownerKey, false);
  }, [input.hidden, input.ownerKey, screenFocused, session]);

  const start = useCallback(() => {
    const captured = latestInput.current;
    if (!captured.ownerKey || captured.disabled) return;
    void session.start({
      ...createVoiceInputTarget(
        captured.ownerKey,
        captured.readDraftMessage,
        (text, selection) => {
          captured.onChangeDraftMessage(text);
          if (mounted.current && latestInput.current.ownerKey === captured.ownerKey) {
            latestInput.current.onChangeSelection(selection);
          }
        },
        captured.selection,
      ),
      label: captured.label,
    });
  }, [session]);
  const state = global.ownerKey === input.ownerKey ? global.state : IDLE_STATE;
  const isBusy = voiceInputBlocksSubmission(state);
  const heard = useSyncExternalStore(subscribeLiveWords, getLiveWords);
  // His words so far, while this owner records or the last of them is written out.
  const liveWords =
    heard !== null && (state.phase === "recording" || state.phase === "transcribing")
      ? heard
      : null;
  return {
    isAvailable: global.isAvailable && (!global.isBusy || global.ownerKey === input.ownerKey),
    state,
    audioLevels: global.audioLevels,
    liveWords,
    elapsedSeconds: global.elapsedSeconds,
    isBusy,
    freezesEditor: isBusy,
    blocksSubmission: isBusy,
    start,
    stop: global.stop,
    cancel: global.cancel,
  };
}
