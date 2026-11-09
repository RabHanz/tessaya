/**
 * What a History row offers, and how a retried transcript is kept: beside the old words, never over
 * them, until he picks it. Pure, so the menu, the no-recording path and the versions are tested
 * without Electron.
 */
import { cleanupLevelFor, strictestCleanup } from "@t3tools/baton-shared/dictationCleanup";
import { detectSecret } from "@t3tools/baton-shared/memory";

import type { HiddenReason, HistoryTurn, HistoryVersion } from "./history.ts";

export const NO_RECORDING = "No recording was kept for this one";
export const NO_HOLD_KEY_RECORDING = "No recording for hold-key dictation yet";

export type RetryPlan =
  | { readonly kind: "transcript" }
  | { readonly kind: "cleanup"; readonly why: string }
  | { readonly kind: "none"; readonly why: string };

type Row = Pick<HistoryTurn, "kind" | "status" | "audio" | "delivery"> &
  Partial<Pick<HistoryTurn, "raw" | "cleaned" | "hidden">>;

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
    | "undo_ai"
    | "play"
    | "retry_transcript"
    | "retry"
    | "paste"
    | "teach"
    | "extract"
    | "delete";
  readonly label: string;
  readonly enabled: boolean;
  /** Said plainly when the item cannot run. */
  readonly note?: string;
}

/** Play and Copy sit on the row; the rest is the row's three-dot menu. A hidden row offers only Delete. */
export const rowMenu = (turn: Row, busy: boolean): ReadonlyArray<MenuItem> => {
  if (turn.hidden != null) return [{ id: "delete", label: "Delete", enabled: true }];
  const plan = retryPlan(turn);
  const kept = hasRecording(turn);
  const why = plan.kind === "transcript" ? NO_RECORDING : plan.why;
  const items: MenuItem[] = [
    // Hearing it again is how he judges whether the words are wrong or the recording was.
    kept
      ? { id: "play", label: "Play the recording", enabled: true }
      : { id: "play", label: "Play the recording", enabled: false, note: why },
    { id: "copy", label: "Copy", enabled: true },
  ];
  // Wispr's "Undo AI edit": the words as heard replace the written ones, and are copied to paste back.
  if (
    turn.kind === "dictation" &&
    typeof turn.cleaned === "string" &&
    typeof turn.raw === "string" &&
    turn.cleaned.trim() !== turn.raw.trim()
  ) {
    items.push({ id: "undo_ai", label: "Undo AI edit", enabled: true });
  }
  items.push(
    plan.kind === "transcript"
      ? { id: "retry_transcript", label: "Retry transcript", enabled: !busy }
      : { id: "retry_transcript", label: "Retry transcript", enabled: false, note: plan.why },
  );
  if (plan.kind === "cleanup") items.push({ id: "retry", label: "Retry clean-up", enabled: !busy });
  items.push({ id: "paste", label: "Paste again", enabled: true });
  if (turn.kind === "dictation")
    items.push({ id: "teach", label: "Edit and teach", enabled: true });
  items.push(
    kept
      ? { id: "extract", label: "Extract audio (.wav)", enabled: true }
      : { id: "extract", label: "Extract audio (.wav)", enabled: false, note: why },
  );
  items.push({ id: "delete", label: "Delete", enabled: true });
  return items;
};

/** The row's words as he would paste them: his own fix first, then the written words, then the heard ones. */
export const rowText = (turn: Pick<HistoryTurn, "raw" | "cleaned" | "fixed">): string =>
  turn.fixed ?? turn.cleaned ?? turn.raw;

/** Undo AI edit: the heard words become the row's words, and the written ones stay as a version to go back to. */
export const undoAiEdit = (
  turn: Pick<HistoryTurn, "at" | "raw" | "cleaned" | "model" | "versions">,
  at: string,
) => ({
  versions: withRetry(turn, { at, raw: turn.raw, cleaned: turn.raw, model: null }),
  cleaned: turn.raw,
  fixed: null,
  status: "raw" as const,
});

/** A password box, or a private app (the rule that keeps dictionary learning away): its words are never kept or learned. */
export const privateReason = (
  app: { readonly exe: string; readonly title: string },
  passwordBox: boolean,
): HiddenReason | null =>
  passwordBox
    ? "password field"
    : app.exe !== "" && cleanupLevelFor("claude", app) === "local"
      ? "private app"
      : null;

/** Paste again goes only into the app the words were first said into. */
export const mayPasteInto = (turnApp: string, nowExe: string): boolean =>
  turnApp !== "" && turnApp.toLowerCase() === nowExe.toLowerCase();

/** Edit and teach learns from his fix unless the row is private: hidden, a secret, or said into a private app. */
export const mayTeach = (
  turn: Pick<HistoryTurn, "app" | "hidden">,
  meant: string,
  learnWords: boolean,
): boolean =>
  learnWords &&
  turn.hidden === null &&
  privateReason({ exe: turn.app, title: "" }, false) === null &&
  detectSecret(meant) === null;

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
 * A retry's clean-up level: never above his setting or what was decided when he dictated (a bank or sign-in page is
 * known then by its title, which the row does not keep), and local for a secret app or a row with no app.
 */
export const retryCleanupLevel = (
  setting: "off" | "local" | "claude",
  app: string,
  decided: "local" | "claude" | null = null,
): "local" | "claude" =>
  decided === "local"
    ? "local"
    : strictestCleanup<"claude">(setting === "claude" ? "claude" : "local", [
        { exe: app, title: "" },
      ]);
