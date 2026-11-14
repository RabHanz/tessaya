/* oxlint-disable t3code/no-low-value-comments -- Baton file predating upstream's rule (D82) */
// @effect-diagnostics globalConsole:off globalConsoleInEffect:off nodeBuiltinImport:off globalTimers:off preferSchemaOverJson:off
/**
 * D61 live proof: a T3 terminal backed by a Herdr session outlives the process
 * that held it. Spawns exactly what the terminal manager spawns
 * (`terminalShellCandidates` with runtime=herdr) in a real node-pty, starts a
 * long-running process inside, kills the pty the way a T3 restart does, and
 * checks the process is still alive and the same session re-attaches. Then
 * runs the close path and checks the session is gone.
 *
 *   node apps/server/scripts/baton-herdr-terminal-proof.ts
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeModule from "node:module";

import {
  herdrTerminalSessionName,
  terminalShellCandidates,
  type HerdrShellCandidate,
} from "../src/tessaya/HerdrTerminal.ts";

const require = NodeModule.createRequire(import.meta.url);
const pty = require("node-pty") as typeof import("node-pty");

const threadId = `proof-${process.pid}`;
const terminalId = "default";
const name = herdrTerminalSessionName(threadId, terminalId);
const [candidate] = terminalShellCandidates({
  runtime: "herdr",
  threadId,
  terminalId,
  shells: [{ shell: "/bin/bash" } as HerdrShellCandidate],
});
if (candidate === undefined) throw new Error("no candidate");

const herdr = (...args: string[]) =>
  NodeChildProcess.execFileSync("herdr", args, { encoding: "utf8" }).trim();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const attach = () =>
  pty.spawn(candidate.shell, candidate.args ?? [], {
    cols: 120,
    rows: 32,
    cwd: process.cwd(),
    env: process.env as Record<string, string>,
  });

console.log(`spawn: ${candidate.shell} ${(candidate.args ?? []).join(" ")}`);
const first = attach();
await sleep(2500);
const pane = JSON.parse(herdr("--session", name, "pane", "list")).result.panes[0].pane_id as string;
herdr("--session", name, "pane", "run", pane, "sleep 7777");
await sleep(1500);
const info = JSON.parse(herdr("--session", name, "pane", "process-info", "--pane", pane)).result
  .process_info;
const workPid = info.foreground_process_group_id as number;
console.log(`inside the pane: pid ${workPid} (${info.foreground_processes?.[0]?.cmdline ?? "?"})`);

first.kill("SIGKILL");
await sleep(1500);
console.log(`after the T3-side pty is killed: work alive=${alive(workPid)}`);
console.log(
  `herdr sessions: ${herdr("session", "list")
    .split("\n")
    .filter((l) => l.startsWith(name))
    .join(" | ")}`,
);

const second = attach();
await sleep(2500);
const again = JSON.parse(herdr("--session", name, "pane", "process-info", "--pane", pane)).result
  .process_info.foreground_process_group_id;
console.log(`re-attached: same work pid=${again === workPid}`);
second.kill("SIGKILL");

// The close path, as Manager.closeSession runs it.
herdr("session", "stop", name);
herdr("session", "delete", name);
await sleep(1000);
console.log(
  `after close: work alive=${alive(workPid)}, session listed=${herdr("session", "list").includes(name)}`,
);
process.exit(0);
