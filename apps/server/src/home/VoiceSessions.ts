// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off globalJsonInEffect:off preferSchemaOverJson:off
/**
 * Spoken turns on his subscription (BRAIN-DESIGN §13-14): warm Claude Code sessions, thinking off, the room's tools on a
 * local MCP server. A session's first turn is slow (B0), so each is warmed before it takes his; it then takes one turn
 * (a kept conversation let Sonnet answer the house from memory) while its successor warms. Failed spawns are retried.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

import { startBatonMcp, type BatonMcp, type ToolOutput } from "@t3tools/baton-shared/sessionMcp";

/** What one line of the session's stream-json says, as far as a spoken turn cares. */
export type SessionEvent =
  | { readonly type: "text"; readonly text: string }
  /** A tool call started: `web` for Claude Code's own WebSearch and WebFetch, which take seconds. */
  | { readonly type: "tool"; readonly name: string; readonly web: boolean }
  | { readonly type: "done" }
  | { readonly type: "error"; readonly detail: string };

const MCP_NAME = "room";
const WEB_TOOLS = ["WebSearch", "WebFetch"];

export const sessionEvent = (line: string): SessionEvent | null => {
  let event: Record<string, any>;
  try {
    event = JSON.parse(line) as Record<string, any>;
  } catch {
    return null;
  }
  if (event["type"] === "result")
    return event["is_error"] === true
      ? {
          type: "error",
          detail: String(event["result"] ?? event["subtype"] ?? "failed").slice(0, 300),
        }
      : { type: "done" };
  if (event["type"] !== "stream_event") return null;
  const e = event["event"] as Record<string, any> | undefined;
  if (e?.["type"] === "content_block_start" && e["content_block"]?.["type"] === "tool_use") {
    const name = String(e["content_block"]["name"]).replace(`mcp__${MCP_NAME}__`, "");
    return { type: "tool", name, web: WEB_TOOLS.includes(name) };
  }
  if (e?.["type"] === "content_block_delta" && e["delta"]?.["type"] === "text_delta")
    return { type: "text", text: String(e["delta"]["text"]) };
  return null;
};

export interface SessionTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

/** What a session runs on; sessions with different settings never share a slot. */
export interface SessionSpec {
  readonly model: string;
  readonly effort: string | null;
  readonly system: string;
  readonly tools: ReadonlyArray<SessionTool>;
}

/** The turn in progress: its tool runner and what it hears back. */
export interface SessionTurn {
  readonly run: (name: string, args: Readonly<Record<string, unknown>>) => Promise<ToolOutput>;
  readonly onEvent: (event: SessionEvent) => void;
  /** He cut her off: the session's state is unknown, so it is closed and its warm successor takes over. */
  readonly signal?: AbortSignal;
}

interface Session {
  readonly spec: string;
  readonly bornAt: number;
  used: number;
  dead: boolean;
  readonly send: (text: string, turn: SessionTurn) => Promise<void>;
  readonly close: () => void;
}

/** A warmed session waiting longer than this is replaced, so its login and cache stay fresh. */
const IDLE_MS = 30 * 60_000;
const SPAWN_TRIES = 4;
const WARM_UP = 'This message only gets you ready; nothing is said aloud. Reply with just "ok".';

/** The subscription, never a metered key: the same rule as the desktop's sessions. */
const METERED =
  /^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL|CLAUDE_CODE_USE_BEDROCK|CLAUDE_CODE_USE_VERTEX|ANTHROPIC_BEDROCK_.*|ANTHROPIC_VERTEX_.*)$/;

const sessionArgs = (spec: SessionSpec, mcpConfig: string): ReadonlyArray<string> => [
  "-p",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--include-partial-messages",
  "--verbose",
  "--model",
  spec.model,
  ...(spec.effort === null ? [] : ["--effort", spec.effort]),
  "--system-prompt",
  spec.system,
  // Thinking off before the first word (B0: on, p95 10.8 s); no hooks of his.
  "--settings",
  JSON.stringify({ disableAllHooks: true, alwaysThinkingEnabled: false }),
  "--mcp-config",
  mcpConfig,
  "--strict-mcp-config",
  // Her own web search and fetch, on the subscription (BRAIN-DESIGN §13).
  "--tools",
  WEB_TOOLS.join(","),
  "--allowedTools",
  [`mcp__${MCP_NAME}__*`, ...WEB_TOOLS].join(","),
  "--disable-slash-commands",
  "--permission-mode",
  "dontAsk",
  "--setting-sources",
  "",
  "--no-session-persistence",
];

const specKey = (spec: SessionSpec) =>
  JSON.stringify([spec.model, spec.effort, spec.system, spec.tools.map((t) => t.name)]);

export const createVoiceSessions = (
  options: {
    readonly spawn?: typeof NodeChildProcess.spawn;
    readonly now?: () => number;
    /** How long to wait before trying a failed spawn again. */
    readonly retryMs?: number;
  } = {},
) => {
  const spawn = options.spawn ?? NodeChildProcess.spawn;
  const now = options.now ?? Date.now;
  const retryMs = options.retryMs ?? 750;

  const start = async (spec: SessionSpec): Promise<Session> => {
    let turn: SessionTurn | null = null;
    const mcp: BatonMcp = await startBatonMcp({
      tools: spec.tools.map((tool) => ({
        ...tool,
        run: (args) =>
          turn === null
            ? Promise.resolve({ text: "No turn is in progress." })
            : turn.run(tool.name, args),
      })),
      // The room's runner applies the house's gate and McpToolAccess itself (R1Tools).
      gate: async () => ({ allow: true }),
    });
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "tessaya-voice-"));
    const config = NodePath.join(dir, "mcp.json");
    // The token is this session's alone; the file is private and goes with the session.
    NodeFS.writeFileSync(
      config,
      JSON.stringify({
        mcpServers: {
          [MCP_NAME]: {
            type: "http",
            url: mcp.url,
            headers: { Authorization: `Bearer ${mcp.token}` },
          },
        },
      }),
      { mode: 0o600 },
    );
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !METERED.test(k)));
    let child: NodeChildProcess.ChildProcess | null = null;
    for (let tries = 1; child === null; tries += 1) {
      const proc = spawn("claude", [...sessionArgs(spec, config)], {
        cwd: dir,
        env: { ...env, CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1" },
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
      });
      const failed = await new Promise<boolean>((resolve) => {
        proc.once("error", () => resolve(true));
        proc.once("spawn", () => resolve(false));
      });
      if (!failed) child = proc;
      else if (tries >= SPAWN_TRIES) {
        void mcp.close();
        NodeFS.rmSync(dir, { recursive: true, force: true });
        throw new Error("claude could not be started");
      } else await new Promise((resolve) => setTimeout(resolve, retryMs));
    }
    const proc = child;
    let waiting: ((event: SessionEvent) => void) | null = null;
    // Exit, a broken pipe or our own close: whichever comes first ends the session and fails a turn in progress.
    const end = (detail: string) => {
      if (session.dead) return;
      session.dead = true;
      proc.kill();
      void mcp.close();
      NodeFS.rmSync(dir, { recursive: true, force: true });
      waiting?.({ type: "error", detail });
    };
    const session: Session = {
      spec: specKey(spec),
      bornAt: now(),
      used: 0,
      dead: false,
      close: () => end("the session was closed"),
      send: (text, next) =>
        new Promise<void>((resolve, reject) => {
          if (session.dead) return reject(new Error("the session has ended"));
          if (next.signal?.aborted === true) return reject(new Error("cut off"));
          next.signal?.addEventListener("abort", () => end("cut off"), { once: true });
          turn = next;
          waiting = (event) => {
            next.onEvent(event);
            if (event.type === "done" || event.type === "error") {
              waiting = null;
              turn = null;
              if (event.type === "done") resolve();
              else reject(new Error(event.detail));
            }
          };
          proc.stdin?.write(
            `${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`,
          );
        }),
    };
    const died = () => end("claude exited before answering");
    proc.on("exit", died);
    proc.on("error", died);
    proc.stdin?.on("error", died);
    NodeReadline.createInterface({ input: proc.stdout! }).on("line", (line) => {
      const event = sessionEvent(line);
      if (event !== null) waiting?.(event);
    });
    // The first turn on a session is the slow one: it is spent here, never on his words.
    await session.send(WARM_UP, { run: async () => ({ text: "" }), onEvent: () => undefined });
    return session;
  };

  const slots = new Map<string, { now: Promise<Session> | null; next: Promise<Session> | null }>();
  const usable = (s: Session) => !s.dead && now() - s.bornAt < IDLE_MS && s.used === 0;
  const settled = async (p: Promise<Session> | null) => (p === null ? null : p.catch(() => null));

  /** A warm session for this vessel and spec, its successor already warming; the cold path only when there is none. */
  const take = async (vessel: string, spec: SessionSpec): Promise<Session> => {
    const key = `${vessel}\n${specKey(spec)}`;
    const slot = slots.get(key) ?? { now: null, next: null };
    slots.set(key, slot);
    let current = await settled(slot.now);
    if (current === null || !usable(current)) {
      current?.close();
      const next = await settled(slot.next);
      current = next !== null && usable(next) ? next : await start(spec);
      slot.now = Promise.resolve(current);
      slot.next = null;
    }
    // Warmed now, for the next recycle or a session lost mid-turn.
    if (slot.next === null) slot.next = start(spec);
    return current;
  };

  return {
    /** One spoken turn, carrying its own recent conversation, in a warmed session that then goes. */
    turn: async (vessel: string, spec: SessionSpec, text: string, turn: SessionTurn) => {
      const session = await take(vessel, spec);
      session.used += 1;
      try {
        await session.send(text, turn);
      } finally {
        session.close();
      }
    },
    /** Starts a warm session for this vessel ahead of its first turn. */
    warm: (vessel: string, spec: SessionSpec) => take(vessel, spec).then(() => undefined),
    close: async () => {
      for (const slot of slots.values()) {
        (await settled(slot.now))?.close();
        (await settled(slot.next))?.close();
      }
      slots.clear();
    },
  };
};

export type VoiceSessions = ReturnType<typeof createVoiceSessions>;
