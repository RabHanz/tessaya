// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalConsole:off globalFetch:off
/**
 * The room's tool suite on a running server: every room tool, driven by his kind of sentence as a pretend R1
 * (`replay-suite`), through the server's real brain, tools and house. The house's writes and asks to his phone are dry
 * runs on the server (HomeActor.dryRun); reads are live. No imports beyond its cases, so a deploy runs it with plain
 * node; run.test.ts fails a room tool with no case. `--vessel desktop` loads desktop.ts instead. See README.md.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeUtil from "node:util";

import {
  fill,
  hasDevices,
  HELD,
  liveCases,
  liveFailureOf,
  slotsOf,
  SLOT_DOMAIN,
  type Device,
  type House,
  type LiveCall,
  type Slot,
  unheldFailure,
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
    // The build's database (read only): which models answered each sample, from its usage rows.
    db: { type: "string" },
  },
});
const usage =
  values.db === undefined ? null : new NodeSqlite.DatabaseSync(values.db, { readOnly: true });
let usageSeen = 0;
/** The models her voice turns used since the last call, in order. */
const modelsSince = (): ReadonlyArray<string> => {
  if (usage === null) return [];
  const rows = usage
    .prepare(
      "SELECT id, model FROM tessaya_brain_usage WHERE id > ? AND role IN ('voice', 'deep') ORDER BY id",
    )
    .all(usageSeen) as Array<{ id: number; model: string }>;
  usageSeen = rows.at(-1)?.id ?? usageSeen;
  return rows.map((r) => r.model);
};
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
const turn = async (
  history: ReadonlyArray<{ role: string; content: string }>,
  voice?: Readonly<Record<string, unknown>>,
): Promise<Turn> => {
  const started = Date.now();
  const response = await fetch(`${values.server}/api/devices/r1/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      messages: history,
      stream: true,
      device: "replay-suite",
      trace: true,
      ...(voice === undefined ? {} : { tessaya: voice }),
    }),
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
type Say = (
  sentences: ReadonlyArray<string>,
  voices?: ReadonlyArray<Readonly<Record<string, unknown>> | undefined>,
) => Promise<{
  replies: ReadonlyArray<string>;
  calls: ReadonlyArray<LiveCall>;
  ms: ReadonlyArray<number>;
}>;
const r1Say: Say = async (sentences, voices) => {
  const history: Array<{ role: string; content: string }> = [];
  const replies: Array<string> = [];
  const calls: Array<LiveCall> = [];
  const ms: Array<number> = [];
  for (const [i, sentence] of sentences.entries()) {
    history.push({ role: "user", content: sentence });
    const t = await turn(history, voices?.[i]);
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
// The server answers once its house has connected or failed and his work was read once: no case runs cold.
const ready = await fetch(`${values.server}/api/devices/r1/v1/ready`, {
  headers: { authorization: `Bearer ${key}` },
});
if (!ready.ok) throw new Error(`The server is not ready: ${ready.status} ${await ready.text()}`);
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
// The device cases need a device in the registry (a scratch copy keeps none, so they do not apply there).
const devicesHere = !cases.some((c) => c.device === true)
  ? false
  : desktop !== null
    ? hasDevices(await desktop.call("device_registry", {}).catch(() => "{}"))
    : (
        await turn([
          { role: "user", content: "List my devices with device_registry; just their names." },
        ])
      ).calls.some((c) => c.name === "device_registry" && !c.isError && hasDevices(c.text));
/** The loop's answers to the act her server held, over its HTTP door: why the case fails, or null. */
const stepUpFailure = async (
  answers: (typeof cases)[number]["stepUps"],
  calls: ReadonlyArray<LiveCall>,
): Promise<string | null> => {
  if (answers === undefined) return null;
  const act = calls.map((x) => HELD.exec(x.text)?.[1]).find((a) => a !== undefined);
  if (act === undefined) return "no act was held";
  for (const a of answers) {
    const response = await fetch(`${values.server}/api/devices/r1/v1/voice/stepup`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ device: a.device ?? "replay-suite", act, ok: a.ok, how: a.how }),
      signal: AbortSignal.timeout(30_000),
    });
    const { ran } = (await response.json()) as { ran?: boolean };
    if (ran !== a.ran)
      return `step-up ${a.how} from ${a.device ?? "its R1"}: ${ran === true ? "ran" : "did not run"}`;
  }
  return null;
};
const rows = [];
/** Samples a failing case gets in all (the first included). */
const SAMPLES_ON_FAIL = 3;

for (const c of cases) {
  const need = slotsOf(c).filter((s) => house[s] === undefined);
  if (need.length > 0) {
    rows.push({ id: c.id, proves: c.proves, result: "n/a", why: `no ${need.join(", ")} here` });
    console.log(`n/a   ${c.id}: no ${need.join(", ")} in this house`);
    continue;
  }
  if (c.device === true && !devicesHere) {
    rows.push({ id: c.id, proves: c.proves, result: "n/a", why: "no device registered here" });
    console.log(`n/a   ${c.id}: no device registered on this server`);
    continue;
  }
  // A case only the R1's own tools, or the desktop's own refused ones, could pass does not apply to this vessel.
  const offered = desktop?.offered;
  if (offered !== undefined && !c.uses.every((group) => group.some((t) => offered.has(t)))) {
    rows.push({ id: c.id, proves: c.proves, result: "n/a", why: "not a tool of this vessel" });
    console.log(`n/a   ${c.id}: not a tool of the ${values.vessel}`);
    continue;
  }
  // The loop's voice envelope and its step-up answers are the R1's; the desktop judges its own voice.
  if (desktop !== null && (c.voices !== undefined || c.stepUps !== undefined)) {
    rows.push({ id: c.id, proves: c.proves, result: "n/a", why: "the R1 loop's voice" });
    console.log(`n/a   ${c.id}: the R1 loop's voice`);
    continue;
  }
  /** One sample of the case: its verdict, or null when it turned out not to apply here. */
  const sample = async () => {
    let replies: ReadonlyArray<string> = [];
    let calls: ReadonlyArray<LiveCall> = [];
    let ms: ReadonlyArray<number> = [];
    let why: string | null;
    modelsSince();
    try {
      ({ replies, calls, ms } = await say(
        c.said.map((sentence) => fill(sentence, house)),
        c.voices,
      ));
      const nothing = c.nothingToActOn?.(calls) ?? null;
      if (nothing !== null) return { na: nothing };
      // Nothing is held where no member has a voice yet (Voice ID can't tell anyone apart): not applicable there.
      const unheld = c.stepUps !== undefined && !calls.some((x) => HELD.test(x.text));
      const broke = unheld ? unheldFailure(c, calls) : null;
      if (unheld && broke === null) return { na: "no member has a voice on this server" };
      why =
        broke ?? liveFailureOf(c, house, replies, calls) ?? (await stepUpFailure(c.stepUps, calls));
    } catch (error) {
      why = `the turn failed: ${String(error)}`;
    }
    return { why, replies, calls, ms, models: modelsSince() };
  };
  // Model output varies (evals/README.md): a failed case gets two more samples and fails when half or more fail.
  const first = await sample();
  if ("na" in first) {
    rows.push({ id: c.id, proves: c.proves, result: "n/a", why: first.na });
    console.log(`n/a   ${c.id}: ${first.na}`);
    continue;
  }
  const samples = [first];
  // Words said twice are the product's, never the model's luck: no more samples for them.
  while (first.why !== null && !first.why.startsWith("said ") && samples.length < SAMPLES_ON_FAIL) {
    const more = await sample();
    if (!("na" in more)) samples.push(more);
    else break;
  }
  const failures = samples.filter((x) => x.why !== null);
  const shown =
    failures.length * 2 >= samples.length ? failures[0]! : samples.find((x) => x.why === null)!;
  const { replies, calls, ms } = shown;
  const models = samples.map((x) => ("models" in x ? x.models : []));
  const why = shown.why;
  const flaky =
    samples.length > 1 ? ` (${failures.length} of ${samples.length} samples failed)` : "";
  rows.push({
    id: c.id,
    proves: c.proves,
    result: why === null ? "pass" : "FAIL",
    why: why === null ? (flaky === "" ? null : `passed${flaky}`) : `${why}${flaky}`,
    said: c.said.map((s) => fill(s, house)),
    replies,
    calls,
    ms,
    ...(usage === null ? {} : { models }),
  });
  console.log(
    `${why === null ? "pass" : "FAIL"}  ${c.id}${flaky}: ${why ?? replies.at(-1)?.slice(0, 100)}`,
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
