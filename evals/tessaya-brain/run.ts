// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalFetch:off
/**
 * B0 (tessaya-ops research/BRAIN-DESIGN.md §6): how fast each brain starts speaking on the device's real prompt and
 * tools. Every sentence goes through the device's tool loop as `R1Brain.toolLoop` runs it (up to 4 rounds, the last
 * one words only), with canned tool results, so "first text" is the room's `brainFirstMs`. Arms alternate sentence by
 * sentence, so a slow minute at the API hurts every arm alike.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { LOOK, ROOM_SYSTEM } from "../../apps/server/src/home/R1Device.ts";
import { ROOM_TOOL_SPECS } from "../../apps/server/src/home/R1Tools.ts";
import { ARMS, percentile, stream, type Arm, type Round } from "./api.ts";
import { roomUser } from "./room.ts";
import { SENTENCES } from "./sentences.ts";

const MAX_ROUNDS = 4;

const { values: flags } = NodeUtil.parseArgs({
  options: {
    arm: { type: "string", multiple: true },
    reps: { type: "string", default: "4" },
    out: { type: "string" },
    limit: { type: "string" },
    sentence: { type: "string", multiple: true },
  },
});

const key = process.env["ANTHROPIC_API_KEY"];
if (key === undefined || key === "")
  throw new Error("Set ANTHROPIC_API_KEY (the brain's key) to run this.");
const arms =
  flags.arm === undefined ? ARMS.slice(0, 2) : ARMS.filter((a) => flags.arm!.includes(a.id));
const sentences =
  flags.sentence ?? SENTENCES.slice(0, flags.limit === undefined ? undefined : Number(flags.limit));

const tools = [...ROOM_TOOL_SPECS, LOOK].map((tool, i, all) =>
  // As `converse` sends them: the last tool carries the cache breakpoint for the whole tool list.
  i === all.length - 1 ? { ...tool, cache_control: { type: "ephemeral" } } : tool,
);

interface Turn {
  readonly arm: string;
  readonly said: string;
  readonly rep: number;
  readonly firstActMs: number | null;
  /** The room's `brainFirstMs`: the first word in any round, tool time included. */
  readonly firstTextMs: number | null;
  readonly ms: number;
  readonly rounds: number;
  readonly tools: ReadonlyArray<string>;
  readonly reply: string;
  readonly usage: Round["usage"];
  readonly cost: number;
}

const turn = async (
  arm: Arm,
  heard: string,
  history: ReadonlyArray<{ role: string; content: string }>,
) => {
  const started = performance.now();
  const messages: Array<Record<string, unknown>> = [
    { role: "user", content: roomUser(heard, history) },
  ];
  const used: Array<string> = [];
  const usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  let firstActMs: number | null = null;
  let firstTextMs: number | null = null;
  let reply = "";
  let rounds = 0;
  while (rounds < MAX_ROUNDS) {
    rounds += 1;
    const sentAt = performance.now() - started;
    const round = await stream(key!, {
      model: arm.model,
      max_tokens: 400,
      system: [{ type: "text", text: ROOM_SYSTEM, cache_control: { type: "ephemeral" } }],
      messages,
      tools: [...tools, ...(arm.serverTools ?? [])],
      tool_choice: { type: rounds === MAX_ROUNDS ? "none" : "auto" },
      ...arm.extra,
    });
    usage.input += round.usage.input;
    usage.cacheRead += round.usage.cacheRead;
    usage.cacheWrite += round.usage.cacheWrite;
    usage.output += round.usage.output;
    if (round.firstActMs !== null) firstActMs ??= sentAt + round.firstActMs;
    if (round.firstTextMs !== null) firstTextMs ??= sentAt + round.firstTextMs;
    const calls = round.content.filter((b) => b["type"] === "tool_use");
    reply = round.content
      .filter((b) => b["type"] === "text")
      .map((b) => b["text"] as string)
      .join("");
    if (calls.length === 0) break;
    used.push(...calls.map((c) => c["name"] as string));
    messages.push(
      { role: "assistant", content: round.content },
      {
        role: "user",
        content: calls.map((c) => ({
          type: "tool_result",
          tool_use_id: c["id"],
          content: "(test house: nothing found and nothing changed)",
        })),
      },
    );
  }
  const p = arm.price;
  const cost =
    (usage.input * p.in +
      usage.cacheRead * p.read +
      usage.cacheWrite * p.write +
      usage.output * p.out) /
    1e6;
  return {
    firstActMs,
    firstTextMs,
    ms: performance.now() - started,
    rounds,
    tools: used,
    reply,
    usage,
    cost,
  };
};

if (flags.out === undefined) throw new Error("Pass --out runs/<name>.");
const out = NodePath.resolve(flags.out);
NodeFS.mkdirSync(out, { recursive: true });
const log = NodeFS.createWriteStream(NodePath.join(out, "turns.ndjson"), { flags: "a" });
const turns: Array<Turn> = [];
const reps = Number(flags.reps);

// One untimed turn per arm first: the cache is warm before anything counts, as on a device in use.
for (const arm of arms) await turn(arm, "hello", []);

for (let rep = 0; rep < reps; rep += 1)
  for (const said of sentences)
    for (const arm of rep % 2 === 0 ? arms : [...arms].reverse()) {
      try {
        const t = { arm: arm.id, said, rep, ...(await turn(arm, said, [])) };
        turns.push(t);
        log.write(`${JSON.stringify(t)}\n`);
      } catch (error) {
        console.error(`${arm.id} "${said}": ${String(error)}`);
      }
    }

const summary = arms.map((arm) => {
  const mine = turns.filter((t) => t.arm === arm.id);
  const of = (pick: (t: Turn) => number | null) =>
    mine.map(pick).filter((v): v is number => v !== null);
  const mean = (pick: (t: Turn) => number) =>
    Math.round(mine.reduce((s, t) => s + pick(t), 0) / Math.max(1, mine.length));
  const oneRound = mine.filter((t) => t.rounds === 1);
  return {
    arm: arm.id,
    turns: mine.length,
    firstAct: {
      p50: percentile(
        of((t) => t.firstActMs),
        0.5,
      ),
      p95: percentile(
        of((t) => t.firstActMs),
        0.95,
      ),
    },
    firstText: {
      p50: percentile(
        of((t) => t.firstTextMs),
        0.5,
      ),
      p95: percentile(
        of((t) => t.firstTextMs),
        0.95,
      ),
    },
    firstTextOneRound: {
      n: oneRound.length,
      p50: percentile(
        oneRound.map((t) => t.firstTextMs ?? 0),
        0.5,
      ),
      p95: percentile(
        oneRound.map((t) => t.firstTextMs ?? 0),
        0.95,
      ),
    },
    whole: {
      p50: percentile(
        of((t) => t.ms),
        0.5,
      ),
      p95: percentile(
        of((t) => t.ms),
        0.95,
      ),
    },
    multiRoundShare:
      Math.round((100 * mine.filter((t) => t.rounds > 1).length) / Math.max(1, mine.length)) / 100,
    meanTokens: {
      input: mean((t) => t.usage.input),
      cacheRead: mean((t) => t.usage.cacheRead),
      cacheWrite: mean((t) => t.usage.cacheWrite),
      output: mean((t) => t.usage.output),
    },
    dollarsPerTurn: Number(
      (mine.reduce((s, t) => s + t.cost, 0) / Math.max(1, mine.length)).toFixed(5),
    ),
  };
});
NodeFS.writeFileSync(NodePath.join(out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
