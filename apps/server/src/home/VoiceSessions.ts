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
  used: number;
  dead: boolean;
  readonly send: (text: string, turn: SessionTurn) => Promise<void>;
  readonly close: () => void;
}

/** A warmed session waiting longer than this is replaced, so its login and the 1 h prompt cache stay fresh. */
const IDLE_MS = 30 * 60_000;
/** A vessel with no turn for this long lets its sessions go. */
const DROP_MS = 12 * 60 * 60_000;
const SPARES = 2;
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
  // Live (13 Nov), a first call by the short name the prompt uses failed with "No such tool available" in about half
  // of the suite's runs; naming the server's prefix took that to 0 of 6. The API route's tools have no prefix.
  `${spec.system}\n\nthe tools named here are short names: each one's full name starts with mcp__${MCP_NAME}__ (home_find is mcp__${MCP_NAME}__home_find); always call the full name.`,
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
    /** One warm session per vessel and no background renewal: a test harness's server (the room suite), not his. */
    readonly lean?: boolean;
  } = {},
) => {
  const spawn = options.spawn ?? NodeChildProcess.spawn;
  const now = options.now ?? Date.now;
  const retryMs = options.retryMs ?? 750;
  const spares = options.lean === true ? 1 : SPARES;

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

  /** One vessel's warm sessions for its current spec, oldest first. */
  interface Slot {
    readonly spec: string;
    readonly ready: Array<Promise<Session>>;
    takenAt: number;
  }
  const slots = new Map<string, Slot>();
  const settled = async (p: Promise<Session>) => p.catch(() => null);
  const closeAll = (slot: Slot) => {
    for (const p of slot.ready.splice(0)) void settled(p).then((s) => s?.close());
  };
  /** Takes `p` out of the slot; false when a turn or a spec change already did. */
  const remove = (slot: Slot, p: Promise<Session>) => {
    const at = slot.ready.indexOf(p);
    if (at >= 0) slot.ready.splice(at, 1);
    return at >= 0;
  };

  /** A session for the slot, renewed in the background once it has waited IDLE_MS, so a turn never waits on a warm-up. */
  const add = (slot: Slot, spec: SessionSpec): Promise<Session> => {
    const p = start(spec);
    slot.ready.push(p);
    void settled(p).then((s) => {
      if (s === null) return void remove(slot, p);
      if (options.lean === true) return;
      setTimeout(() => {
        if (!slot.ready.includes(p)) return;
        // A vessel gone quiet for good (a replay, a retired device) stops holding sessions.
        if (now() - slot.takenAt > DROP_MS) return void (remove(slot, p) && s.close());
        // The old one stays usable until its replacement is warm.
        void settled(add(slot, spec)).then(() => remove(slot, p) && s.close());
      }, IDLE_MS).unref?.();
    });
    return p;
  };

  /**
   * A warm session for this vessel, with SPARES more already warming behind it: an early start he talks past closes
   * its session, and the turn right after must not wait on a warm-up (13 Nov: 2.9 s to her first word).
   */
  const take = async (vessel: string, spec: SessionSpec): Promise<Session> => {
    const slot = slotFor(vessel, spec);
    for (let left = slot.ready.length; left > 0; left -= 1) {
      const p = slot.ready.shift()!;
      topUp(slot, spec);
      const s = await settled(p);
      if (s !== null && !s.dead && s.used === 0) return s;
      s?.close();
    }
    const cold = start(spec);
    topUp(slot, spec);
    return cold;
  };
  /** The vessel's slot for this spec; a new spec lets the old one's sessions go. */
  const slotFor = (vessel: string, spec: SessionSpec) => {
    const key = specKey(spec);
    let slot = slots.get(vessel);
    if (slot?.spec !== key) {
      if (slot !== undefined) closeAll(slot);
      slot = { spec: key, ready: [], takenAt: now() };
      slots.set(vessel, slot);
    }
    slot.takenAt = now();
    return slot;
  };
  const topUp = (slot: Slot, spec: SessionSpec) => {
    while (slot.ready.length < spares) add(slot, spec);
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
    /** Starts this vessel's warm sessions ahead of its first turn; a no-op when they are already up. */
    warm: async (vessel: string, spec: SessionSpec) => {
      const slot = slotFor(vessel, spec);
      topUp(slot, spec);
      await Promise.all(slot.ready.map(settled));
    },
    close: async () => {
      const all = [...slots.values()].flatMap((slot) => slot.ready.splice(0));
      slots.clear();
      for (const s of await Promise.all(all.map(settled))) s?.close();
    },
  };
};

export type VoiceSessions = ReturnType<typeof createVoiceSessions>;
