// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off
/**
 * Why Baton went down (D139). One line each in `baton-lifecycle.ndjson`, written synchronously so a
 * crash still leaves its record, kept across restarts and rotated by size. A start with no clean
 * exit before it is itself a finding: the last run was killed, crashed or lost power.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const MAX_BYTES = 2 * 1024 * 1024;
const KEEP = 3;

export type ExitReason = "update" | "quit" | "system" | "crash";

export interface LifecycleLog {
  /** Say why the next exit is happening, before it does. */
  readonly willExitFor: (reason: ExitReason, detail?: string) => void;
  /** The exit said by `willExitFor` did not happen. */
  readonly cancelExit: () => void;
  readonly note: (event: string, detail?: Record<string, unknown>) => void;
  /** Who was running before this one ended badly, or null. */
  readonly previousRunEndedBadly: () => boolean;
  /** Another Tessaya is already running: this launch must not touch the start guard or the running marker. */
  readonly anotherInstance: boolean;
}

const appendRotating = (file: string, line: string): void => {
  try {
    NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
    if (NodeFS.existsSync(file) && NodeFS.statSync(file).size + line.length > MAX_BYTES) {
      for (let i = KEEP - 1; i >= 1; i -= 1) {
        if (NodeFS.existsSync(`${file}.${i}`))
          NodeFS.renameSync(`${file}.${i}`, `${file}.${i + 1}`);
      }
      NodeFS.renameSync(file, `${file}.1`);
    }
    NodeFS.appendFileSync(file, line);
  } catch {
    // Logging must never be the thing that takes Baton down.
  }
};

/**
 * What a run that left its marker behind means. Installing a new version over a running Baton stops
 * it by force, so a different version at the next start is an update, not a crash; only the same
 * version, or one we cannot tell, is called a bad end.
 */
export const classifyLeftover = (
  left: { readonly version?: string; readonly pid?: number } | null,
  currentVersion: string,
  /** Whether that process is still running: then the marker is a live instance's, not a leftover. */
  isAlive: (pid: number) => boolean = () => false,
):
  | { readonly kind: "none" }
  | { readonly kind: "another-instance"; readonly pid: number }
  | { readonly kind: "replaced-by-update"; readonly from: string; readonly to: string }
  | { readonly kind: "ended-badly" } =>
  left === null
    ? { kind: "none" }
    : left.pid !== undefined && left.pid !== process.pid && isAlive(left.pid)
      ? { kind: "another-instance", pid: left.pid }
      : left.version !== undefined && left.version !== currentVersion
        ? { kind: "replaced-by-update", from: left.version, to: currentVersion }
        : { kind: "ended-badly" };

const processAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists but is not ours to signal, which still means it is running.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

export const createLifecycleLog = (input: {
  readonly file: string;
  /** Tests make a pid alive or dead. */
  readonly isAlive?: (pid: number) => boolean;
  /** A small file that exists only while a run is alive. */
  readonly runningFile: string;
  readonly version: string;
}): LifecycleLog => {
  const write = (event: string, detail: Record<string, unknown> = {}) =>
    appendRotating(
      input.file,
      `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, event, ...detail })}\n`,
    );
  let intended: { reason: ExitReason; detail?: string } | null = null;

  const left = NodeFS.existsSync(input.runningFile)
    ? (() => {
        try {
          return JSON.parse(NodeFS.readFileSync(input.runningFile, "utf8")) as {
            at?: string;
            pid?: number;
            version?: string;
          };
        } catch {
          return {};
        }
      })()
    : null;
  const leftover = classifyLeftover(left, input.version, input.isAlive ?? processAlive);
  // A second launch while the first still runs (a double click, the login item, the tray) is not a crash and must not
  // touch the first run's marker: it only says so and leaves the marker to its owner.
  if (leftover.kind === "another-instance") {
    write("another-instance-running", { otherPid: leftover.pid, version: input.version });
    return {
      willExitFor: (reason, detail) =>
        write("exiting", { reason, ...(detail === undefined ? {} : { detail }) }),
      cancelExit: () => undefined,
      note: write,
      previousRunEndedBadly: () => false,
      anotherInstance: true,
    };
  }
  if (leftover.kind === "replaced-by-update") {
    write("replaced-by-update", {
      from: leftover.from,
      to: leftover.to,
      startedAt: left?.at ?? null,
    });
  } else if (leftover.kind === "ended-badly") {
    write("previous-run-ended-badly", {
      startedAt: left?.at ?? null,
      previousPid: left?.pid ?? null,
      // The marker is rewritten every 30 s while it lives: how long it ran says whether it died at start or later.
      lastAliveAt: (left as { alive?: string } | null)?.alive ?? left?.at ?? null,
      meaning: "no clean exit was recorded: a crash, a kill or a power loss",
    });
  }
  NodeFS.mkdirSync(NodePath.dirname(input.runningFile), { recursive: true });
  NodeFS.writeFileSync(
    input.runningFile,
    JSON.stringify({ at: new Date().toISOString(), pid: process.pid, version: input.version }),
  );
  write("start", { version: input.version });
  const startedAt = new Date().toISOString();
  setInterval(() => {
    try {
      NodeFS.writeFileSync(
        input.runningFile,
        JSON.stringify({
          at: startedAt,
          alive: new Date().toISOString(),
          pid: process.pid,
          version: input.version,
        }),
      );
    } catch {
      // the marker is a convenience
    }
  }, 30_000).unref();

  const cleanExit = (fallback: ExitReason) => {
    write("exit", {
      reason: intended?.reason ?? fallback,
      ...(intended?.detail ? { detail: intended.detail } : {}),
    });
    try {
      NodeFS.rmSync(input.runningFile, { force: true });
    } catch {
      // A leftover file only makes the next start report an unclean exit.
    }
  };
  process.once("exit", () => cleanExit("quit"));
  // Observes without taking over: Electron still shows its own error and ends the process.
  process.on("uncaughtExceptionMonitor", (error, origin) => {
    intended = { reason: "crash", detail: origin };
    write("uncaught-exception", { origin, message: error.message, stack: error.stack ?? null });
  });
  // A kill from outside (Task Manager, a script, the OS ending the session) says which signal, where the platform has one.
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP", "SIGBREAK"] as const) {
    try {
      process.on(signal, () => {
        intended = { reason: "system", detail: signal };
        write("signal", { signal });
      });
    } catch {
      // not a signal this platform has
    }
  }
  process.on("unhandledRejection", (reason) => {
    write("unhandled-rejection", {
      message: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? (reason.stack ?? null) : null,
    });
  });

  return {
    willExitFor: (reason, detail) => {
      intended = detail === undefined ? { reason } : { reason, detail };
      write("exiting", { reason, ...(detail === undefined ? {} : { detail }) });
    },
    cancelExit: () => {
      intended = null;
    },
    note: write,
    previousRunEndedBadly: () => leftover.kind === "ended-badly",
    anotherInstance: false,
  };
};
