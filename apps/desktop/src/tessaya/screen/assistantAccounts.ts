// @effect-diagnostics nodeBuiltinImport:off
/**
 * Looks at each Claude login on this machine by asking `claude auth status` of its directory, and
 * remembers the answer. Asked for at startup, when the window opens, and after a choice: never in
 * the path of a turn, which reads the remembered answer (`pickEnv`).
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";

import { candidateDirs, parseAuthStatus, type AssistantAccount } from "./assistantAccount.ts";
import { resolveBinary, subscriptionEnv } from "./claudeVision.ts";

const STATUS_TIMEOUT_MS = 10_000;

export interface AssistantAccounts {
  readonly cached: () => ReadonlyArray<AssistantAccount> | null;
  readonly refresh: () => Promise<ReadonlyArray<AssistantAccount>>;
}

export const createAssistantAccounts = (input: {
  readonly env: NodeJS.ProcessEnv;
  readonly platform: string;
  readonly claudeBinary: () => string;
  readonly onChange: () => void;
}): AssistantAccounts => {
  let known: ReadonlyArray<AssistantAccount> | null = null;
  let running: Promise<ReadonlyArray<AssistantAccount>> | null = null;

  const status = (dir: string, binary: string) =>
    new Promise<AssistantAccount | null>((resolve) => {
      // His token would make every directory answer as the same login.
      const { CLAUDE_CODE_OAUTH_TOKEN: _token, ...rest } = input.env;
      const viaShell = input.platform === "win32" && /\.cmd$/i.test(binary);
      let out = "";
      const child = NodeChildProcess.spawn(binary, ["auth", "status"], {
        env: subscriptionEnv({ ...rest, CLAUDE_CONFIG_DIR: dir }),
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
        shell: viaShell,
        timeout: STATUS_TIMEOUT_MS,
      });
      child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
      child.on("error", () => resolve(null));
      child.on("close", () => {
        const parsed = parseAuthStatus(out);
        resolve(parsed === null ? null : { key: dir, ...parsed });
      });
    });

  const list = (dir: string): ReadonlyArray<string> => {
    try {
      return NodeFS.readdirSync(dir);
    } catch {
      return [];
    }
  };

  const refresh = () => {
    running ??= (async () => {
      const binary = resolveBinary(input.claudeBinary(), input.platform, input.env);
      const dirs = candidateDirs({ home: NodeOS.homedir(), env: input.env, list }).filter((d) =>
        NodeFS.existsSync(d),
      );
      const found = (await Promise.all(dirs.map((d) => status(d, binary)))).filter(
        (a): a is AssistantAccount => a !== null,
      );
      known = found;
      input.onChange();
      return found;
    })().finally(() => {
      running = null;
    });
    return running;
  };

  return { cached: () => known, refresh };
};
