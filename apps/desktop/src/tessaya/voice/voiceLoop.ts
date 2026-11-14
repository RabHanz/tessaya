/* oxlint-disable t3code/no-low-value-comments -- Baton file predating upstream's rule (D82) */
/**
 * Microphone → core → HUD and router. Electron-free, so the same loop runs in
 * the app and headless against a WAV file.
 *
 * Mute is enforced here, not asked of the core: while muted not one frame
 * leaves this function. A hard mute that depends on someone else's code is a
 * request.
 */
import { routeFor, type VoiceRoute } from "./voiceHud.ts";
import type {
  AudioInputProvider,
  VoiceActivation,
  VoiceCore,
  VoiceState,
  VoiceUtterance,
} from "./voiceTypes.ts";

export interface VoiceLoop {
  readonly activate: (activation: VoiceActivation) => void;
  readonly setMuted: (muted: boolean) => void;
  readonly isMuted: () => boolean;
  /** Moves capture to another device (hot-plug, or a pick from the tray). */
  readonly switchDevice: (deviceId: string | null) => Promise<void>;
  readonly stop: () => Promise<void>;
}

export const startVoiceLoop = async (input: {
  readonly audio: AudioInputProvider;
  readonly core: VoiceCore;
  readonly deviceId: string | null;
  readonly muted?: boolean;
  readonly onState: (state: VoiceState) => void;
  /** Every frame that reaches the core, for a live level. */
  readonly onLevel?: (frame: Int16Array) => void;
  readonly onUtterance: (utterance: VoiceUtterance, route: VoiceRoute) => void;
}): Promise<VoiceLoop> => {
  let muted = input.muted ?? false;
  let coreState: VoiceState = "sleeping";
  const show = () => input.onState(muted ? "muted" : coreState);

  const offState = input.core.onState((state) => {
    coreState = state;
    show();
  });
  const offUtterance = input.core.onUtterance((utterance) => {
    if (!muted) input.onUtterance(utterance, routeFor(utterance));
  });
  const onFrame = (frame: Int16Array) => {
    if (muted) return;
    input.core.pushAudio(frame);
    input.onLevel?.(frame);
  };

  const setMuted = (next: boolean) => {
    muted = next;
    show();
  };

  show();
  await input.audio.start({ deviceId: input.deviceId, onFrame });

  return {
    activate: (activation) => {
      if (activation === "toggle_mute") return setMuted(!muted);
      // Waking a muted Baton unmutes it: pressing "wake" means "hear me".
      if (muted) setMuted(false);
      input.core.activate(activation);
    },
    setMuted,
    isMuted: () => muted,
    switchDevice: async (deviceId) => {
      await input.audio.stop();
      await input.audio.start({ deviceId, onFrame });
    },
    stop: async () => {
      offState();
      offUtterance();
      await input.audio.stop();
      input.core.dispose();
    },
  };
};
