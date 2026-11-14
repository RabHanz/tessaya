// @effect-diagnostics nodeBuiltinImport:off globalDate:off
/**
 * `baton-busy.json` in the log folder: what an installer outside the app reads before it replaces
 * Tessaya (docs/baton/STATUS_FILES.md). Rewritten every few seconds from the same facts the app's
 * own updater waits on, so both agree on "mid-turn".
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { canInstallNow, type UpdateBusy } from "../update/updateLogic.ts";

export interface BusyFile {
  readonly at: string;
  readonly pid: number;
  /** True while a restart would cut something off, and while the server cannot say. */
  readonly busy: boolean;
  readonly why: string | null;
}

/** Older than this, the app that wrote it is gone or hung. */
export const BUSY_FILE_FRESH_MS = 20_000;

export const busyFileOf = (input: {
  readonly busy: UpdateBusy;
  /** False when this machine's server did not answer the in-flight read. */
  readonly serverAnswered: boolean;
  readonly now: Date;
  readonly pid: number;
}): BusyFile => {
  const why = !input.serverAnswered
    ? "The server did not answer, so what is running is unknown."
    : input.busy.inFlight !== null
      ? input.busy.inFlight
      : input.busy.voiceBusy || input.busy.assistantBusy
        ? "Tessaya is speaking, listening or driving the screen."
        : null;
  return {
    at: input.now.toISOString(),
    pid: input.pid,
    busy: !input.serverAnswered || !canInstallNow(input.busy),
    why,
  };
};

/** The installer's rule: replace the app only on a fresh file that says idle (or with no app running). */
export const safeToReplace = (file: unknown, nowMs: number): boolean => {
  if (typeof file !== "object" || file === null) return false;
  const { at, busy } = file as { at?: unknown; busy?: unknown };
  const written = typeof at === "string" ? Date.parse(at) : Number.NaN;
  return busy === false && nowMs - written >= 0 && nowMs - written < BUSY_FILE_FRESH_MS;
};

export const busyFilePath = (logDir: string) => NodePath.join(logDir, "baton-busy.json");

export const writeBusyFile = (file: string, value: BusyFile): void => {
  try {
    NodeFS.writeFileSync(`${file}.tmp`, JSON.stringify(value));
    NodeFS.renameSync(`${file}.tmp`, file);
  } catch {
    // An installer reading an old file waits; it never fails the app.
  }
};
