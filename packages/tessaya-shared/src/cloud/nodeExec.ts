/* oxlint-disable t3code/no-global-process-runtime -- the real process boundary; tests inject the platform */
// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
/**
 * The real process runner and the small files the local transport keeps. An argument list, never a
 * shell string; a timeout; the brief on stdin; Windows, macOS and Linux alike (`windowsHide`, and a
 * `.cmd` shim is run through the shell only on Windows).
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { launchPlan, type LaunchEnv } from "./winLaunch.ts";
import type { BriefStore, PendingStore } from "./local.ts";
import type { CloudRequest, Exec } from "./types.ts";

const realLaunchEnv = (): LaunchEnv => ({
  platform: process.platform,
  path: process.env["PATH"] ?? process.env["Path"] ?? "",
  pathext: process.env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD",
  exists: (f) => NodeFS.existsSync(f),
  read: (f) => {
    try {
      return NodeFS.readFileSync(f, "utf8");
    } catch {
      return null;
    }
  },
});

export const nodeExec: Exec = (file, args, o) =>
  new Promise((resolve) => {
    let out = "";
    let err = "";
    let timedOut = false;
    let child: NodeChildProcess.ChildProcess;
    const plan = launchPlan(file, args, realLaunchEnv());
    if (!plan.ok)
      return resolve({
        code: null,
        stdout: "",
        stderr: plan.error,
        missing: plan.error.endsWith("is not installed on this computer."),
      });
    try {
      // Never a shell string: the argument list goes to the program (a cmd shim only when every argument is plain).
      child = NodeChildProcess.spawn(plan.file, [...plan.args], {
        env: { ...process.env, ...o.env },
        ...(o.cwd === undefined ? {} : { cwd: o.cwd }),
        windowsHide: true,
        shell: plan.viaCmd,
      });
    } catch {
      return resolve({ code: null, stdout: "", stderr: "", missing: true });
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, o.timeoutMs);
    child.stdout?.on("data", (d: Buffer) => void (out += d.toString("utf8")));
    child.stderr?.on("data", (d: Buffer) => void (err += d.toString("utf8")));
    child.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({ code: null, stdout: out, stderr: err, missing: e.code === "ENOENT" });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        code: timedOut ? null : code,
        stdout: out.slice(0, 200_000),
        stderr: err.slice(0, 20_000),
        ...(timedOut ? { timedOut: true } : {}),
        ...(code === 127 ? { missing: true } : {}),
      });
    });
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(o.stdin ?? "");
  });

const readJson = <T>(file: string, fallback: T): T => {
  try {
    return JSON.parse(NodeFS.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
};
const writeJson = (file: string, value: unknown): void => {
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  NodeFS.writeFileSync(`${file}.tmp`, JSON.stringify(value), { mode: 0o600 });
  NodeFS.renameSync(`${file}.tmp`, file);
};

/** Requests in `cloud-requests.json`, the briefs of waiting ones in `cloud-briefs.json`; both private to the user. */
export const fileStores = (
  dir: string,
): { readonly store: PendingStore; readonly briefs: BriefStore } => {
  const requests = NodePath.join(dir, "cloud-requests.json");
  const briefFile = NodePath.join(dir, "cloud-briefs.json");
  const KEEP = 200;
  return {
    store: {
      load: () => readJson<ReadonlyArray<CloudRequest>>(requests, []),
      save: (list) => writeJson(requests, list.slice(-KEEP)),
      nextId: () => {
        const ids = readJson<ReadonlyArray<CloudRequest>>(requests, []).map((r) =>
          Number(/(\d+)$/.exec(r.id)?.[1] ?? 0),
        );
        return `L-${Math.max(0, ...ids) + 1}`;
      },
    },
    briefs: {
      get: (id) => readJson<Record<string, string>>(briefFile, {})[id] ?? null,
      put: (id, brief) =>
        writeJson(briefFile, { ...readJson<Record<string, string>>(briefFile, {}), [id]: brief }),
      drop: (id) => {
        const { [id]: _gone, ...rest } = readJson<Record<string, string>>(briefFile, {});
        writeJson(briefFile, rest);
      },
    },
  };
};
