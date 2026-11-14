// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off
/**
 * A hung main thread cannot report itself, so a worker watches a counter the main thread bumps; no change for
 * `limitMs` writes `main-stalled` (with startup phases and, if the inspector can, the JS stack), then `main-recovered`.
 * A shorter block of `slowMs` already gets one JS stack sample, taken while the block is still running.
 */
import * as NodeFS from "node:fs";
import * as NodeWorkerThreads from "node:worker_threads";

const BEAT_MS = 500;
export const STALL_LIMIT_MS = 5_000;
const SLOW_SAMPLE_MS = 1_000;

/** The worker's whole program: it only knows a file, a shared counter, and the phases posted to it. */
export const WATCH_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const fs = require("node:fs");
const path = require("node:path");
const { file, counter, limitMs, slowMs, version } = workerData;
const beats = new Int32Array(counter);
let phases = [];
let last = Atomics.load(beats, 0);
let changedAt = Date.now();
let stalledAt = 0;
let sampled = false;
const write = (event, detail) => {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), event, version, pid: workerData.pid, ...detail }) + "\\n");
  } catch {}
};
parentPort.on("message", (m) => {
  phases.push(m);
  if (phases.length > 40) phases = phases.slice(-40);
});
const lastPhases = () => phases.slice(-12);
const grabStack = (reason) => {
  try {
    const inspector = require("node:inspector");
    const session = new inspector.Session();
    session.connectToMainThread();
    session.on("Debugger.paused", (e) => {
      const frames = e.params.callFrames.slice(0, 10).map((f) => (f.functionName || "(anonymous)") + " " + f.url.split(/[\\\\/]/).slice(-2).join("/") + ":" + (f.location.lineNumber + 1));
      write("main-stack", { reason, frames, phases: lastPhases() });
      session.post("Debugger.resume");
      session.post("Debugger.disable", () => session.disconnect());
    });
    session.post("Debugger.enable", () => session.post("Debugger.pause"));
  } catch (error) {
    write("main-stack-unavailable", { error: String(error) });
  }
};
setInterval(() => {
  const now = Date.now();
  const seen = Atomics.load(beats, 0);
  if (seen !== last) {
    last = seen;
    if (stalledAt !== 0) write("main-recovered", { stalledMs: now - stalledAt, phases: lastPhases() });
    stalledAt = 0;
    sampled = false;
    changedAt = now;
  } else if (stalledAt === 0 && now - changedAt >= limitMs) {
    stalledAt = changedAt;
    write("main-stalled", { stalledForMs: now - changedAt, phases: lastPhases() });
    grabStack("stalled");
  } else if (!sampled && now - changedAt >= slowMs) {
    sampled = true;
    grabStack("slow");
  }
}, 250);
`;

export interface StallWatch {
  readonly phase: (name: string, detail?: Record<string, unknown>) => void;
  readonly stop: () => void;
}

let current: StallWatch | null = null;

/** Mark the start or end of a startup step. Harmless before the watch exists. */
export const markPhase = (name: string, detail?: Record<string, unknown>): void =>
  current?.phase(name, detail);

export const startStallWatch = (input: {
  readonly file: string;
  readonly version: string;
  readonly limitMs?: number;
  readonly slowMs?: number;
}): StallWatch => {
  const counter = new SharedArrayBuffer(4);
  const beats = new Int32Array(counter);
  const beat = setInterval(() => Atomics.add(beats, 0, 1), BEAT_MS);
  beat.unref();
  // A late tick names the phases begun and not yet ended: the last marker alone is often async work that is only waiting.
  let lastPhase = "";
  const open = new Set<string>();
  let expected = Date.now() + 1000;
  const lag = setInterval(() => {
    const late = Date.now() - expected;
    expected = Date.now() + 1000;
    if (late < 200) return;
    try {
      NodeFS.appendFileSync(
        input.file,
        `${JSON.stringify({ at: new Date().toISOString(), event: "main-slow", version: input.version, lateMs: late, phase: lastPhase, open: [...open] })}\n`,
      );
    } catch {
      // diagnostics only
    }
  }, 1000);
  lag.unref();
  let worker: NodeWorkerThreads.Worker | null = null;
  try {
    worker = new NodeWorkerThreads.Worker(WATCH_SOURCE, {
      eval: true,
      workerData: {
        file: input.file,
        counter,
        limitMs: input.limitMs ?? STALL_LIMIT_MS,
        slowMs: input.slowMs ?? SLOW_SAMPLE_MS,
        version: input.version,
        pid: process.pid,
      },
    });
    worker.on("error", () => {});
    worker.unref();
  } catch {
    // A watchdog must never stop the app from starting.
    worker = null;
  }
  const watch: StallWatch = {
    phase: (name, detail) => {
      lastPhase = name;
      const [step, edge] = name.split(":");
      if (edge === "begin") open.add(step!);
      else if (edge === "end") open.delete(step!);
      try {
        worker?.postMessage({ at: Date.now(), name, ...detail });
      } catch {
        // diagnostics only
      }
    },
    stop: () => {
      clearInterval(beat);
      clearInterval(lag);
      void worker?.terminate();
    },
  };
  current = watch;
  return watch;
};
