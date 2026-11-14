// @effect-diagnostics nodeBuiltinImport:off
/** Keeps the job tracker between ticks and reads this machine's disk and memory, for the anomaly triggers. */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  anomalyFromCi,
  anomalyFromJobs,
  anomalyFromPressure,
  EMPTY_TRACK,
  trackJobs,
  type JobSeen,
  type JobTrack,
  type Pressure,
} from "@t3tools/tessaya-shared/anomalies";
import type { CiRun, Trigger } from "@t3tools/tessaya-shared/initiative";

export const readPressure = (dir: string): Pressure | null => {
  try {
    const fs = NodeFS.statfsSync(dir);
    return {
      freeDiskGb: (fs.bavail * fs.bsize) / 1e9,
      totalDiskGb: (fs.blocks * fs.bsize) / 1e9,
      freeMemPct: (NodeOS.freemem() / NodeOS.totalmem()) * 100,
    };
  } catch {
    return null;
  }
};

export const createAnomalySource = (input: {
  readonly dir: string;
  readonly now: () => number;
  readonly pressure?: () => Pressure | null;
}) => {
  const file = NodePath.join(input.dir, "job-track.json");
  const load = (): JobTrack => {
    try {
      return { ...EMPTY_TRACK, ...(JSON.parse(NodeFS.readFileSync(file, "utf8")) as object) };
    } catch {
      return EMPTY_TRACK;
    }
  };
  return {
    triggers: (jobs: ReadonlyArray<JobSeen>, ci: ReadonlyArray<CiRun>): ReadonlyArray<Trigger> => {
      const now = input.now();
      const track = trackJobs(load(), jobs, now);
      NodeFS.mkdirSync(input.dir, { recursive: true });
      NodeFS.writeFileSync(`${file}.tmp`, JSON.stringify(track));
      NodeFS.renameSync(`${file}.tmp`, file);
      const pressure = (input.pressure ?? (() => readPressure(input.dir)))();
      return [
        ...anomalyFromJobs(track, now),
        ...anomalyFromCi(ci, now),
        ...(pressure === null ? [] : anomalyFromPressure(pressure, "this computer")),
      ];
    },
  };
};
