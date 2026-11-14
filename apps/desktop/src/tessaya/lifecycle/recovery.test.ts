// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  createRecoveryFiles,
  findInterrupted,
  mergeMarks,
  stillInterrupted,
  type Heartbeat,
} from "./recovery.ts";

const beat = (ids: string[]): Heartbeat => ({
  at: "2026-11-03T10:00:00Z",
  pid: 1,
  version: "0.1.40",
  running: true,
  state: "listening",
  jobsRunning: ids.map((id) => ({ id, title: `Job ${id}` })),
  approvalsWaiting: 0,
});

describe("crash recovery", () => {
  it("marks jobs that were running and are now neither running nor done", () => {
    const now = [
      { id: "a", title: "A", group: "failed" },
      { id: "b", title: "B", group: "running" },
      { id: "c", title: "C", group: "done" },
      { id: "d", title: "D", group: "needs_you" },
    ];
    const marks = findInterrupted(beat(["a", "b", "c", "d", "gone"]), now, "T");
    expect(marks.map((m) => m.id)).toEqual(["a", "d"]);
    expect(findInterrupted(null, now, "T")).toEqual([]);
  });

  it("keeps a mark across restarts until the job runs again, finishes or is gone", () => {
    const marks = [
      { id: "a", title: "A", since: "T" },
      { id: "b", title: "B", since: "T" },
      { id: "c", title: "C", since: "T" },
    ];
    const now = [
      { id: "a", title: "A", group: "failed" },
      { id: "b", title: "B", group: "running" },
    ];
    expect(stillInterrupted(marks, now).map((m) => m.id)).toEqual(["a"]);
    expect(
      mergeMarks(marks, [
        { id: "a", title: "A", since: "U" },
        { id: "z", title: "Z", since: "U" },
      ]).map((m) => m.id),
    ).toEqual(["a", "b", "c", "z"]);
  });

  it("writes a heartbeat the manager can read, and survives a missing or broken file", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "recover-"));
    const files = createRecoveryFiles(NodePath.join(dir, "logs"), dir);
    expect(files.readHeartbeat()).toBeNull();
    files.writeHeartbeat(beat(["a"]));
    expect(JSON.parse(NodeFS.readFileSync(files.heartbeatFile, "utf8")).jobsRunning[0].id).toBe(
      "a",
    );
    NodeFS.writeFileSync(files.heartbeatFile, "{broken");
    expect(files.readHeartbeat()).toBeNull();
    files.writeMarks([{ id: "a", title: "A", since: "T" }]);
    expect(files.readMarks()).toHaveLength(1);
  });
});
