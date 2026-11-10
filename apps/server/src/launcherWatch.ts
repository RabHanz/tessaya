import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HostProcess from "@t3tools/shared/HostProcess";

const DEFAULT_POLL_INTERVAL = Duration.seconds(2);

// shortcut: a Windows pid reused within one poll hides the loss, as before this check existed.
const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

// Capture before config and bootstrap reads to detect launcher loss during startup.
const startupParentPid = process.ppid;

/**
 * Any parent change signals launcher loss, including adoption by a Linux subreaper;
 * otherwise an orphan backend keeps its ownership lock and blocks replacement launches.
 * Windows keeps the exited parent's id as ppid, so there the launcher's own liveness is polled.
 * Skip init-launched backends.
 */
export const awaitLauncherLoss = Effect.fn("launcherWatch.awaitLauncherLoss")(function* (options?: {
  readonly launcherPid?: number;
  readonly getParentPid?: () => number;
  readonly isAlive?: (pid: number) => boolean;
  readonly interval?: Duration.Input;
}): Effect.fn.Return<void> {
  const platform = yield* HostProcess.Platform;
  const launcherPid = options?.launcherPid ?? startupParentPid;
  const getParentPid = options?.getParentPid ?? (() => process.ppid);
  const isAlive = options?.isAlive ?? isProcessAlive;
  const interval = options?.interval ?? DEFAULT_POLL_INTERVAL;
  if (launcherPid <= 1) return yield* Effect.never;
  const poll: Effect.Effect<void> = Effect.suspend(() => {
    const parentPid = getParentPid();
    const launcherPresent =
      platform === "win32" ? isAlive(launcherPid) : parentPid === launcherPid;
    return launcherPresent
      ? Effect.flatMap(Effect.sleep(interval), () => poll)
      : Effect.logWarning("desktop launcher is gone; shutting down the backend", {
          launcherPid,
          parentPid,
        });
  });
  return yield* poll;
});
