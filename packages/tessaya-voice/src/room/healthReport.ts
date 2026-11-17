// @effect-diagnostics nodeBuiltinImport:off
/**
 * The room loop's part of her health model: its host's memory, pressure and load, its services, each Tessel's wake
 * attempts against accepts, and how her server answers. Published per Tessel as `state/voicehost` each minute, so the
 * server that holds the Tessel can say why she is slow or not waking (packages/tessaya-shared/src/health.ts).
 * @module baton-voice/room/healthReport
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";

import type { ServiceHealth, VoiceHostReport } from "@t3tools/tessaya-shared/health";
import { hostHealthOf } from "@t3tools/tessaya-shared/hostHealth";

const read = (path: string) => {
  try {
    return NodeFS.readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

/** This host's figures from /proc; null fields where it has no such file (macOS, an old kernel). */
export const readHost = (now: number) =>
  hostHealthOf({
    host: NodeOS.hostname(),
    at: now,
    cores: NodeOS.availableParallelism(),
    meminfo: read("/proc/meminfo"),
    loadavg: read("/proc/loadavg"),
    psiMemory: read("/proc/pressure/memory"),
    psiCpu: read("/proc/pressure/cpu"),
  });

const KEEP_FAILS = 20;
const KEEP_RTT = 9;

/** Wake counts cover the last hour or so: a window this old starts again at the next report. */
const WAKE_WINDOW_MS = 3_600_000;

export const createHealthReport = (now: () => number = Date.now) => {
  let since = now();
  let wakes = new Map<string, { attempts: number; accepts: number }>();
  const failures: Array<number> = [];
  const rtts: Array<number> = [];
  const of = (id: string) => {
    const w = wakes.get(id) ?? { attempts: 0, accepts: 0 };
    wakes.set(id, w);
    return w;
  };
  return {
    /** The Tessel's kws passed a segment: it thinks it heard her name. */
    attempt: (id: string) => void (of(id).attempts += 1),
    accept: (id: string) => void (of(id).accepts += 1),
    brainFailed: () => {
      failures.push(now());
      if (failures.length > KEEP_FAILS) failures.shift();
    },
    rtt: (ms: number) => {
      rtts.push(ms);
      if (rtts.length > KEEP_RTT) rtts.shift();
    },
    report: (
      id: string,
      input: {
        readonly host: VoiceHostReport["host"];
        readonly services: ReadonlyArray<ServiceHealth>;
        readonly replay: VoiceHostReport["replay"];
      },
    ): VoiceHostReport => {
      if (now() - since > WAKE_WINDOW_MS) {
        since = now();
        wakes = new Map();
      }
      const sorted = rtts.toSorted((a, b) => a - b);
      const w = wakes.get(id) ?? { attempts: 0, accepts: 0 };
      return {
        ...input,
        wake: { ...w, since },
        brain: {
          rttMs: sorted.length === 0 ? null : Math.round(sorted[Math.floor(sorted.length / 2)]!),
          failures: [...failures],
        },
        at: now(),
      };
    },
  };
};
