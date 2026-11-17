// @effect-diagnostics nodeBuiltinImport:off globalJsonInEffect:off preferSchemaOverJson:off globalTimers:off
/**
 * One stdio MCP connection to the ops system's MCP server, as one worker. The system reads who the connection is from
 * its environment (the worker id and token variables its config names) once, at start, so a connection is a process: it
 * opens on the first call, stays up, and a dead one is reopened by the next call. The token only ever reaches the
 * child's environment; nothing here logs it.
 */
import * as NodeChildProcess from "node:child_process";

interface PersonaOpsLaunch {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly workerIdEnv: string;
  readonly tokenEnv: string;
}

/** A `tools/call` answer: the ops system's JSON (its data on success, its error object on a refusal). */
export interface PersonaOpsToolResult {
  readonly isError: boolean;
  readonly data: unknown;
}

const PROTOCOL_VERSION = "2025-06-18";
const CALL_TIMEOUT_MS = 30_000;
const STDERR_KEEP = 2_000;

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export class PersonaOpsConnection {
  private child: NodeChildProcess.ChildProcess | null = null;
  private ready: Promise<void> | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private buffer = "";
  private stderr = "";

  private readonly launch: PersonaOpsLaunch;
  private readonly workerId: string;
  private readonly token: string;

  constructor(launch: PersonaOpsLaunch, workerId: string, token: string) {
    this.launch = launch;
    this.workerId = workerId;
    this.token = token;
  }

  get open(): boolean {
    return this.child !== null;
  }

  async callTool(
    name: string,
    args: Readonly<Record<string, unknown>>,
  ): Promise<PersonaOpsToolResult> {
    await this.connect();
    const result = (await this.request("tools/call", { name, arguments: args })) as {
      readonly content?: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
      readonly structuredContent?: unknown;
      readonly isError?: boolean;
    };
    const text = result.content?.find((c) => c.type === "text")?.text;
    let data: unknown = result.structuredContent;
    if (data === undefined && text !== undefined) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { message: text };
      }
    }
    return { isError: result.isError === true, data: data ?? null };
  }

  close(): void {
    const child = this.child;
    this.drop(new Error("The ops connection was closed."));
    child?.kill("SIGTERM");
  }

  private connect(): Promise<void> {
    if (this.ready !== null) return this.ready;
    const child = NodeChildProcess.spawn(this.launch.command, [...this.launch.args], {
      cwd: this.launch.cwd,
      env: {
        ...process.env,
        ...this.launch.env,
        [this.launch.workerIdEnv]: this.workerId,
        [this.launch.tokenEnv]: this.token,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.read(chunk));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-STDERR_KEEP);
    });
    const gone = (why: string) => {
      if (this.child !== child) return;
      const tail = this.stderr.trim().split("\n").at(-1) ?? "";
      this.drop(new Error(tail === "" ? why : `${why}: ${tail}`));
    };
    child.on("error", (e) => gone(`The ops system could not start (${e.message})`));
    child.on("exit", (code) => gone(`The ops system stopped (exit ${code ?? "signal"})`));
    this.ready = this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "tessaya-brain", version: "1" },
    }).then(() => this.notify("notifications/initialized"));
    this.ready.catch(() => undefined);
    return this.ready;
  }

  private drop(error: Error): void {
    this.child = null;
    this.ready = null;
    this.buffer = "";
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(error);
      this.pending.delete(id);
    }
  }

  private read(chunk: string): void {
    this.buffer += chunk;
    let at = this.buffer.indexOf("\n");
    while (at >= 0) {
      const line = this.buffer.slice(0, at).trim();
      this.buffer = this.buffer.slice(at + 1);
      at = this.buffer.indexOf("\n");
      if (line === "") continue;
      let message: { id?: unknown; result?: unknown; error?: { message?: string } };
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof message.id !== "number") continue;
      const p = this.pending.get(message.id);
      if (p === undefined) continue;
      this.pending.delete(message.id);
      clearTimeout(p.timer);
      if (message.error !== undefined)
        p.reject(new Error(message.error.message ?? "The ops system refused the call."));
      else p.resolve(message.result);
    }
  }

  private write(message: object): void {
    this.child?.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  }

  private notify(method: string): void {
    this.write({ method });
  }

  private request(method: string, params: object): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("The ops system did not answer in time."));
      }, CALL_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ id, method, params });
    });
  }
}
