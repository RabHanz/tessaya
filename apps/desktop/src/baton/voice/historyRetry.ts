/**
 * What a History row offers, and how a retried transcript is kept: beside the old words, never over
 * them, until he picks it. Pure, so the menu, the no-recording path and the versions are tested
 * without Electron.
 */
import { strictestCleanup } from "@t3tools/baton-shared/dictationCleanup";

import type { HistoryTurn, HistoryVersion } from "./history.ts";

export const NO_RECORDING = "No recording was kept for this one";
export const NO_HOLD_KEY_RECORDING = "No recording for hold-key dictation yet";

export type RetryPlan =
  | { readonly kind: "transcript" }
  | { readonly kind: "cleanup"; readonly why: string }
  | { readonly kind: "none"; readonly why: string };

type Row = Pick<HistoryTurn, "kind" | "status" | "audio" | "delivery"> &
  Partial<Pick<HistoryTurn, "raw" | "cleaned">>;

export const hasRecording = (turn: Pick<HistoryTurn, "audio">): boolean =>
  turn.audio !== null && turn.audio.trim() !== "";

/** Recognition again when a recording exists; otherwise only the clean-up retry, and only where it applies. */
export const retryPlan = (turn: Row): RetryPlan => {
  if (turn.audio !== null && turn.audio.trim() !== "") return { kind: "transcript" };
  const why = turn.delivery === "hold key" ? NO_HOLD_KEY_RECORDING : NO_RECORDING;
  return turn.kind === "dictation" && (turn.status === "raw" || turn.status === "failed")
    ? { kind: "cleanup", why }
    : { kind: "none", why };
};

export interface MenuItem {
  readonly id:
    | "copy"
    | "copy_raw"
    | "undo_ai"
    | "play"
    | "retry_transcript"
    | "retry"
    | "report"
    | "delete";
  readonly label: string;
  readonly enabled: boolean;
  /** Said plainly when the item cannot run. */
  readonly note?: string;
}

/** The row's three-dot menu. Copy takes the reply for a spoken turn, the written words for a dictation. */
export const rowMenu = (turn: Row, busy: boolean): ReadonlyArray<MenuItem> => {
  const plan = retryPlan(turn);
  const items: MenuItem[] = [
    { id: "copy", label: "Copy", enabled: true },
    { id: "copy_raw", label: "Copy as heard", enabled: true },
    // Hearing it again is how he judges whether the words are wrong or the recording was.
    hasRecording(turn)
      ? { id: "play", label: "Play the recording", enabled: true }
      : { id: "play", label: "Play the recording", enabled: false, note: NO_RECORDING },
    plan.kind === "transcript"
      ? { id: "retry_transcript", label: "Retry transcript", enabled: !busy }
      : { id: "retry_transcript", label: "Retry transcript", enabled: false, note: plan.why },
  ];
  // Wispr's "Undo AI edit": the words as heard replace the written ones, and are copied to paste back.
  if (
    turn.kind === "dictation" &&
    typeof turn.cleaned === "string" &&
    typeof turn.raw === "string" &&
    turn.cleaned.trim() !== turn.raw.trim()
  ) {
    items.splice(2, 0, { id: "undo_ai", label: "Undo AI edit", enabled: true });
  }
  if (plan.kind === "cleanup") items.push({ id: "retry", label: "Retry clean-up", enabled: !busy });
  items.push({ id: "report", label: "Report this transcript", enabled: true });
  items.push({ id: "delete", label: "Delete", enabled: true });
  return items;
};

export interface Retried {
  readonly at: string;
  readonly raw: string;
  readonly cleaned: string | null;
  readonly model: string | null;
}

const same = (a: HistoryVersion, b: Retried) => a.raw === b.raw && a.cleaned === b.cleaned;

/** The row's versions with a retry added: v1 is the row as it was, and an identical result adds nothing. */
export const withRetry = (
  turn: Pick<HistoryTurn, "at" | "raw" | "cleaned" | "model" | "versions">,
  result: Retried,
): ReadonlyArray<HistoryVersion> => {
  const base: ReadonlyArray<HistoryVersion> =
    turn.versions.length > 0
      ? turn.versions
      : [{ at: turn.at, raw: turn.raw, cleaned: turn.cleaned, model: turn.model }];
  return base.some((v) => same(v, result)) ? base : [...base, result];
};

/** Picking a version makes it the row's words; the others stay as versions. */
export const useVersion = (
  turn: Pick<HistoryTurn, "versions">,
  index: number,
): HistoryVersion | null => turn.versions[index] ?? null;

/**
 * A retry's clean-up level: never above his setting, and local for an app marked secret or a row with no app (voice
 * dictation): unknown counts as secret, as it does when he dictates. "off" still tidies locally on a retry.
 */
export const retryCleanupLevel = (
  setting: "off" | "local" | "claude",
  app: string,
): "local" | "claude" =>
  strictestCleanup<"claude">(setting === "claude" ? "claude" : "local", [{ exe: app, title: "" }]);
