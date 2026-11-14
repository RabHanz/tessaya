/**
 * What the tray says, as pure functions of the state, so the words and colours
 * are tested rather than eyeballed. The pill's words are in voiceTurn.
 */
import type { VoiceState, VoiceUtterance } from "./voiceTypes.ts";

export interface HudView {
  readonly label: string;
  /** Dot colour. Muted is the only red: it is the one state that ignores him. */
  readonly color: string;
  /** Pulses while the mic is actually being listened to for words. */
  readonly pulsing: boolean;
}

const VIEWS: Record<VoiceState, HudView> = {
  sleeping: { label: "Sleeping", color: "#6b7280", pulsing: false },
  listening: { label: "Listening", color: "#22c55e", pulsing: true },
  command_window: { label: "Command", color: "#3b82f6", pulsing: true },
  conversation: { label: "Conversation", color: "#6366f1", pulsing: true },
  direct_session: { label: "Direct to session", color: "#f59e0b", pulsing: true },
  dictation: { label: "Dictating", color: "#14b8a6", pulsing: true },
  muted: { label: "Muted", color: "#ef4444", pulsing: false },
};

export const hudView = (state: VoiceState): HudView => VIEWS[state];

/** Where an utterance goes, said the way the HUD shows it after he speaks. */
export type VoiceRoute = "focused_session" | "focused_field" | "fabric_intent";

export const routeFor = (utterance: VoiceUtterance): VoiceRoute =>
  utterance.mode === "dictation"
    ? "focused_field"
    : utterance.mode === "direct_session"
      ? "focused_session"
      : "fabric_intent";

const ROUTE_LABEL: Record<VoiceRoute, string> = {
  focused_session: "to the focused session",
  focused_field: "typed into the focused field",
  fabric_intent: "to Tessaya",
};

/** The brief line under the dot after each utterance. */
export const utteranceCaption = (utterance: VoiceUtterance, maxLength = 80): string => {
  const text =
    utterance.text.length > maxLength
      ? `${utterance.text.slice(0, maxLength - 1)}…`
      : utterance.text;
  return `“${text}” ${ROUTE_LABEL[routeFor(utterance)]}`;
};
