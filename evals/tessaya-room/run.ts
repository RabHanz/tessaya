#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalConsole:off
/**
 * The R1 desk device's turn as it ships, on a fake house: the room's real prompt and data, and either brain.
 * `--brain tools` is the key route (ROOM_SYSTEM, the room's real tool specs on an MCP server); `--brain acts` is the
 * acts form the subscription route still speaks (R1_STREAM_SYSTEM, no tools; the key route spoke it too before tools).
 * Both run on a real `claude -p` on your own login. Tools answer from a fake house and canned reads; nothing real runs.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { startBatonMcp } from "../../apps/desktop/src/baton/agent/batonMcp.ts";
import { toolUsesOf } from "../../apps/desktop/src/baton/screen/claudeVision.ts";
import {
  calledPersona,
  LOOK,
  R1_STREAM_SYSTEM,
  r1Data,
  ROOM_SYSTEM,
  roomData,
  splitActs,
  spokenReply,
  withoutNarration,
  withoutSelfIntros,
  type ActOutcome,
  type R1Context,
} from "../../apps/server/src/home/R1Device.ts";
import { volumeAfter, volumeLine } from "../../packages/baton-shared/src/speakingVolume.ts";
import { ROOM_TOOL_SPECS } from "../../apps/server/src/home/R1Tools.ts";
import { DEFAULT_OS_PACK, rosterLine } from "../../packages/baton-shared/src/osPack.ts";
import { roomCases, type RoomCase } from "./cases.ts";
import { casePasses, failureOf, type RoomSample } from "./grade.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    out: { type: "string" },
    model: { type: "string", default: "haiku" },
    brain: { type: "string", default: "tools" },
    case: { type: "string", multiple: true },
    samples: { type: "string", default: "2" },
    claude: { type: "string", default: "claude" },
  },
});
if (values.out === undefined) throw new Error("Use --out <directory>.");
if (values.brain !== "tools" && values.brain !== "acts") throw new Error("--brain tools|acts");
const out = values.out;
const cases = roomCases.filter((c) => values.case === undefined || values.case.includes(c.id));
const PREFIX = "mcp__room__";
const PICTURE = NodeFS.readFileSync(
  NodePath.join(import.meta.dirname, "fixtures", "red-circle.jpg"),
).toString("base64");

/** A small house: the study lamp (off), the study fan (on), the front door lock. Risky acts go to his phone. */
const makeHouse = () => {
  const states = new Map([
    ["light.study_lamp", { name: "Study lamp", area: "Study", state: "off" }],
    ["fan.study", { name: "Study fan", area: "Study", state: "on" }],
    ["lock.front", { name: "Front door", area: "Hall", state: "locked" }],
  ]);
  let last: { entities: ReadonlyArray<string>; undoId: string; line: string } | null = null;
  let undo: Map<string, string> = new Map();
  const view = (id: string) => ({ entityId: id, ...states.get(id)! });
  const find = (words: string) =>
    [...states.keys()]
      .filter((id) =>
        words
          .toLowerCase()
          .split(/\W+/)
          .filter((w) => w.length > 2)
          .some((w) => `${id} ${states.get(id)!.name}`.toLowerCase().includes(w)),
      )
      .map(view);
  const act = (args: Record<string, unknown>) => {
    const target = (args["target"] ?? {}) as { entity_id?: unknown };
    const ids = [target.entity_id]
      .flat()
      .map(String)
      .filter((id) => states.has(id));
    if (ids.length === 0) return { ok: false, error: "No such device." };
    if (args["domain"] === "lock")
      return {
        ok: true,
        value: {
          status: "asked",
          line: "Sent to his phone for a yes; nothing happens until he says yes.",
        },
      };
    const to = String(args["service"]).endsWith("_off") ? "off" : "on";
    undo = new Map(ids.map((id) => [id, states.get(id)!.state]));
    for (const id of ids) states.get(id)!.state = to;
    const line = `${ids.map((id) => states.get(id)!.name).join(", ")} turned ${to}`;
    last = { entities: ids, undoId: "u1", line };
    return { ok: true, value: { status: "done", line, undoId: "u1" } };
  };
  return {
    lamp: () => states.get("light.study_lamp")!.state as "on" | "off",
    last: () => last,
    find,
    state: (id: string) => (states.has(id) ? view(id) : null),
    act,
    undo: () => {
      for (const [id, s] of undo) states.get(id)!.state = s;
      return { ok: true, value: { status: "done", line: "Undone." } };
    },
  };
};

/** What his work reads return: canned, from a made-up project. */
const WORK = {
  tessaya_in_flight: {
    turns: [{ session: "acme/app", title: "checkout refactor", agent: "Codex", minutes: 14 }],
  },
  tessaya_team_board: {
    rows: [{ project: "acme/app", job: "checkout refactor", state: "working", by: "Codex" }],
  },
  tessaya_sessions: { sessions: [{ title: "checkout refactor", folder: "/home/user/acme/app" }] },
} as Record<string, unknown>;

type House = ReturnType<typeof makeHouse>;

/** Each case's R1 starts at the firmware's 0 dB. */
const volumes = new WeakMap<House, number>();

const runTool = (house: House, name: string, args: Record<string, unknown>) => {
  switch (name) {
    case "home_find":
      return { ok: true, value: house.find(String(args["text"] ?? args["area"] ?? "")) };
    case "home_state": {
      const s = house.state(String(args["entityId"] ?? ""));
      return s === null ? { ok: false, error: "No such device." } : { ok: true, value: s };
    }
    case "home_do":
      return house.act(args);
    case "home_undo":
      return house.undo();
    case "set_device_volume": {
      const before = volumes.get(house) ?? 71;
      const to = args["to"];
      const after = volumeAfter(
        before,
        typeof to === "number" || to === "up" || to === "down" || to === "max" || to === "default"
          ? to
          : before,
        71,
      );
      volumes.set(house, after);
      return { ok: true, value: volumeLine(before, after) };
    }
    case "laptop_ask":
      return { ok: false, error: "your laptop isn't linked to this server, so I can't see it." };
    default:
      return WORK[name] ?? { ok: true, value: [] };
  }
};

const context = (
  c: RoomCase,
  house: House,
  heard: string,
  history: ReadonlyArray<{ role: string; content: string }>,
  withHouse: boolean,
  turn: number,
): R1Context => ({
  heard,
  privateBlock: "",
  // As r1Gather sends it: her past replies without a self-introduction.
  history: withoutSelfIntros(
    history,
    DEFAULT_OS_PACK.personas.map((p) => p.name),
  ),
  devices: withHouse
    ? [
        ...house.find(heard),
        ...(house.last()?.entities ?? [])
          .filter((id) => !house.find(heard).some((d) => d.entityId === id))
          .map((id) => house.state(id)),
      ]
    : [],
  lastAction: house.last(),
  automations: null,
  memory: "",
  preferences: {},
  voice:
    c.verified === true
      ? { speaker: { kind: "owner", personId: "owner", verified: true, inherited: false } }
      : undefined,
  now: "Thursday, 12 November 2026 at 10:15 (Asia/Karachi)",
  // He names the persona on the first sentence; the loop keeps it and says `switched` on that turn only.
  persona: c.persona === undefined ? null : calledPersona(DEFAULT_OS_PACK, { persona: c.persona }),
  switched: c.persona !== undefined && turn === 0,
  roster: rosterLine(DEFAULT_OS_PACK.personas, c.persona ?? ""),
});

const claude = (args: ReadonlyArray<string>, cwd: string) =>
  new Promise<{ lines: ReadonlyArray<string>; firstMs: number | null }>((resolve, reject) => {
    const started = Date.now();
    let firstMs: number | null = null;
    const child = NodeChildProcess.spawn(
      values.claude!,
      [
        "-p",
        ...args,
        "--output-format",
        "stream-json",
        "--include-partial-messages",
        "--verbose",
        "--model",
        values.model!,
        "--setting-sources",
        "",
        "--no-session-persistence",
      ],
      { cwd, stdio: ["ignore", "pipe", "ignore"] },
    );
    let text = "";
    child.stdout.on("data", (chunk: Buffer) => {
      text += chunk.toString();
      if (firstMs === null && text.includes('"text_delta"')) firstMs = Date.now() - started;
    });
    child.on("error", reject);
    child.on("close", () => resolve({ lines: text.split("\n"), firstMs }));
  });

const resultOf = (lines: ReadonlyArray<string>): string =>
  lines
    .map((line) => {
      try {
        return JSON.parse(line) as { type?: string; result?: string };
      } catch {
        return {};
      }
    })
    .find((event) => event.type === "result")?.result ?? "";

const sample = async (c: RoomCase): Promise<RoomSample> => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "tessaya-room-"));
  const house = makeHouse();
  const calls: Array<string> = [];
  const replies: Array<string> = [];
  const lamp: Array<"on" | "off"> = [];
  const firstMs: Array<number | null> = [];
  const history: Array<{ role: string; content: string }> = [];
  const mcp =
    values.brain === "tools"
      ? await startBatonMcp({
          tools: [...ROOM_TOOL_SPECS, LOOK].map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.input_schema as Record<string, unknown>,
            run: async (args) =>
              tool.name === LOOK.name
                ? {
                    text: "The picture the camera just took.",
                    images: [{ data: PICTURE, mimeType: "image/jpeg" }],
                  }
                : { text: JSON.stringify(runTool(house, tool.name, { ...args })) },
          })),
          gate: async () => ({ allow: true }),
        })
      : null;
  const config = NodePath.join(dir, "mcp.json");
  if (mcp !== null)
    NodeFS.writeFileSync(
      config,
      JSON.stringify({
        mcpServers: {
          room: { type: "http", url: mcp.url, headers: { Authorization: `Bearer ${mcp.token}` } },
        },
      }),
    );
  try {
    for (const [turn, heard] of c.said.entries()) {
      let reply: string;
      if (mcp !== null) {
        const ran = await claude(
          [
            roomData(context(c, house, heard, history, true, turn)),
            "--system-prompt",
            ROOM_SYSTEM,
            "--mcp-config",
            config,
            "--strict-mcp-config",
            "--tools",
            "",
            "--allowedTools",
            `${PREFIX}*`,
          ],
          dir,
        );
        calls.push(...ran.lines.flatMap(toolUsesOf).map((u) => u.tool.replace(PREFIX, "")));
        reply = withoutNarration(
          resultOf(ran.lines),
          DEFAULT_OS_PACK.personas.map((p) => p.name),
        );
        firstMs.push(ran.firstMs);
      } else {
        const ran = await claude(
          [
            r1Data(context(c, house, heard, history, true, turn)).join("\n"),
            "--system-prompt",
            R1_STREAM_SYSTEM,
            "--tools",
            "",
          ],
          dir,
        );
        const final = splitActs(resultOf(ran.lines)) ?? { acts: [], rest: "" };
        const outcomes: Array<ActOutcome> = final.acts.map((a) => {
          calls.push(a.tool);
          const r = runTool(house, a.tool, { ...a.args }) as {
            ok: boolean;
            value?: { status?: string; line?: string };
            error?: string;
          };
          return {
            ok: r.ok,
            status: r.value?.status ?? (r.ok ? "done" : "failed"),
            line: r.ok ? (r.value?.line ?? "") : (r.error ?? ""),
          };
        });
        reply = spokenReply(
          withoutNarration(
            final.rest,
            DEFAULT_OS_PACK.personas.map((p) => p.name),
          ),
          outcomes,
        );
        firstMs.push(ran.firstMs);
      }
      replies.push(reply);
      lamp.push(house.lamp());
      history.push({ role: "user", content: heard }, { role: "assistant", content: reply });
    }
    return { replies, calls, lamp, firstMs };
  } finally {
    await mcp?.close();
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
};

NodeFS.mkdirSync(out, { recursive: true });
const rows = [];
for (const c of cases) {
  const runs: Array<RoomSample> = [];
  for (let i = 0; i < Number(values.samples); i += 1)
    runs.push(
      await sample(c).catch(() => ({ replies: [], calls: ["error"], lamp: [], firstMs: [] })),
    );
  const pass = casePasses(c, runs);
  rows.push({
    id: c.id,
    pass,
    failures: runs.map((s) => failureOf(c, s)),
    calls: runs.map((s) => s.calls),
    replies: runs.map((s) => s.replies),
    firstMs: runs.map((s) => s.firstMs),
  });
  console.log(
    `${pass ? "pass" : "FAIL"}  ${c.id}: ${runs.map((s) => failureOf(c, s) ?? "ok").join(" | ")}`,
  );
}
const first = rows
  .flatMap((r) => r.firstMs.flat())
  .filter((ms): ms is number => ms !== null)
  .toSorted((a, b) => a - b);
NodeFS.writeFileSync(NodePath.join(out, "results.json"), JSON.stringify(rows, null, 2));
console.log(
  `${rows.filter((r) => r.pass).length} of ${rows.length} pass (brain ${values.brain}, ${values.model}); median first word ${first[Math.floor(first.length / 2)] ?? "n/a"} ms`,
);
