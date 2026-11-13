// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalConsole:off globalFetch:off
/**
 * The room's tool suite on a running server: every room tool, driven by his kind of sentence as a pretend R1
 * (`replay-suite`), through the server's real brain, tools and house. The house's writes and asks to his phone are dry
 * runs on the server (HomeActor.dryRun); reads are live. No imports beyond its cases, so a deploy runs it with plain
 * node; run.test.ts fails a room tool with no case. `--vessel desktop` loads desktop.ts instead. See README.md.
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
    // r1 (default): the pretend R1 through the server's brain. desktop: his desktop's Tessaya (desktop.ts), a
    // `claude -p` on your own login; an eval to run nightly or on demand, not the deploy gate.
    vessel: { type: "string", default: "r1" },
    claude: { type: "string", default: "claude" },
    model: { type: "string" },
  },
});
if (values.vessel !== "r1" && values.vessel !== "desktop") throw new Error("--vessel r1|desktop");
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
const discover = async (
  slots: ReadonlyArray<Slot>,
  find: (domain: string) => Promise<ReadonlyArray<LiveCall>>,
): Promise<House> => {
  const house: Partial<Record<Slot, Device>> = {};
  for (const slot of slots) {
    const domain = SLOT_DOMAIN[slot];
    const calls = await find(domain);
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
/** One case's sentences through the vessel under test: replies, the trace of its tool calls, and each turn's time. */
type Say = (sentences: ReadonlyArray<string>) => Promise<{
  replies: ReadonlyArray<string>;
  calls: ReadonlyArray<LiveCall>;
  ms: ReadonlyArray<number>;
}>;
const r1Say: Say = async (sentences) => {
  const history: Array<{ role: string; content: string }> = [];
  const replies: Array<string> = [];
  const calls: Array<LiveCall> = [];
  const ms: Array<number> = [];
  for (const sentence of sentences) {
    history.push({ role: "user", content: sentence });
    const t = await turn(history);
    replies.push(t.reply);
    calls.push(...t.calls);
    ms.push(t.ms);
    history.push({ role: "assistant", content: t.reply });
  }
  return { replies, calls, ms };
};
const desktop =
  values.vessel === "desktop"
    ? await (
        await import("./desktop.ts")
      ).desktopVessel({ server: values.server, key, claude: values.claude, model: values.model })
    : null;
const say: Say = desktop?.say ?? r1Say;
const house = await discover([...new Set(cases.flatMap(slotsOf))], async (domain) => {
  if (desktop !== null) {
    // Found directly: the house is the same whichever vessel asks, and this costs no model turn.
    const text = await desktop.call("home_find", { domain, limit: 50 }).catch(() => "[]");
    return [{ name: "home_find", input: { domain }, isError: false, text }];
  }
  return (
    await turn([
      {
        role: "user",
        content: `Look up my ${domain.replace("_", " ")}s with home_find (domain ${domain}); just list their names.`,
      },
    ])
  ).calls;
});
const rows = [];
for (const c of cases) {
  const need = slotsOf(c).filter((s) => house[s] === undefined);
  if (need.length > 0) {
    rows.push({ id: c.id, proves: c.proves, result: "n/a", why: `no ${need.join(", ")} here` });
    console.log(`n/a   ${c.id}: no ${need.join(", ")} in this house`);
    continue;
  }
  // A case only the R1's own tools, or the desktop's own refused ones, could pass does not apply to this vessel.
  const offered = desktop?.offered;
  if (offered !== undefined && !c.uses.every((group) => group.some((t) => offered.has(t)))) {
    rows.push({ id: c.id, proves: c.proves, result: "n/a", why: "not a tool of this vessel" });
    console.log(`n/a   ${c.id}: not a tool of the ${values.vessel}`);
    continue;
  }
  let replies: ReadonlyArray<string> = [];
  let calls: ReadonlyArray<LiveCall> = [];
  let ms: ReadonlyArray<number> = [];
  let why: string | null;
  try {
    ({ replies, calls, ms } = await say(c.said.map((sentence) => fill(sentence, house))));
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
