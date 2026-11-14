// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalFetch:off
/**
 * B0 on the subscription path (BRAIN-DESIGN §6): the device's prompt and tools in a warm Claude Code session that
 * stays up between turns (stream-json in and out), as a pool of warm sessions would run it. The room's tools are served
 * over MCP with the same canned results as `run.ts`, so the arms compare like for like. A session is replaced every
 * `--recycle` turns, the next one started ahead, and the first turn on each new session is reported apart ("fresh").
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as NodeUtil from "node:util";

import { startTessayaMcp } from "../../apps/desktop/src/tessaya/agent/tessayaMcp.ts";
import { LOOK, ROOM_SYSTEM } from "../../apps/server/src/home/R1Device.ts";
import { ROOM_TOOL_SPECS } from "../../apps/server/src/home/R1Tools.ts";
import { percentile } from "./api.ts";
import { roomUser } from "./room.ts";
import { SENTENCES } from "./sentences.ts";

interface CliArm {
  readonly id: string;
  readonly model: string;
  readonly effort: string | null;
  readonly env: Readonly<Record<string, string>>;
  /** Claude Code's own tools on top of the room's (web search). */
  readonly builtins: string;
  /** Thinking off, as `TessayaOneShot` runs it: the CLI's equivalent of the API's `between_tools`. */
  readonly noThinking?: boolean;
}

const CLI_ARMS: ReadonlyArray<CliArm> = [
  {
    id: "cli-haiku",
    model: "haiku",
    effort: null,
    env: { ENABLE_TOOL_SEARCH: "false" },
    builtins: "",
  },
  {
    id: "cli-sonnet-low",
    model: "sonnet",
    effort: "low",
    env: { ENABLE_TOOL_SEARCH: "false" },
    builtins: "",
  },
  {
    id: "cli-sonnet-low-deferred",
    model: "sonnet",
    effort: "low",
    env: { ENABLE_TOOL_SEARCH: "true" },
    builtins: "",
  },
  {
    id: "cli-sonnet-low-nothink",
    model: "sonnet",
    effort: "low",
    env: { ENABLE_TOOL_SEARCH: "false" },
    builtins: "",
    noThinking: true,
  },
  {
    id: "cli-sonnet-low-nothink-deferred",
    model: "sonnet",
    effort: "low",
    env: { ENABLE_TOOL_SEARCH: "true" },
    builtins: "",
    noThinking: true,
  },
  {
    id: "cli-sonnet-low-web",
    model: "sonnet",
    effort: "low",
    env: { ENABLE_TOOL_SEARCH: "false" },
    builtins: "WebSearch,WebFetch",
  },
];

const { values: flags } = NodeUtil.parseArgs({
  options: {
    arm: { type: "string", multiple: true },
    reps: { type: "string", default: "2" },
    recycle: { type: "string", default: "20" },
    out: { type: "string" },
    limit: { type: "string" },
    sentence: { type: "string", multiple: true },
    claude: { type: "string", default: "claude" },
  },
});
if (flags.out === undefined) throw new Error("Pass --out runs/<name>.");
const arms = CLI_ARMS.filter((a) =>
  (flags.arm ?? CLI_ARMS.slice(0, 3).map((x) => x.id)).includes(a.id),
);
const sentences =
  flags.sentence ?? SENTENCES.slice(0, flags.limit === undefined ? undefined : Number(flags.limit));
const PREFIX = "mcp__room__";

const mcp = await startTessayaMcp({
  tools: [...ROOM_TOOL_SPECS, LOOK].map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.input_schema as Record<string, unknown>,
    run: async () => ({ text: "(test house: nothing found and nothing changed)" }),
  })),
  gate: async () => ({ allow: true }),
});
const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "tessaya-brain-"));
const config = NodePath.join(dir, "mcp.json");
NodeFS.writeFileSync(
  config,
  JSON.stringify({
    mcpServers: {
      room: { type: "http", url: mcp.url, headers: { Authorization: `Bearer ${mcp.token}` } },
    },
  }),
);

/** The subscription, never a metered key: the same rule as the desktop's `subscriptionEnv`. */
const METERED =
  /^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL|CLAUDE_CODE_USE_BEDROCK|CLAUDE_CODE_USE_VERTEX)$/;

interface Session {
  readonly send: (text: string) => Promise<TurnTiming>;
  readonly close: () => void;
  readonly dead: () => boolean;
  used: number;
}

interface TurnTiming {
  readonly firstActMs: number | null;
  readonly firstTextMs: number | null;
  readonly ms: number;
  readonly tools: ReadonlyArray<string>;
  readonly reply: string;
  readonly ok: boolean;
}

const start = (arm: CliArm): Session => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !METERED.test(k)));
  const child = NodeChildProcess.spawn(
    flags.claude!,
    [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose",
      "--model",
      arm.model,
      ...(arm.effort === null ? [] : ["--effort", arm.effort]),
      "--system-prompt",
      ROOM_SYSTEM,
      "--mcp-config",
      config,
      "--strict-mcp-config",
      "--tools",
      arm.builtins,
      "--allowedTools",
      [`${PREFIX}*`, ...arm.builtins.split(",").filter(Boolean)].join(","),
      "--setting-sources",
      "",
      ...(arm.noThinking === true
        ? ["--settings", JSON.stringify({ alwaysThinkingEnabled: false })]
        : []),
      "--no-session-persistence",
    ],
    {
      cwd: dir,
      env: { ...env, ...arm.env, CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1" },
      stdio: ["pipe", "pipe", "ignore"],
    },
  );
  let waiting: ((line: Record<string, any>) => void) | null = null;
  // A CLI update can remove the binary mid-run: the session dies, its turn fails, and the pool replaces it.
  let dead = false;
  const die = () => {
    dead = true;
    waiting?.({ type: "result", is_error: true });
  };
  child.on("error", die);
  child.on("exit", die);
  child.stdin.on("error", die);
  NodeReadline.createInterface({ input: child.stdout }).on("line", (line) => {
    try {
      waiting?.(JSON.parse(line) as Record<string, any>);
    } catch {
      // A line that is not JSON is not part of a turn.
    }
  });
  const session: Session = {
    used: 0,
    close: () => child.kill(),
    dead: () => dead,
    send: (text) =>
      new Promise((resolve) => {
        if (dead)
          return resolve({
            firstActMs: null,
            firstTextMs: null,
            ms: 0,
            tools: [],
            reply: "",
            ok: false,
          });
        const started = performance.now();
        let firstActMs: number | null = null;
        let firstTextMs: number | null = null;
        const tools: Array<string> = [];
        waiting = (event) => {
          const at = performance.now() - started;
          if (event["type"] === "stream_event") {
            const e = event["event"];
            if (e.type === "content_block_start" && e.content_block?.type === "tool_use") {
              firstActMs ??= at;
              tools.push(String(e.content_block.name).replace(PREFIX, ""));
            }
            if (e.type === "content_block_delta" && e.delta?.type === "text_delta") {
              firstActMs ??= at;
              firstTextMs ??= at;
            }
          } else if (event["type"] === "result") {
            waiting = null;
            resolve({
              firstActMs,
              firstTextMs,
              ms: at,
              tools,
              reply: String(event["result"] ?? ""),
              ok: event["is_error"] !== true,
            });
          }
        };
        child.stdin.write(
          `${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`,
        );
      }),
  };
  return session;
};

const out = NodePath.resolve(flags.out);
NodeFS.mkdirSync(out, { recursive: true });
const log = NodeFS.createWriteStream(NodePath.join(out, "turns.ndjson"), { flags: "a" });
const rows: Array<TurnTiming & { arm: string; said: string; fresh: boolean }> = [];
const recycle = Number(flags.recycle);

// Each arm keeps one warm session and the next one already started, as a pool slot would.
const pool = new Map(arms.map((arm) => [arm.id, { now: start(arm), next: start(arm) }]));
// One untimed turn per session first: a pool warms a session before a vessel needs it.
for (const arm of arms) {
  const slot = pool.get(arm.id)!;
  await slot.now.send(roomUser("hello"));
  await slot.next.send(roomUser("hello"));
}

for (let rep = 0; rep < Number(flags.reps); rep += 1)
  for (const said of sentences)
    for (const arm of rep % 2 === 0 ? arms : [...arms].reverse()) {
      const slot = pool.get(arm.id)!;
      if (slot.now.used >= recycle || slot.now.dead()) {
        slot.now.close();
        slot.now = slot.next;
        slot.next = start(arm);
        void slot.next.send(roomUser("hello"));
      }
      const fresh = slot.now.used === 0;
      slot.now.used += 1;
      const row = { arm: arm.id, said, fresh, ...(await slot.now.send(roomUser(said))) };
      rows.push(row);
      log.write(`${JSON.stringify(row)}\n`);
    }

for (const slot of pool.values()) {
  slot.now.close();
  slot.next.close();
}
await mcp.close();
NodeFS.rmSync(dir, { recursive: true, force: true });

const summary = arms.map((arm) => {
  const mine = rows.filter((r) => r.arm === arm.id && r.ok);
  const of = (pick: (r: (typeof mine)[number]) => number | null) =>
    mine.map(pick).filter((v): v is number => v !== null);
  const oneRound = mine.filter((r) => r.tools.length === 0);
  return {
    arm: arm.id,
    turns: mine.length,
    failed: rows.filter((r) => r.arm === arm.id && !r.ok).length,
    firstAct: {
      p50: percentile(
        of((r) => r.firstActMs),
        0.5,
      ),
      p95: percentile(
        of((r) => r.firstActMs),
        0.95,
      ),
    },
    firstText: {
      p50: percentile(
        of((r) => r.firstTextMs),
        0.5,
      ),
      p95: percentile(
        of((r) => r.firstTextMs),
        0.95,
      ),
    },
    firstTextNoTools: {
      n: oneRound.length,
      p50: percentile(
        of((r) => (r.tools.length === 0 ? r.firstTextMs : null)),
        0.5,
      ),
      p95: percentile(
        of((r) => (r.tools.length === 0 ? r.firstTextMs : null)),
        0.95,
      ),
    },
    whole: {
      p50: percentile(
        of((r) => r.ms),
        0.5,
      ),
      p95: percentile(
        of((r) => r.ms),
        0.95,
      ),
    },
    toolShare:
      Math.round((100 * mine.filter((r) => r.tools.length > 0).length) / Math.max(1, mine.length)) /
      100,
  };
});
NodeFS.writeFileSync(NodePath.join(out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
process.exit(0);
