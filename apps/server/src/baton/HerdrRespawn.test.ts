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

// Real processes: a stand-in Claude (argv[0] "claude") and one whose descriptor names an older start (a reused pid).
it.live(
  "ends a session with SIGTERM to its verified pid only, never typing, and never a reused pid",
  () =>
    Effect.gen(function* () {
      const cfg = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "tessaya-end-"));
      NodeFS.mkdirSync(NodePath.join(cfg, "sessions"));
      const before = process.env["BATON_CLAUDE_CONFIG_DIRS"];
      process.env["BATON_CLAUDE_CONFIG_DIRS"] = cfg;
      const spawn = () =>
        NodeChildProcess.spawn("bash", ["-c", "exec -a claude sleep 30"], { stdio: "ignore" });
      const own = spawn();
      const reused = spawn();
      const spawned = Promise.all(
        [own, reused].map((child) => new Promise((resolve) => child.once("spawn", resolve))),
      );
      yield* Effect.promise(() => spawned);
      const write = (pid: number, sessionId: string, procStart: string) =>
        NodeFS.writeFileSync(
          NodePath.join(cfg, "sessions", `${pid}.json`),
          JSON.stringify({ pid, sessionId, procStart, kind: "interactive", entrypoint: "cli" }),
        );
      const ownExit = new Promise((resolve) => own.once("exit", resolve));
      write(own.pid!, "s-own", startOf(own.pid!));
      write(reused.pid!, "s-reused", String(Number(startOf(reused.pid!)) - 1));
      try {
        expect(yield* endClaudeTerminal("s-own")).toBe(true);
        yield* Effect.promise(() => ownExit);
        // Nothing verified holds it, so nothing is signalled, and the stranger keeps running.
        expect(yield* endClaudeTerminal("s-reused")).toBe(true);
        expect(reused.exitCode).toBeNull();
      } finally {
        own.kill();
        reused.kill();
        if (before === undefined) delete process.env["BATON_CLAUDE_CONFIG_DIRS"];
        else process.env["BATON_CLAUDE_CONFIG_DIRS"] = before;
        NodeFS.rmSync(cfg, { recursive: true, force: true });
      }
    }),
);
