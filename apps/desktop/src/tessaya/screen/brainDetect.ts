// @effect-diagnostics nodeBuiltinImport:off
/** Asks each tool whether it is installed and signed in. Never in the path of a turn. */
import * as NodeChildProcess from "node:child_process";

import {
  parseClaudeStatus,
  parseCodexStatus,
  type BrainStatus,
  type ToolStatus,
} from "./brainChoice.ts";
import { resolveBinary, subscriptionEnv } from "./claudeVision.ts";

const TIMEOUT_MS = 10_000;

const run = (
  binary: string,
  args: ReadonlyArray<string>,
  input: { env: NodeJS.ProcessEnv; platform: string },
): Promise<{ stdout: string; code: number | null } | null> =>
  new Promise((resolve) => {
    const exe = resolveBinary(binary, input.platform, input.env);
    let stdout = "";
    const child = NodeChildProcess.spawn(exe, [...args], {
      env: subscriptionEnv(input.env),
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      shell: input.platform === "win32" && /\.cmd$/i.test(exe),
      timeout: TIMEOUT_MS,
    });
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve({ stdout, code }));
  });

export const detectBrains = async (input: {
  readonly env: NodeJS.ProcessEnv;
  readonly platform: string;
  readonly claudeBinary: string;
  readonly codexBinary: string;
}): Promise<BrainStatus> => {
  const [claudeOut, codexOut] = await Promise.all([
    run(input.claudeBinary, ["auth", "status"], input),
    run(input.codexBinary, ["login", "status"], input),
  ]);
  const claude: ToolStatus =
    claudeOut === null ? { state: "missing" } : parseClaudeStatus(claudeOut.stdout);
  const codex: ToolStatus =
    codexOut === null ? { state: "missing" } : parseCodexStatus(codexOut.stdout, codexOut.code);
  return { claude, codex };
};
