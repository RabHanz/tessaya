// @effect-diagnostics nodeBuiltinImport:off
/**
 * Codex as the operator (D127), over `codex app-server`'s JSON lines. `untrusted` makes it ask
 * before anything that is not a known-safe read, and each ask goes through Baton's gate, so Codex
 * and Claude answer to the same rules. Checked against codex-cli 0.166.0.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeReadline from "node:readline";

import type { ToolCall } from "@t3tools/tessaya-shared/operator";

import { resolveBinary, SessionClosed, type ToolGate, type VisionSession } from "./claudeVision.ts";

export interface CodexClientInput {
  readonly write: (line: string) => void;
  readonly gate: ToolGate;
  readonly onTool?: (call: ToolCall) => void;
}

/** The protocol with no process, so it can be tested line by line. */
export const makeCodexClient = (input: CodexClientInput) => {
  let nextId = 0;
  const calls = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  let turn: {
    resolve: (text: string) => void;
    reject: (error: Error) => void;
    text: string;
    onDelta?: ((text: string) => void) | undefined;
  } | null = null;
  const send = (message: unknown) => input.write(`${JSON.stringify(message)}\n`);
  const rpc = (method: string, params: unknown) =>
    new Promise<unknown>((resolve, reject) => {
      nextId += 1;
      calls.set(nextId, { resolve, reject });
      send({ id: nextId, method, params });
    });

  const approval = async (method: string, params: Record<string, unknown>) => {
    const tool = method.includes("commandExecution")
      ? "commandExecution"
      : method.includes("fileChange")
        ? "fileChange"
        : method;
    // Only the fields the gate reads; a grant root is the nearest thing to a path a file change has.
    const { command, cwd, grantRoot } = params;
    const answer = await input.gate({
      tool,
      input: { command, cwd, ...(typeof grantRoot === "string" ? { path: grantRoot } : {}) },
    });
    return { decision: answer.allow ? "accept" : "decline" };
  };

  const onLine = (line: string) => {
    let message: {
      id?: number;
      method?: string;
      params?: Record<string, unknown>;
      result?: unknown;
      error?: unknown;
    };
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const { id, method, params = {} } = message;
    if (id !== undefined && method !== undefined) {
      if (!method.endsWith("/requestApproval")) {
        return send({ id, error: { code: -32601, message: "Not supported by Tessaya." } });
      }
      void approval(method, params)
        .catch(() => ({ decision: "decline" }))
        .then((result) => send({ id, result }));
      return;
    }
    if (id !== undefined) {
      const call = calls.get(id);
      calls.delete(id);
      if (message.error === undefined) call?.resolve(message.result);
      else call?.reject(new Error(JSON.stringify(message.error)));
      return;
    }
    if (method === "item/agentMessage/delta" && typeof params["delta"] === "string") {
      if (turn !== null) turn.text += params["delta"];
      turn?.onDelta?.(params["delta"]);
    } else if (method === "item/started") {
      const item = params["item"] as { type?: string; command?: string } | undefined;
      if (item?.type === "commandExecution") {
        input.onTool?.({ tool: "commandExecution", input: { command: item.command ?? "" } });
      } else if (item?.type === "fileChange") input.onTool?.({ tool: "fileChange", input: {} });
    } else if (method === "turn/completed") {
      const done = turn;
      turn = null;
      done?.resolve(done.text);
    }
  };

  return {
    onLine,
    start: async (cwd: string, instructions: string): Promise<string> => {
      await rpc("initialize", {
        clientInfo: { name: "baton", title: "Tessaya", version: "0.1" },
        capabilities: { experimentalApi: true },
      });
      send({ method: "initialized" });
      const started = (await rpc("thread/start", {
        cwd,
        approvalPolicy: "untrusted",
        sandbox: "danger-full-access",
        ephemeral: true,
        developerInstructions: instructions,
      })) as { thread: { id: string } };
      return started.thread.id;
    },
    ask: (threadId: string, text: string, onDelta?: (text: string) => void) =>
      new Promise<string>((resolve, reject) => {
        turn = { resolve, reject, text: "", onDelta };
        rpc("turn/start", {
          threadId,
          input: [{ type: "text", text, text_elements: [] }],
        }).catch(reject);
      }),
    close: (error: Error) => {
      for (const call of calls.values()) call.reject(error);
      calls.clear();
      turn?.reject(error);
      turn = null;
    },
  };
};

export const startCodexOperator = (options: {
  readonly binary: string;
  readonly cwd: string;
  readonly systemPrompt: string;
  readonly env: NodeJS.ProcessEnv;
  readonly platform: string;
  readonly gate: ToolGate;
  readonly onTool?: (call: ToolCall) => void;
}): VisionSession => {
  const binary = resolveBinary(options.binary, options.platform, options.env);
  const viaShell = options.platform === "win32" && /\.cmd$/i.test(binary);
  const child = NodeChildProcess.spawn(binary, ["app-server"], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
    shell: viaShell,
  });
  let dead = false;
  const client = makeCodexClient({
    write: (line) => {
      if (!dead) child.stdin.write(line);
    },
    gate: options.gate,
    ...(options.onTool === undefined ? {} : { onTool: options.onTool }),
  });
  const die = (error: Error) => {
    dead = true;
    client.close(error);
  };
  child.on("error", (error) =>
    die(
      (error as NodeJS.ErrnoException).code === "ENOENT"
        ? new Error(`Codex was not found at "${options.binary}".`)
        : error,
    ),
  );
  child.on("exit", () => die(new Error("Codex stopped.")));
  child.stdin.on("error", die);
  NodeReadline.createInterface({ input: child.stdout }).on("line", client.onLine);
  const thread = client.start(options.cwd, options.systemPrompt);
  thread.catch(() => undefined);
  return {
    ask: async (content, onDelta) =>
      client.ask(
        await thread,
        content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"),
        onDelta,
      ),
    alive: () => !dead,
    dispose: () => {
      die(new SessionClosed("Codex session closed."));
      if (options.platform === "win32" && child.pid !== undefined) {
        NodeChildProcess.execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
          windowsHide: true,
        });
      } else child.kill();
    },
  };
};
