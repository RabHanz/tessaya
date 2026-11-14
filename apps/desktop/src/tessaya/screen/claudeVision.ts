// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off globalRandom:off
/**
 * The companion's model: his own `claude`, on his subscription (D1, D84), one conversation per
 * look, lesson or drive. --safe-mode drops hooks/CLAUDE.md/MCP, --tools "" gives it nothing to
 * act with, and ANTHROPIC_API_KEY is removed so it can never bill the API.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

import type { ToolCall } from "@t3tools/tessaya-shared/operator";

export type VisionContent =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "image";
      readonly mediaType: "image/jpeg" | "image/png";
      readonly data: Buffer;
    };

export interface VisionSession {
  readonly ask: (
    content: ReadonlyArray<VisionContent>,
    /** Text as it arrives, for speaking before the answer is finished. */
    onDelta?: (text: string) => void,
  ) => Promise<string>;
  /** The process is still there to answer. */
  readonly alive: () => boolean;
  readonly dispose: () => void;
}

/** Decides a tool call before it runs. Whatever answers, the harness obeys it. */
export type ToolGate = (
  call: ToolCall,
) => Promise<{ readonly allow: true } | { readonly allow: false; readonly reason: string }>;

export interface VisionSessionOptions {
  readonly claudeBinary: string;
  readonly model: string;
  readonly systemPrompt: string;
  /** An empty directory of Baton's own, so no project's settings are picked up. */
  readonly workDir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly platform: string;
  readonly timeoutMs?: number;
  /** Runs with his files and shell, every call through this gate. Absent: no tools at all. */
  readonly gate?: ToolGate;
  /** Where the tools start; `workDir` otherwise. */
  readonly cwd?: string;
  /** Every tool call the model makes, for the log. */
  readonly onTool?: (call: ToolCall) => void;
  /** Baton's own tool server for this session: its address and the token it needs (D143). */
  readonly mcp?: { readonly url: string; readonly token: string };
  /** Pass `--chrome` so the session can use his Claude in Chrome extension (D3). */
  readonly chrome?: boolean;
  /** `--effort`; medium when absent, and none for the fast router model. */
  readonly effort?: string;
}

/** Files, shell and the web. Nothing that outlives the turn, such as schedules or triggers. */
export const OPERATOR_TOOLS = "Read,Glob,Grep,Edit,Write,NotebookEdit,Bash,WebFetch,WebSearch";

/**
 * `--setting-sources ""` is what makes the gate real, proven on the CLI: a user default of
 * bypassPermissions ran every tool with no request, and a folder's own .claude/settings.json is
 * untrusted content. A CLI read-only Bash still skips the gate; `toolUsesOf` logs it.
 */
const OPERATOR_FLAGS: ReadonlyArray<string> = [
  "--setting-sources",
  "",
  "--permission-mode",
  "default",
  "--permission-prompt-tool",
  "stdio",
];

export const visionArgs = (
  systemPromptFile: string,
  model: string,
  operator = false,
  /** A file naming the MCP servers this session may use, and no others (D143). */
  mcpConfigFile?: string,
  /** Claude in Chrome: the session can drive his own browser (D3). Off unless he turned it on. */
  chrome = false,
  effort = "medium",
): ReadonlyArray<string> => [
  "-p",
  // Since CLI 2.1.318 safe mode also drops --mcp-config servers. With our own server, the setting,
  // strict-MCP and tool flags shut out his customisations instead, and CLAUDE.md is off by env.
  ...(mcpConfigFile === undefined ? ["--safe-mode"] : []),
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--verbose",
  "--include-partial-messages",
  "--model",
  model,
  // The fast router model takes no effort setting.
  ...(/haiku/i.test(model) ? [] : ["--effort", effort]),
  "--tools",
  operator ? OPERATOR_TOOLS : "",
  ...(operator ? OPERATOR_FLAGS : []),
  ...(mcpConfigFile === undefined ? [] : ["--mcp-config", mcpConfigFile, "--strict-mcp-config"]),
  ...(chrome ? ["--chrome"] : []),
  "--no-session-persistence",
  "--system-prompt-file",
  systemPromptFile,
];

const METERED_ENV =
  /^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL|CLAUDE_CODE_USE_BEDROCK|CLAUDE_CODE_USE_VERTEX|ANTHROPIC_BEDROCK_.*|ANTHROPIC_VERTEX_.*)$/;

/** The session was closed on purpose, by Baton. Nothing went wrong. */
// @effect-diagnostics-next-line extendsNativeError:off -- a Promise rejection, never in an Effect failure channel.
export class SessionClosed extends Error {}

/** The child's environment: his, minus anything that would bill the API instead of the plan. */
export const subscriptionEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const next = { ...env };
  for (const key of Object.keys(next)) {
    if (METERED_ENV.test(key)) delete next[key];
  }
  return next;
};

export const userMessage = (content: ReadonlyArray<VisionContent>): string =>
  JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: content.map((c) =>
        c.type === "text"
          ? { type: "text", text: c.text }
          : {
              type: "image",
              source: { type: "base64", media_type: c.mediaType, data: c.data.toString("base64") },
            },
      ),
    },
  });

/** The answer in one stream-json line, or null when the line is something else. */
export const resultOf = (
  line: string,
):
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly error: string }
  | null => {
  let event: { type?: unknown; is_error?: unknown; result?: unknown; subtype?: unknown };
  try {
    event = JSON.parse(line);
  } catch {
    return null;
  }
  if (event.type !== "result") return null;
  if (event.is_error === true || typeof event.result !== "string") {
    return {
      ok: false,
      error: typeof event.result === "string" ? event.result : String(event.subtype ?? "error"),
    };
  }
  return { ok: true, text: event.result };
};

/** Streamed text in one stream-json line, or null when the line is something else. */
export const deltaOf = (line: string): string | null => {
  try {
    const event = JSON.parse(line) as {
      type?: unknown;
      event?: { type?: unknown; delta?: { type?: unknown; text?: unknown } };
    };
    const inner = event.type === "stream_event" ? event.event : undefined;
    return inner?.type === "content_block_delta" &&
      inner.delta?.type === "text_delta" &&
      typeof inner.delta.text === "string"
      ? inner.delta.text
      : null;
  } catch {
    return null;
  }
};

/** A permission request in one stream-json line, or null when the line is something else. */
export const toolRequestOf = (
  line: string,
): { readonly requestId: string; readonly call: ToolCall } | null => {
  try {
    const event = JSON.parse(line) as {
      type?: unknown;
      request_id?: unknown;
      request?: { subtype?: unknown; tool_name?: unknown; input?: unknown };
    };
    if (event.type !== "control_request" || event.request?.subtype !== "can_use_tool") return null;
    if (typeof event.request_id !== "string" || typeof event.request.tool_name !== "string") {
      return null;
    }
    const input = event.request.input;
    return {
      requestId: event.request_id,
      call: {
        tool: event.request.tool_name,
        input: typeof input === "object" && input !== null ? (input as ToolCall["input"]) : {},
      },
    };
  } catch {
    return null;
  }
};

/** The permission reply the CLI is waiting for. */
export const toolAnswerOf = (
  answer: { readonly allow: true } | { readonly allow: false; readonly reason: string },
  call: ToolCall,
) =>
  answer.allow
    ? { behavior: "allow" as const, updatedInput: call.input }
    : { behavior: "deny" as const, message: answer.reason };

/** The tool calls in one stream-json line. */
export const toolUsesOf = (line: string): ReadonlyArray<ToolCall> => {
  try {
    const event = JSON.parse(line) as {
      type?: unknown;
      message?: { content?: unknown };
    };
    if (event.type !== "assistant" || !Array.isArray(event.message?.content)) return [];
    return (event.message.content as ReadonlyArray<Record<string, unknown>>).flatMap((block) =>
      block["type"] === "tool_use" && typeof block["name"] === "string"
        ? [{ tool: block["name"], input: (block["input"] ?? {}) as ToolCall["input"] }]
        : [],
    );
  } catch {
    return [];
  }
};

/**
 * On Windows a bare "claude" may be the native `claude.exe` or npm's `claude.cmd`; spawn without
 * a shell finds only the first, so look on PATH for both. Elsewhere the name is used as given.
 */
export const resolveBinary = (
  name: string,
  platform: string,
  env: NodeJS.ProcessEnv,
  exists: (path: string) => boolean = NodeFS.existsSync,
): string => {
  if (platform !== "win32" || NodePath.extname(name) !== "" || name.includes("\\")) return name;
  const dirs = (env["PATH"] ?? env["Path"] ?? "").split(";").filter(Boolean);
  for (const ext of [".exe", ".cmd"])
    for (const dir of dirs) {
      const candidate = NodePath.win32.join(dir, `${name}${ext}`);
      if (exists(candidate)) return candidate;
    }
  return name;
};

/**
 * What a process can start without a shell: npm's `claude.cmd` only runs the package's own `claude.exe`, so that, when
 * it is there; anything else as given.
 */
export const spawnable = (
  binary: string,
  exists: (path: string) => boolean = NodeFS.existsSync,
): string => {
  if (!/\.cmd$/i.test(binary)) return binary;
  const exe = NodePath.win32.join(
    NodePath.win32.dirname(binary),
    "node_modules",
    "@anthropic-ai",
    "claude-code",
    "bin",
    "claude.exe",
  );
  return exists(exe) ? exe : binary;
};

export const startVisionSession = (options: VisionSessionOptions): VisionSession => {
  NodeFS.mkdirSync(options.workDir, { recursive: true });
  const promptFile = NodePath.join(
    options.workDir,
    `prompt-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`,
  );
  NodeFS.writeFileSync(promptFile, options.systemPrompt, { mode: 0o600 });
  // The token is a secret for this session only; the file is private and goes with the session.
  const mcpFile = options.mcp === undefined ? undefined : promptFile.replace(/\.txt$/, "-mcp.json");
  if (mcpFile !== undefined && options.mcp !== undefined) {
    NodeFS.writeFileSync(
      mcpFile,
      JSON.stringify({
        mcpServers: {
          baton: {
            type: "http",
            url: options.mcp.url,
            headers: { Authorization: `Bearer ${options.mcp.token}` },
          },
        },
      }),
      { mode: 0o600 },
    );
  }
  const binary = resolveBinary(options.claudeBinary, options.platform, options.env);
  // A Windows npm install is `claude.cmd`; a shell is needed to start one, and every argument here is ours.
  const viaShell = options.platform === "win32" && /\.cmd$/i.test(binary);
  const child = NodeChildProcess.spawn(
    binary,
    visionArgs(
      promptFile,
      options.model,
      options.gate !== undefined,
      mcpFile,
      options.chrome === true,
      options.effort,
    ).map((a) => (viaShell ? `"${a}"` : a)),
    {
      cwd: options.cwd ?? options.workDir,
      env: {
        ...subscriptionEnv(options.env),
        ...(mcpFile === undefined ? {} : { CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1" }),
        // The standing prefix stays cached across pauses longer than 5 minutes between his sentences (MEM-19).
        ENABLE_PROMPT_CACHING_1H: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: viaShell,
    },
  );
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-2000);
  });
  const waiting: Array<{
    resolve: (text: string) => void;
    reject: (error: Error) => void;
    onDelta?: ((text: string) => void) | undefined;
  }> = [];
  let dead: Error | null = null;
  const fail = (error: Error) => {
    dead = error;
    for (const w of waiting.splice(0)) w.reject(error);
  };
  child.on("error", (error) =>
    fail(
      new Error(
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? `Claude Code was not found at "${options.claudeBinary}". Install it and sign in, or set its path in Tessaya's screen settings.`
          : error.message,
      ),
    ),
  );
  child.stdin.on("error", (error) => fail(error));
  // `claude.cmd` runs under cmd.exe, so killing the child alone leaves claude running.
  const kill = () => {
    if (options.platform === "win32" && child.pid !== undefined) {
      NodeChildProcess.execFile(
        "taskkill",
        ["/pid", String(child.pid), "/T", "/F"],
        { windowsHide: true },
        () => undefined,
      );
    } else child.kill();
  };
  child.on("exit", (code) =>
    fail(
      new Error(
        `Claude stopped (${code ?? "signal"}). ${stderr.trim().split("\n").at(-1) ?? ""}`.trim(),
      ),
    ),
  );
  const answerTool = (requestId: string, response: unknown) => {
    if (dead !== null) return;
    child.stdin.write(
      `${JSON.stringify({
        type: "control_response",
        response: { subtype: "success", request_id: requestId, response },
      })}\n`,
    );
  };
  NodeReadline.createInterface({ input: child.stdout }).on("line", (line) => {
    const request = options.gate === undefined ? null : toolRequestOf(line);
    if (request !== null) {
      void options.gate!(request.call)
        // An answer that fails is a no.
        .catch(() => ({ allow: false as const, reason: "Tessaya could not check that." }))
        .then((answer) => answerTool(request.requestId, toolAnswerOf(answer, request.call)));
      return;
    }
    for (const call of toolUsesOf(line)) options.onTool?.(call);
    const delta = deltaOf(line);
    if (delta !== null) return waiting[0]?.onDelta?.(delta);
    const result = resultOf(line);
    if (result === null) return;
    const next = waiting.shift();
    if (next === undefined) return;
    if (result.ok) next.resolve(result.text);
    else next.reject(new Error(result.error));
  });

  // One question at a time: stream-json answers in order, and a turn must finish before the next.
  let chain: Promise<unknown> = Promise.resolve();
  const ask: VisionSession["ask"] = (content, onDelta) => {
    const turn = chain.then(
      () =>
        new Promise<string>((resolve, reject) => {
          if (dead !== null) return reject(dead);
          // A late answer would be taken as the next question's, so a timeout ends the session.
          const timer = setTimeout(() => {
            fail(new Error("Claude took too long to answer."));
            kill();
          }, options.timeoutMs ?? 90_000);
          waiting.push({
            resolve: (text) => (clearTimeout(timer), resolve(text)),
            reject: (error) => (clearTimeout(timer), reject(error)),
            onDelta,
          });
          child.stdin.write(`${userMessage(content)}\n`);
        }),
    );
    chain = turn.catch(() => undefined);
    return turn;
  };

  return {
    ask,
    alive: () => dead === null,
    dispose: () => {
      fail(new SessionClosed("Claude session closed."));
      child.stdin.end();
      kill();
      NodeFS.rmSync(promptFile, { force: true });
      if (mcpFile !== undefined) NodeFS.rmSync(mcpFile, { force: true });
    },
  };
};
