// @effect-diagnostics nodeBuiltinImport:off
import { it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";

import { endClaudeTerminal } from "./HerdrRespawn.ts";

const startOf = (pid: number) => {
  const stat = NodeFS.readFileSync(`/proc/${pid}/stat`, "utf8");
  return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]!;
};

/** A config dir the server's scan reads (BATON_CLAUDE_CONFIG_DIRS, as in production); returns the undo. */
const scanAlso = (dir: string): (() => void) => {
  const before = process.env["BATON_CLAUDE_CONFIG_DIRS"];
  process.env["BATON_CLAUDE_CONFIG_DIRS"] = dir;
  return () => {
    if (before === undefined) delete process.env["BATON_CLAUDE_CONFIG_DIRS"];
    else process.env["BATON_CLAUDE_CONFIG_DIRS"] = before;
  };
};

const spawnClaudeLike = () =>
  NodeChildProcess.spawn("bash", ["-c", "exec -a claude sleep 30"], { stdio: "ignore" });

// Real processes: a stand-in Claude (argv[0] "claude") and one whose descriptor names another start (a reused pid).
it.live(
  "ends a session with SIGTERM to its verified pid only, never typing, and never a reused pid",
  () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const cfg = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "tessaya-end-"));
        NodeFS.mkdirSync(NodePath.join(cfg, "sessions"));
        return { cfg, undo: scanAlso(cfg), own: spawnClaudeLike(), reused: spawnClaudeLike() };
      }),
      ({ cfg, own, reused }) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Promise.all(
              [own, reused].map((child) => new Promise((resolve) => child.once("spawn", resolve))),
            ),
          );
          const ownExit = new Promise((resolve) => own.once("exit", resolve));
          const write = (pid: number, sessionId: string, procStart: string) =>
            NodeFS.writeFileSync(
              NodePath.join(cfg, "sessions", `${pid}.json`),
              JSON.stringify({ pid, sessionId, procStart, kind: "interactive", entrypoint: "cli" }),
            );
          write(own.pid!, "s-own", startOf(own.pid!));
          write(reused.pid!, "s-reused", String(Number(startOf(reused.pid!)) - 1));
          expect(yield* endClaudeTerminal("s-own")).toBe(true);
          yield* Effect.promise(() => ownExit);
          // Nothing verified holds it, so nothing is signalled, and the stranger keeps running.
          expect(yield* endClaudeTerminal("s-reused")).toBe(true);
          expect(reused.exitCode).toBeNull();
        }),
      ({ cfg, undo, own, reused }) =>
        Effect.sync(() => {
          own.kill();
          reused.kill();
          undo();
          NodeFS.rmSync(cfg, { recursive: true, force: true });
        }),
    ),
);
