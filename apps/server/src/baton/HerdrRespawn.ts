/* oxlint-disable t3code/no-low-value-comments -- Baton file predating upstream's rule (D82) */
// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
/**
 * Restart a Claude Code session in its own Herdr pane, same conversation (D69).
 *
 * After the account under the config directory is rotated (D57/D63) a running
 * CLI still holds the spent account's token. Exiting it and running
 * `claude --resume <id>` in the same pane picks up the new credential with the
 * same conversation, the same pane and the same send path — what he does by
 * hand with cswap today, minus the Remote Control re-enable, because Baton's
 * control path is the pane, not the account.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";

import { sessionHolderPid, sessionHolders } from "./ClaudeLiveSessions.ts";
import { parseHerdrForeground, splitPaneRef } from "./HerdrAdapterLive.ts";

const run = (args: ReadonlyArray<string>): Promise<{ ok: boolean; stdout: string }> =>
  new Promise((resolve) => {
    NodeChildProcess.execFile("herdr", [...args], { timeout: 10_000 }, (error, stdout) =>
      resolve({ ok: error === null, stdout: String(stdout ?? "") }),
    );
  });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** tessaya-claude (LIVE-ACCOUNT): the conversation keeps, or gets, its own config dir, so its login can move live. */
export const TESSAYA_CLAUDE = NodePath.join(NodeOS.homedir(), ".local", "bin", "tessaya-claude");
const claudeCommand = () => (NodeFS.existsSync(TESSAYA_CLAUDE) ? "tessaya-claude" : "claude");

/** The argv sequence, separate so it is testable without Herdr. */
export const respawnPlan = (paneRef: string, sessionId: string, claude = claudeCommand()) => {
  const { session, pane } = splitPaneRef(paneRef);
  const prefix = session === null || session === "default" ? [] : ["--session", session];
  return {
    prefix,
    pane,
    exit: [
      [...prefix, "pane", "send-text", pane, "/exit"],
      [...prefix, "pane", "send-keys", pane, "enter"],
    ],
    probe: [...prefix, "pane", "process-info", "--pane", pane],
    resume: [...prefix, "pane", "run", pane, `${claude} --resume ${sessionId}`],
  };
};

export const respawnClaudeInPane = (input: {
  readonly paneRef: string;
  readonly sessionId: string;
}): Effect.Effect<{ readonly respawned: boolean; readonly detail: string }> =>
  Effect.promise(async () => {
    if (!/^[A-Za-z0-9-]+$/.test(input.sessionId)) {
      return { respawned: false, detail: "not a Claude session id" };
    }
    const plan = respawnPlan(input.paneRef, input.sessionId);
    for (const args of plan.exit) await run(args);
    for (let i = 0; i < 40; i += 1) {
      await sleep(250);
      const info = await run(plan.probe);
      if (info.ok && parseHerdrForeground(info.stdout) === null) {
        const resumed = await run(plan.resume);
        return resumed.ok
          ? { respawned: true, detail: `resumed ${input.sessionId} in ${input.paneRef}` }
          : { respawned: false, detail: "herdr refused the resume command" };
      }
    }
    return { respawned: false, detail: "the session did not exit within 10 s; left as it was" };
  });

/**
 * Ends a Claude session's terminal process with SIGTERM to each pid whose descriptor still checks out (claude, same
 * start time), never by typing into the pane, which could submit a draft. True only once no verified process holds the
 * session (within 15 s); false at once when one of them is an SDK process, which is not a terminal's to end.
 */
export const endClaudeTerminal = (sessionId: string): Effect.Effect<boolean> =>
  Effect.promise(async () => {
    const holders = sessionHolders(sessionId).filter((h) => h.verified);
    if (holders.some((h) => h.sdk)) return false;
    for (const holder of holders) {
      try {
        process.kill(holder.pid, "SIGTERM");
      } catch {}
    }
    for (let i = 0; i < 60 && sessionHolderPid(sessionId) !== null; i += 1) await sleep(250);
    return sessionHolderPid(sessionId) === null;
  });
