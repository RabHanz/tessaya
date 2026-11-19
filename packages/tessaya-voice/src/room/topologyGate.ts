// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalFetch:off globalTimers:off globalConsole:off
/**
 * The topology gate (scripts/tessaya/room-topology.sh): her turns on a brain server while a pretend Tessel sits on another
 * server's hub, joined by the loop's own bridge. Device writes are real, on the pretend Tessel, so a write that never
 * reaches her hub fails here (18 Nov: "Tumble isn't linked to the server"). Bundled with the loop; exit 0 when all pass.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeUtil from "node:util";

import { connectMqtt } from "@t3tools/tessaya-shared/mqtt";

import { connectBrainBridge } from "./brainBridge.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    brain: { type: "string" },
    hub: { type: "string" },
    "brain-bus-key-file": { type: "string" },
    "hub-bus-key-file": { type: "string" },
    "device-file": { type: "string" },
    // Each server's Tessaya database, read only: where an act's provenance landed.
    "brain-db": { type: "string" },
    "hub-db": { type: "string" },
    out: { type: "string" },
    // A pretend Home Assistant on this port, which the hub's server is set up to reach (room-topology.sh).
    "home-port": { type: "string" },
  },
});
const need = (key: keyof typeof values) => {
  const v = values[key];
  if (typeof v !== "string" || v === "") throw new Error(`--${key} is required`);
  return v;
};
const brainUrl = need("brain");
const hubUrl = need("hub");
const busKey = (file: string) => NodeFS.readFileSync(file).toString("hex");
const brainBus = busKey(need("brain-bus-key-file"));
const hubBus = busKey(need("hub-bus-key-file"));
const device = JSON.parse(NodeFS.readFileSync(need("device-file"), "utf8")) as {
  deviceId: string;
  deviceKey: string;
};
const id = device.deviceId;
const mqttOf = (http: string) =>
  new URL("/api/tessel/mqtt", http.replace(/^http/, "ws")).toString();
const log = (line: string) => process.env["TOPOLOGY_DEBUG"] && console.error(line);
const base = `freya/r1/${id}`;

/** What the pretend Tessel was told, in order. */
const commands: Array<{ readonly tail: string; readonly body: unknown }> = [];
const state = { volume: 30, output: "bt" as "bt" | "speaker" };
const json = (p: Buffer) => {
  try {
    return JSON.parse(String(p)) as Record<string, unknown>;
  } catch {
    return {};
  }
};
/** The audio part of her firmware's manifest (smp-0.3.159), so her settings are hers to change here. */
const MANIFEST = {
  deviceId: id,
  kind: "r1",
  name: "Tessel",
  firmware: "smp-0.3.159",
  schema: 1,
  version: "topology",
  items: [
    {
      id: "audio.volume",
      label: "Volume",
      type: "number",
      unit: "%",
      range: [0, 100],
      access: "read,write",
      safety: "free",
      report: "on-change",
      group: "audio",
      description: "loudness of her voice on the Tessel speaker or the headphones",
    },
    {
      id: "audio.output",
      label: "Output",
      type: "enum",
      values: ["speaker", "bt", "auto"],
      access: "read,write",
      safety: "confirm",
      report: "on-change",
      group: "audio",
      description:
        "where her voice plays: the Tessel speaker, the Bluetooth device, or the Bluetooth device when connected",
    },
    {
      id: "audio.device",
      label: "Bluetooth device",
      type: "string",
      access: "read",
      safety: "free",
      report: "on-change",
      group: "audio",
      description: "the Bluetooth speaker or headphones the Tessel plays to",
    },
  ],
};
const setOutput = (to: "speaker" | "bt") => {
  state.output = to;
  tessel.publish(
    `${base}/state/audio/output`,
    JSON.stringify({ wanted: to, out: to, device: "Soundcore Q20i" }),
    true,
  );
};
const setVolume = (pct: number) => {
  state.volume = pct;
  tessel.publish(`${base}/state/volume`, JSON.stringify({ pct }), true);
};
const report = () => {
  tessel.publish(`${base}/state/manifest`, JSON.stringify(MANIFEST), true);
  tessel.publish(`${base}/state/online`, "1", true);
  setVolume(state.volume);
  setOutput(state.output);
};
/** A plain red square, so a reply that names the colour shows the picture reached the model. */
const RED_SHOT = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAAAAAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAARCABAAEADASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFgEBAQEAAAAAAAAAAAAAAAAAAAUH/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AkwEVpoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/9k=",
  "base64",
);
/** Her picture goes to the server her list names for pictures: her hub's (R1Reach ownProxy). */
const upload = () =>
  fetch(`${new URL("/camera/upload", hubUrl).toString()}?device=${id}`, {
    method: "POST",
    headers: { "content-type": "image/jpeg", "content-length": String(RED_SHOT.length) },
    body: RED_SHOT,
  }).then(
    (r) => log(`camera upload ${r.status}`),
    (e: unknown) => log(`camera upload failed ${String(e)}`),
  );
const tessel = connectMqtt({
  url: mqttOf(hubUrl),
  clientId: id,
  user: id,
  pass: device.deviceKey,
  subscribe: [`${base}/cmd/#`],
  onMessage: (t, p) => {
    const tail = t.slice(base.length + 1);
    const body = json(p);
    commands.push({ tail, body });
    // As the firmware answers: the new reading, retained, and an item write's ack.
    if (tail === "cmd/volume" && typeof body["pct"] === "number") setVolume(body["pct"]);
    if (tail === "cmd/audio/output" && (body["to"] === "speaker" || body["to"] === "bt"))
      setOutput(body["to"]);
    if (tail === "cmd/camera/capture") void upload();
    if (tail.startsWith("cmd/item/")) {
      const item = tail.slice("cmd/item/".length);
      const value = body["value"];
      if (item === "audio.volume" && typeof value === "number") setVolume(value);
      if (item === "audio.output" && (value === "speaker" || value === "bt")) setOutput(value);
      tessel.publish(`${base}/state/item/ack`, JSON.stringify({ cmd: `item/${item}`, ok: true }));
    }
  },
  log,
});
/** The loop's own bus login on her hub: what it publishes there as the loop (its turn metrics). */
const loopOnHub = connectMqtt({
  url: mqttOf(hubUrl),
  clientId: "topology-loop",
  user: "tessaya-bus",
  pass: hubBus,
  // Heard by her hub's server as a room loop (R1Loop): that hub can hear her.
  subscribe: ["freya/r1/+/voice/up"],
  onMessage: () => undefined,
  log,
});
/** The brain's acts the bridge took for her, in order. */
const delivered: Array<string> = [];
const bridge = connectBrainBridge({
  hub: mqttOf(hubUrl),
  hubLogin: { user: "tessaya-bus", pass: hubBus },
  brain: mqttOf(brainUrl),
  brainLogin: { user: "tessaya-bus", pass: brainBus },
  clientSuffix: "topology",
  here: (d) => d === id,
  deliver: (t, p) => delivered.push(`${t.slice(base.length + 1)} ${String(p)}`),
  log,
});
const brainOnly = connectMqtt({
  url: mqttOf(brainUrl),
  clientId: "topology-brain-acts",
  user: "tessaya-bus",
  pass: brainBus,
  subscribe: [],
  onMessage: () => undefined,
  log,
});

/** What the pretend Home Assistant was asked to do: `domain.service entity`. */
const houseCalls: Array<string> = [];
let houseConnected = false;
/**
 * A pretend Home Assistant with one lamp, on the hub's server only (19 Nov 04:40: "the house isn't connected" when the
 * turn's server had no connection of its own). Its websocket API, as HomeAssistantConnection speaks it.
 */
const serveHouse = (port: number) => {
  const lamp = { s: "off", a: { friendly_name: "Desk lamp" } };
  const server = NodeHttp.createServer((_req, res) => res.writeHead(404).end());
  server.on("upgrade", (req, socket) => {
    const accept = NodeCrypto.createHash("sha1")
      .update(`${String(req.headers["sec-websocket-key"])}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    const send = (message: unknown) => {
      const body = Buffer.from(JSON.stringify(message));
      const head =
        body.length < 126
          ? Buffer.from([0x81, body.length])
          : Buffer.from([0x81, 126, body.length >> 8, body.length & 255]);
      socket.write(Buffer.concat([head, body]));
    };
    let entities = -1;
    const onMessage = (m: Record<string, unknown>) => {
      const id = m["id"];
      const ok = (result: unknown) => send({ id, type: "result", success: true, result });
      switch (m["type"]) {
        case "auth":
          return send({ type: "auth_ok", ha_version: "2025.11.0" });
        case "get_config":
          return ok({ version: "2025.11.0", time_zone: "Asia/Karachi" });
        case "config/area_registry/list":
          return ok([{ area_id: "office", name: "Office" }]);
        case "config/entity_registry/list":
          return ok([{ entity_id: "light.desk_lamp", area_id: "office", name: null }]);
        case "get_services":
          return ok({ light: { turn_on: {}, turn_off: {}, toggle: {} } });
        case "subscribe_entities":
          entities = id as number;
          houseConnected = true;
          ok(null);
          return send({ id, type: "event", event: { a: { "light.desk_lamp": lamp } } });
        case "call_service": {
          const target = (m["target"] ?? m["service_data"] ?? {}) as { entity_id?: unknown };
          const entity = [target.entity_id].flat().join(",");
          houseCalls.push(`${String(m["domain"])}.${String(m["service"])} ${entity}`);
          ok({ context: { id: "topology" } });
          const to = m["service"] === "turn_on" ? "on" : m["service"] === "turn_off" ? "off" : null;
          if (to !== null && entity.includes("light.desk_lamp") && entities >= 0) {
            lamp.s = to;
            send({
              id: entities,
              type: "event",
              event: { c: { "light.desk_lamp": { "+": { s: to } } } },
            });
          }
          return;
        }
        default:
          return ok([]);
      }
    };
    // Client frames are masked and small here; one frame per message is all HomeAssistantConnection sends.
    let pending = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 6) {
        const op = pending[0]! & 15;
        let len = pending[1]! & 127;
        let at = 2;
        if (len === 126) {
          len = pending.readUInt16BE(2);
          at = 4;
        } else if (len === 127) {
          len = Number(pending.readBigUInt64BE(2));
          at = 10;
        }
        if (pending.length < at + 4 + len) return;
        const mask = pending.subarray(at, at + 4);
        const body = Buffer.from(pending.subarray(at + 4, at + 4 + len)).map(
          (b, i) => b ^ mask[i % 4]!,
        );
        pending = pending.subarray(at + 4 + len);
        if (op === 8) return socket.end();
        if (op !== 1) continue;
        try {
          const parsed = JSON.parse(body.toString()) as unknown;
          for (const m of [parsed].flat()) onMessage(m as Record<string, unknown>);
        } catch {
          // Not JSON: Home Assistant would drop the connection; the case reports what was not done.
        }
      }
    });
    socket.on("error", () => undefined);
    send({ type: "auth_required", ha_version: "2025.11.0" });
  });
  server.listen(port, "127.0.0.1");
  return server;
};
const house = values["home-port"] === undefined ? null : serveHouse(Number(values["home-port"]));

const until = async (ok: () => boolean, ms: number) => {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
  return ok();
};
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

if (
  !(await until(
    () =>
      tessel.connected() && loopOnHub.connected() && bridge.connected() && brainOnly.connected(),
    20_000,
  ))
) {
  console.error(
    `topology: not connected (tessel ${tessel.connected()}, loop ${loopOnHub.connected()}, bridge ${bridge.connected()}, brain ${brainOnly.connected()})`,
  );
  process.exit(1);
}
report();
// The list she was given, so her hub's server sends her its own (R1Reach) and the case below can read it.
tessel.publish(
  `${base}/state/net/endpoints`,
  JSON.stringify({ broker: [mqttOf(hubUrl)], current: mqttOf(hubUrl) }),
  true,
);
/** One turn's metrics as the loop publishes them on her hub (shape from metrics.ndjson, 18 Nov). */
const metrics = () =>
  loopOnHub.publish(
    `${base}/event/voice/metrics`,
    JSON.stringify({
      at: new Date().toISOString(),
      device: id,
      turn: 1,
      reason: "complete",
      endpointMs: 235,
      asrMs: 504,
      brainFirstMs: 1300,
      ttsFirstMs: 188,
      firstSoundMs: 2200,
      speaker: "unverified",
      speakerScore: 0.2,
      input: {
        verdict: "good",
        cause: "",
        speechDb: -16.2,
        floorDb: -60,
        brightDb: 5.4,
        clipped: 0,
        gapMs: 0,
        herOverlap: 0,
        asr: null,
      },
    }),
  );
metrics();
await settle(2_000);
const startedAt = Date.now();

/** One turn as the loop sends it: her live volume and output with it. */
const turn = async (history: ReadonlyArray<{ role: string; content: string }>) => {
  const words = history.at(-1)!.content;
  const response = await fetch(`${brainUrl}/api/devices/r1/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${device.deviceKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      messages: history,
      stream: true,
      device: id,
      tessaya: {
        vessel: { kind: "device", id },
        origin: "voice",
        addressed: true,
        tz: "Asia/Karachi",
        words,
        volume: state.volume,
        plays: state.output === "bt" ? "bt" : "onboard",
      },
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
  let reply = "";
  for (const line of (await response.text()).split("\n")) {
    if (!line.startsWith("data: {")) continue;
    const chunk = JSON.parse(line.slice(6)) as {
      choices?: ReadonlyArray<{ delta?: { content?: string } }>;
    };
    reply += chunk.choices?.[0]?.delta?.content ?? "";
  }
  return reply.trim();
};

/** A reply that tells him her link is down while she is on her hub and answering (18 Nov 23:07). */
export const FALSE_DOWN =
  /\b(link|connection)\b[^.]{0,40}\b(down|lost|broken)\b|\b(isn't|is not|not|wasn't) linked\b|\b(tessel|tumble|she|it)('s| is) (offline|not connected|unreachable)\b|can't (reach|see) (her|it|tumble|the tessel)|never reached (it|her)/i;
const NO_READINGS =
  /no (recent )?(sound )?readings|haven't (got|heard)|nothing to (measure|go on)|can't tell|not sure/i;

interface TopologyCase {
  readonly id: string;
  readonly said: ReadonlyArray<string>;
  /** Why the case fails, or null; `before` is what the Tessel had been told before the case. */
  readonly check: (replies: ReadonlyArray<string>, before: number) => string | null;
}
const told = (before: number, tail: string) =>
  commands.slice(before).filter((c) => c.tail === tail);
const cases: ReadonlyArray<TopologyCase> = [
  {
    id: "volume-read",
    said: ["What percentage is the volume currently?"],
    check: ([reply]) =>
      !/\b(30|thirty)\b/i.test(reply!)
        ? "did not say her live volume (30%)"
        : /\bas of\b|\bago\b/i.test(reply!)
          ? "said a stale reading"
          : null,
  },
  {
    id: "volume-set",
    said: ["Set your volume to forty percent."],
    check: ([reply], before) =>
      !(
        told(before, "cmd/volume").some((c) => (c.body as { pct?: unknown }).pct === 40) ||
        told(before, "cmd/item/audio.volume").some(
          (c) => (c.body as { value?: unknown }).value === 40,
        )
      )
        ? `the Tessel was never told 40% (${JSON.stringify(told(before, "cmd/volume"))})`
        : /didn't|did not|couldn't|failed/i.test(reply!)
          ? "said it failed"
          : null,
  },
  {
    id: "output-switch",
    // The output is a "confirm" item: she asks first, and his yes sends it.
    said: ["Play your replies on your own speaker, not the headphones.", "Yes, do it."],
    check: (replies, before) =>
      !(
        told(before, "cmd/audio/output").some(
          (c) => (c.body as { to?: unknown }).to === "speaker",
        ) ||
        told(before, "cmd/item/audio.output").some(
          (c) => (c.body as { value?: unknown }).value === "speaker",
        )
      )
        ? `the Tessel was never told to use her speaker (${JSON.stringify(commands.slice(before).map((c) => c.tail))})`
        : /didn't|did not|couldn't|failed/i.test(replies.at(-1)!)
          ? "said it failed"
          : null,
  },
  {
    // Her own camera from his turn: no card, the picture reaches her brain (Director, 19 Nov 05:05).
    id: "camera-no-card",
    said: ["Have a look with your camera. What colour do you see?"],
    check: ([reply], before) =>
      told(before, "cmd/camera/capture").length === 0
        ? `the Tessel was never told to take a picture (${JSON.stringify(commands.slice(before).map((c) => c.tail))})`
        : /\b(phone|approv\w*|card|your yes)\b/i.test(reply!)
          ? "asked for a yes on his phone"
          : !/\bred\b/i.test(reply!)
            ? "did not say what the picture shows (red)"
            : null,
  },
  {
    // The turn's server has no house of its own; the hub's server does, and the brain reaches it as a linked server.
    id: "house-via-linked",
    said: ["Turn on the desk lamp."],
    check: ([reply]) =>
      house === null
        ? null
        : !houseCalls.some((c) => c === "light.turn_on light.desk_lamp")
          ? `the house was never asked to turn the lamp on (${houseCalls.join("; ") || "nothing"}${houseConnected ? "" : "; the hub never connected to it"})`
          : /not connected|isn't connected|can't reach the house|no (house|home assistant)/i.test(
                reply!,
              )
            ? "said the house is not connected"
            : null,
  },
  {
    id: "status",
    said: ["What's your status? Are you connected properly?"],
    check: () => null,
  },
  {
    id: "mic-quality",
    said: ["How good is the mic quality right now?"],
    check: ([reply]) => (NO_READINGS.test(reply!) ? "said she has no mic readings" : null),
  },
];

// The hub retries its house connection with a backoff of up to a minute, from before this gate started.
if (house !== null) await until(() => houseConnected, 70_000);
const rows: Array<Record<string, unknown>> = [];
for (const c of cases) {
  const before = commands.length;
  const history: Array<{ role: string; content: string }> = [];
  const replies: Array<string> = [];
  let why: string | null;
  try {
    for (const sentence of c.said) {
      history.push({ role: "user", content: sentence });
      const reply = await turn(history);
      replies.push(reply);
      history.push({ role: "assistant", content: reply });
    }
    // A command reaches the Tessel over the peer route after the words: give it a moment.
    await settle(1_500);
    const down = replies.find((r) => FALSE_DOWN.test(r));
    why =
      down !== undefined
        ? `said her link is down: "${down.slice(0, 120)}"`
        : c.check(replies, before);
  } catch (error) {
    why = `the turn failed: ${String(error)}`;
  }
  rows.push({ id: c.id, result: why === null ? "pass" : "FAIL", why, said: c.said, replies });
  console.log(
    `${why === null ? "pass" : "FAIL"}  ${c.id}: ${why ?? replies.at(-1)?.slice(0, 100)}`,
  );
}

/** The actions a server recorded since `since`, as the spine keeps them (tessaya_action_events). */
const actionsOn = (file: string | undefined, since: number) => {
  if (file === undefined) return [];
  const db = new NodeSqlite.DatabaseSync(file, { readOnly: true });
  try {
    return db
      .prepare(
        "SELECT kind, origin, actor_kind, actor_id, persona, subject, outcome, cause_json, evidence_json FROM tessaya_action_events WHERE at >= ? ORDER BY at",
      )
      .all(since) as ReadonlyArray<Record<string, string | null>>;
  } finally {
    db.close();
  }
};
// One system (Director, 19 Nov): an act done through her is on the brain's spine, with her vessel, as done.
{
  // The spine flushes every 2 s.
  await settle(2_500);
  const brainActs = actionsOn(values["brain-db"], startedAt);
  const hubActs = actionsOn(values["hub-db"], startedAt);
  const volume = brainActs.filter(
    (a) => a.kind === "device.cmd" && /^volume\b/.test(a.subject ?? "") && a.subject!.includes(id),
  );
  const why =
    values["brain-db"] === undefined
      ? "no --brain-db"
      : !volume.some((a) => a.outcome === "ok")
        ? `the brain's spine has no done volume act on ${id} (${volume.map((a) => a.outcome).join(", ") || "none"}; the hub has ${
            hubActs
              .filter((a) => a.kind === "device.cmd")
              .map((a) => `${a.subject} ${a.outcome}`)
              .join("; ") || "none"
          })`
        : null;
  rows.push({
    id: "provenance-on-brain",
    result: why === null ? "pass" : "FAIL",
    why,
    brainActs,
    hubActs,
  });
  console.log(
    `${why === null ? "pass" : "FAIL"}  provenance-on-brain${why === null ? "" : `: ${why}`}`,
  );
}

// A hub with no room loop is never in her list: there she would be deaf (19 Nov, his laptop). The brain runs with
// its loop off, as his laptop does. Scratch hubs on loopback have no address to list, so there it does not apply and
// R1Reach.test carries the proof; with addresses, her list must not name the brain's.
{
  const lists = commands.filter((c) => c.tail === "cmd/net/endpoints");
  const brainHost = new URL(brainUrl).host;
  const broker = lists.flatMap(
    (c) => ((c.body as { broker?: unknown }).broker as string[] | undefined) ?? [],
  );
  const why = broker.some((u) => u.includes(brainHost))
    ? `her list names the loop-less hub: ${broker.join(", ")}`
    : null;
  const result = why !== null ? "FAIL" : lists.length === 0 ? "n/a" : "pass";
  rows.push({ id: "no-loopless-hub", result, why, broker });
  console.log(
    `${result.padEnd(4)}  no-loopless-hub${why === null ? (lists.length === 0 ? ": no addresses on scratch hubs" : "") : `: ${why}`}`,
  );
}

// The brain's acts for her reach her hub's loop, all of them and in order.
{
  const from = delivered.length;
  const sent = Array.from({ length: 8 }, (_, i) => `{"vessel":"${id}","mood":"happy","seq":${i}}`);
  for (const p of sent) brainOnly.publish(`${base}/voice/intent/eye`, p);
  await until(() => delivered.length - from >= sent.length, 5_000);
  const got = delivered.slice(from).filter((d) => d.startsWith("voice/intent/eye "));
  const why =
    got.length === sent.length && got.every((d, i) => d.endsWith(sent[i]!))
      ? null
      : `acts arrived ${got.length}/${sent.length}, order ${got.map((d) => /"seq":(\d+)/.exec(d)?.[1]).join(",")}`;
  rows.push({ id: "acts-in-order", result: why === null ? "pass" : "FAIL", why });
  console.log(`${why === null ? "pass" : "FAIL"}  acts-in-order${why === null ? "" : `: ${why}`}`);
}

if (values.out !== undefined) {
  NodeFS.mkdirSync(values.out, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(values.out, "topology.json"),
    JSON.stringify({ rows, commands, delivered }, null, 2),
  );
}
const failed = rows.filter((r) => r.result === "FAIL").length;
const warned = rows.filter((r) => r.result === "WARN").length;
console.log(`topology: ${rows.length - failed - warned} pass, ${failed} fail, ${warned} warn`);
bridge.close();
house?.close();
tessel.close();
loopOnHub.close();
brainOnly.close();
process.exit(failed > 0 ? 1 : 0);
