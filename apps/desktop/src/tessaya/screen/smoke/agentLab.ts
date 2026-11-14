// @effect-diagnostics globalDate:off globalRandom:off globalTimers:off nodeBuiltinImport:off globalConsole:off
/**
 * The real run of the assistant's hands (D144): the six tasks, three runs each, on a Windows desktop,
 * through the real companion with the one assistant on. It moves the pointer, so it runs only when he is
 * away and has been told: `LAB_AWAY` must name the time he said so, within the last four hours, and
 * `BATON_LAB=1` must be set. `scripts/tessaya/computer-use-harness.sh real` checks both and starts it.
 */
/* oxlint-disable t3code/no-global-process-runtime -- standalone lab harness, no Effect runtime */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as Electron from "electron";

import { startScreenCompanion } from "../ScreenCompanion.ts";
import { report, score, TASKS, type RunResult } from "./agentTasks.ts";

const FOUR_HOURS = 4 * 60 * 60_000;
const away = Date.parse(process.env["LAB_AWAY"] ?? "");
if (
  process.env["BATON_LAB"] !== "1" ||
  !(Date.now() - away >= 0 && Date.now() - away < FOUR_HOURS)
) {
  console.error(
    "Refusing: this moves the pointer. Set BATON_LAB=1 and LAB_AWAY to the time he said he was away (within four hours).",
  );
  process.exit(2);
}
const out = process.env["LAB_OUT"] ?? NodePath.join(process.cwd(), "lab-out");
const runs = Number(process.env["LAB_RUNS"] ?? 3);
const stateDir = NodePath.join(out, "state");
NodeFS.mkdirSync(stateDir, { recursive: true });
NodeFS.writeFileSync(
  NodePath.join(stateDir, "baton-screen.json"),
  JSON.stringify({
    captureApproval: "always",
    actWithoutAsking: true,
    claudeBinary: process.env["LAB_CLAUDE"] ?? "claude",
  }),
);

const results: RunResult[] = [];
let toolsThisTurn = 0;
let turnDone: (() => void) | null = null;
const notes = NodeFS.createWriteStream(NodePath.join(out, "notes.jsonl"));

void Electron.app.whenReady().then(async () => {
  const companion = startScreenCompanion({
    stateDir,
    platform: process.platform,
    env: process.env,
    speak: async () => undefined,
    holdEscape: () => () => undefined,
    onNote: (kind, fields) => {
      notes.write(`${JSON.stringify({ kind, ...fields })}\n`);
      if (kind === "agent_turn")
        toolsThisTurn = Array.isArray(fields["tools"]) ? fields["tools"].length : 0;
    },
    onTurnEnd: () => turnDone?.(),
  });
  for (const task of TASKS) {
    for (let run = 1; run <= runs; run += 1) {
      const started = Date.now();
      toolsThisTurn = 0;
      const ended = new Promise<void>((resolve) => {
        turnDone = resolve;
        setTimeout(resolve, 5 * 60_000);
      });
      await companion.said(task.goal, { direct: false, typed: true });
      await ended;
      // Finished and misclicks are read from the frames afterwards; the file check covers task one.
      const finished =
        task.id === "notepad"
          ? NodeFS.existsSync(NodePath.join(NodeOS.homedir(), "Documents", "tessaya-task-one.txt"))
          : false;
      results.push({
        task: task.id,
        run,
        finished,
        steps: toolsThisTurn,
        wallMs: Date.now() - started,
        misclicks: 0,
      });
    }
  }
  NodeFS.writeFileSync(NodePath.join(out, "results.json"), JSON.stringify(results, null, 2));
  console.log(
    report(
      "after (one assistant): finished is automatic for task one only; read the rest from the frames",
      score(results),
    ),
  );
  companion.dispose();
  Electron.app.quit();
});
