import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HostProcess from "@t3tools/shared/HostProcess";

const DEFAULT_POLL_INTERVAL = Duration.seconds(2);
// The desktop's SIGTERM grace before it escalates to SIGKILL; a lost launcher cannot escalate.
const DEFAULT_SHUTDOWN_GRACE = Duration.seconds(5);

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

interface LauncherWatchOptions {
  readonly launcherPid?: number;
  readonly getParentPid?: () => number;
  readonly isAlive?: (pid: number) => boolean;
  readonly interval?: Duration.Input;
}

/**
 * Any parent change signals launcher loss, including adoption by a Linux subreaper;
 * otherwise an orphan backend keeps its ownership lock and blocks replacement launches.
 * Windows keeps the exited parent's id as ppid, so there the launcher's own liveness is polled.
 * Skip init-launched backends.
 */
export const awaitLauncherLoss = Effect.fn("launcherWatch.awaitLauncherLoss")(function* (
  options?: LauncherWatchOptions,
): Effect.fn.Return<void> {
  const platform = yield* HostProcess.Platform;
  const launcherPid = options?.launcherPid ?? startupParentPid;
  const getParentPid = options?.getParentPid ?? (() => process.ppid);
  const isAlive = options?.isAlive ?? isProcessAlive;
  const interval = options?.interval ?? DEFAULT_POLL_INTERVAL;
  if (launcherPid <= 1) return yield* Effect.never;
  const poll: Effect.Effect<void> = Effect.suspend(() => {
    const parentPid = getParentPid();
    const launcherPresent = platform === "win32" ? isAlive(launcherPid) : parentPid === launcherPid;
    return launcherPresent
      ? Effect.flatMap(Effect.sleep(interval), () => poll)
      : Effect.logWarning("desktop launcher is gone; shutting down the backend", {
          launcherPid,
          parentPid,
        });
  });
  return yield* poll;
});

/**
 * Interrupts `run` when the launcher is lost, and exits the process if shutdown outlasts the
 * grace period: a stuck cleanup step would otherwise keep holding the T3 home's ownership lock.
 */
export const stopOnLauncherLoss = <A, E, R>(
  run: Effect.Effect<A, E, R>,
  options?: LauncherWatchOptions & {
    readonly shutdownGrace?: Duration.Input;
    readonly exit?: () => void;
  },
) =>
  Effect.raceFirst(
    run,
    awaitLauncherLoss(options).pipe(
      Effect.andThen(
        Effect.forkDetach(
          Effect.sleep(options?.shutdownGrace ?? DEFAULT_SHUTDOWN_GRACE).pipe(
            Effect.andThen(Effect.logWarning("backend shutdown timed out after launcher loss")),
            Effect.andThen(Effect.sync(options?.exit ?? (() => process.exit(1)))),
          ),
        ),
      ),
      // End like SIGTERM does (interrupt-only exit, so the runtime forces process exit).
      Effect.andThen(Effect.interrupt),
    ),
  );
