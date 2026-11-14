// @effect-diagnostics nodeBuiltinImport:off globalDate:off
/**
 * Crash recovery. Every half minute Tessaya writes a heartbeat file (what is running, when, which
 * version); on the next start, jobs the last heartbeat saw running that are not running or done now
 * are marked interrupted, kept across further restarts, and offered a Continue button on the Now page.
 * Messages between sessions and commitments are durable and resume by themselves.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export interface Heartbeat {
  readonly at: string;
  readonly pid: number;
  readonly version: string;
  /** False in the last write of a clean exit. */
  readonly running: boolean;
  readonly state: string;
  readonly jobsRunning: ReadonlyArray<{ readonly id: string; readonly title: string }>;
  readonly approvalsWaiting: number;
}

export interface Interrupted {
  readonly id: string;
  readonly title: string;
  readonly since: string;
}

export interface JobFacts {
  readonly id: string;
  readonly title: string;
  readonly group: string;
}

/** Jobs to mark interrupted: running at the last heartbeat, and neither running nor finished now. */
export const findInterrupted = (
  previous: Heartbeat | null,
  now: ReadonlyArray<JobFacts>,
  at: string,
): ReadonlyArray<Interrupted> =>
  previous === null
    ? []
    : previous.jobsRunning.flatMap((j) => {
        const card = now.find((c) => c.id === j.id);
        return card === undefined || card.group === "running" || card.group === "done"
          ? []
          : [{ id: j.id, title: j.title, since: at }];
      });

/** Keep a mark until the job runs again, finishes, or is gone. */
export const stillInterrupted = (
  marks: ReadonlyArray<Interrupted>,
  now: ReadonlyArray<JobFacts>,
): ReadonlyArray<Interrupted> =>
  marks.filter((m) => {
    const card = now.find((c) => c.id === m.id);
    return card !== undefined && card.group !== "running" && card.group !== "done";
  });

export const mergeMarks = (
  a: ReadonlyArray<Interrupted>,
  b: ReadonlyArray<Interrupted>,
): ReadonlyArray<Interrupted> => [...a, ...b.filter((x) => !a.some((y) => y.id === x.id))];

const writeJson = (file: string, value: unknown): void => {
  try {
    NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
    NodeFS.writeFileSync(`${file}.tmp`, JSON.stringify(value));
    NodeFS.renameSync(`${file}.tmp`, file);
  } catch {
    // A heartbeat must never be the thing that fails.
  }
};

const readJson = <T>(file: string, fallback: T): T => {
  try {
    return JSON.parse(NodeFS.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
};

export const createRecoveryFiles = (logDir: string, stateDir: string) => {
  const heartbeatFile = NodePath.join(logDir, "baton-heartbeat.json");
  const marksFile = NodePath.join(stateDir, "interrupted-jobs.json");
  return {
    heartbeatFile,
    readHeartbeat: (): Heartbeat | null => readJson<Heartbeat | null>(heartbeatFile, null),
    writeHeartbeat: (beat: Heartbeat): void => writeJson(heartbeatFile, beat),
    readMarks: (): ReadonlyArray<Interrupted> =>
      readJson<ReadonlyArray<Interrupted>>(marksFile, []),
    writeMarks: (marks: ReadonlyArray<Interrupted>): void => writeJson(marksFile, marks),
  };
};

export const CONTINUE_TEXT =
  "Tessaya restarted while you were working, so your last turn may have been cut off. Check the state of the files and what you had finished, then continue from where you stopped.";
