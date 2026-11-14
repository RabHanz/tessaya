/* oxlint-disable t3code/no-global-process-runtime -- Baton file predating the rule (D82) */
// @effect-diagnostics nodeBuiltinImport:off globalDate:off
/** Writes the diagnostics file to Tessaya's state folder. Nothing is sent anywhere. */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  buildDiagnostics,
  scrubLog,
  scrubSettings,
  type Section,
} from "@t3tools/tessaya-shared/diagnostics";

const tail = (file: string, bytes = 200_000): string => {
  try {
    const stat = NodeFS.statSync(file);
    const fd = NodeFS.openSync(file, "r");
    try {
      const length = Math.min(stat.size, bytes);
      const buffer = Buffer.alloc(length);
      NodeFS.readSync(fd, buffer, 0, length, stat.size - length);
      return buffer.toString("utf8");
    } finally {
      NodeFS.closeSync(fd);
    }
  } catch {
    return "";
  }
};

const folderListing = (dir: string): string => {
  try {
    return NodeFS.readdirSync(dir)
      .map((name) => {
        try {
          const s = NodeFS.statSync(NodePath.join(dir, name));
          return `${s.isDirectory() ? "dir " : "file"} ${name} ${s.isDirectory() ? "" : `${s.size} bytes`}`;
        } catch {
          return `?    ${name}`;
        }
      })
      .join("\n");
  } catch {
    return "(unreadable)";
  }
};

export const makeDiagnosticsFile = (input: {
  readonly stateDir: string;
  readonly logDir: string;
  readonly version: string;
  readonly settingsFile: string;
  readonly now?: Date;
}): string => {
  const at = (input.now ?? new Date()).toISOString();
  let settings: unknown = {};
  try {
    settings = JSON.parse(NodeFS.readFileSync(input.settingsFile, "utf8"));
  } catch {
    settings = { unreadable: true };
  }
  const sections: Section[] = [
    {
      title: "This computer",
      body: [
        `Tessaya ${input.version}`,
        `${NodeOS.platform()} ${NodeOS.release()} ${NodeOS.arch()}`,
        `memory ${Math.round(NodeOS.freemem() / 1e9)} GB free of ${Math.round(NodeOS.totalmem() / 1e9)} GB`,
        `cpus ${NodeOS.cpus().length}`,
        `uptime ${Math.round(NodeOS.uptime() / 3600)} h`,
      ].join("\n"),
    },
    {
      title: "Why Tessaya went down or restarted (lifecycle log, last lines)",
      body: scrubLog(tail(NodePath.join(input.logDir, "baton-lifecycle.ndjson"))),
    },
    {
      title: "Recent turns: kinds and timings only, no words",
      body: scrubLog(tail(NodePath.join(input.logDir, "voice-turns.ndjson"))),
    },
    { title: "Settings, without anything private", body: scrubSettings(settings) },
    { title: "State folder (names and sizes)", body: folderListing(input.stateDir) },
  ];
  const dir = NodePath.join(input.stateDir, "diagnostics");
  NodeFS.mkdirSync(dir, { recursive: true });
  const file = NodePath.join(
    dir,
    `tessaya-diagnostics-${at.slice(0, 19).replace(/[:T]/g, "-")}.txt`,
  );
  NodeFS.writeFileSync(file, buildDiagnostics({ at, sections }));
  // A short list: the last ten stay.
  const old = NodeFS.readdirSync(dir)
    .filter((n) => n.startsWith("tessaya-diagnostics-"))
    .toSorted();
  for (const n of old.slice(0, Math.max(0, old.length - 10)))
    NodeFS.rmSync(NodePath.join(dir, n), { force: true });
  return file;
};
