// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalConsole:off globalFetch:off
/**
 * The room's tool suite on a running server: every room tool, driven by his kind of sentence as a pretend R1
 * (`replay-suite`), through the server's real brain, tools and house. The house's writes and asks to his phone are dry
 * runs on the server (HomeActor.dryRun); reads are live. No imports beyond its cases, so a deploy runs it with plain
 * node; run.test.ts fails a room tool with no case. See README.md.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import {
  fill,
  liveCases,
  liveFailureOf,
  slotsOf,
  SLOT_DOMAIN,
  type Device,
  type House,
  type LiveCall,
  type Slot,
} from "./liveCases.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    server: { type: "string", default: "http://127.0.0.1:3773" },
    "key-file": { type: "string" },
    out: { type: "string" },
    case: { type: "string", multiple: true },
    laptop: { type: "boolean", default: false },
  },
});
if (values["key-file"] === undefined || values.out === undefined)
  throw new Error("Use --key-file <the R1 device key, or its r1-device secret> --out <directory>.");
const raw = NodeFS.readFileSync(values["key-file"], "utf8").trim();
const key = raw.startsWith("{")
  ? String((JSON.parse(raw) as { deviceKey: unknown }).deviceKey)
  : raw;

interface Turn {
  readonly reply: string;
  readonly calls: ReadonlyArray<LiveCall>;
  readonly ms: number;
}

/** One turn as the R1 loop sends it, with the replay's trace of tool calls. */
const turn = async (history: ReadonlyArray<{ role: string; content: string }>): Promise<Turn> => {
  const started = Date.now();
  const response = await fetch(`${values.server}/api/devices/r1/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ messages: history, stream: true, device: "replay-suite", trace: true }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
  let reply = "";
  let calls: ReadonlyArray<LiveCall> = [];
  for (const line of (await response.text()).split("\n")) {
    if (!line.startsWith("data: {")) continue;
    const chunk = JSON.parse(line.slice(6)) as {
      object?: string;
      calls?: ReadonlyArray<LiveCall>;
      choices?: ReadonlyArray<{ delta?: { content?: string } }>;
    };
    if (chunk.object === "tessaya.trace") calls = chunk.calls ?? [];
    else reply += chunk.choices?.[0]?.delta?.content ?? "";
  }
  return { reply: reply.trim(), calls, ms: Date.now() - started };
};

/** A device of each kind this house has, found the way she finds one: through home_find. */
const discover = async (slots: ReadonlyArray<Slot>): Promise<House> => {
  const house: Partial<Record<Slot, Device>> = {};
  for (const slot of slots) {
    const domain = SLOT_DOMAIN[slot];
    const { calls } = await turn([
      {
        role: "user",
        content: `Look up my ${domain.replace("_", " ")}s with home_find (domain ${domain}); just list their names.`,
      },
    ]);
    const found = calls
      .filter((c) => c.name === "home_find" && !c.isError)
      .flatMap((c) => {
        try {
          return JSON.parse(c.text) as ReadonlyArray<Device>;
        } catch {
          return [];
        }
      })
      .filter(
        (d) =>
          d.entityId.startsWith(`${domain}.`) &&
          d.state !== "unavailable" &&
          !d.entityId.startsWith("scene.tessaya_undo_"),
      );
    // A name no other device shares, so the sentence is not ambiguous by itself.
    const pick = found.find((d) => found.filter((o) => o.name === d.name).length === 1);
    if (pick !== undefined) house[slot] = pick;
  }
  return house;
};

const cases = liveCases.filter(
  (c) =>
    (values.case === undefined || values.case.includes(c.id)) &&
    (c.laptop !== true || values.laptop === true),
);
const house = await discover([...new Set(cases.flatMap(slotsOf))]);
const rows = [];
for (const c of cases) {
  const need = slotsOf(c).filter((s) => house[s] === undefined);
  if (need.length > 0) {
    rows.push({ id: c.id, proves: c.proves, result: "n/a", why: `no ${need.join(", ")} here` });
    console.log(`n/a   ${c.id}: no ${need.join(", ")} in this house`);
    continue;
  }
  const history: Array<{ role: string; content: string }> = [];
  const replies: Array<string> = [];
  const calls: Array<LiveCall> = [];
  const ms: Array<number> = [];
  let why: string | null;
  try {
    for (const sentence of c.said) {
      history.push({ role: "user", content: fill(sentence, house) });
      const t = await turn(history);
      replies.push(t.reply);
      calls.push(...t.calls);
      ms.push(t.ms);
      history.push({ role: "assistant", content: t.reply });
    }
    why = liveFailureOf(c, house, replies, calls);
  } catch (error) {
    why = `the turn failed: ${String(error)}`;
  }
  rows.push({
    id: c.id,
    proves: c.proves,
    result: why === null ? "pass" : "FAIL",
    why,
    said: c.said.map((s) => fill(s, house)),
    replies,
    calls,
    ms,
  });
  console.log(
    `${why === null ? "pass" : "FAIL"}  ${c.id}: ${why ?? replies.at(-1)?.slice(0, 100)}`,
  );
}
NodeFS.mkdirSync(values.out, { recursive: true });
NodeFS.writeFileSync(
  NodePath.join(values.out, "results.json"),
  JSON.stringify({ house, rows }, null, 2),
);
const failed = rows.filter((r) => r.result === "FAIL");
console.log(
  `${rows.filter((r) => r.result === "pass").length} pass, ${failed.length} fail, ${rows.filter((r) => r.result === "n/a").length} not applicable`,
);
process.exit(failed.length > 0 ? 1 : 0);
