// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

import { expect, it } from "vite-plus/test";

import type { R1Device } from "./HomeAssistantService.ts";
import {
  clearStalePorts,
  claimChange,
  HANDBACK_HOLD_MS,
  heldServing,
  elect,
  listenInodes,
  loopPlan,
  devicesHere,
  loopPorts,
  parseEnvFile,
  servingLoops,
  terminate,
  voiceLine,
} from "./R1Loop.ts";

/** A node program and the first `count` lines it prints (pids, ports). */
const spawnNode = (code: string, options: NodeChildProcess.SpawnOptions = {}) => {
  const proc = NodeChildProcess.spawn(process.execPath, ["-e", code], {
    stdio: ["ignore", "pipe", "inherit"],
    ...options,
  });
  const lines = NodeReadline.createInterface({ input: proc.stdout! })[Symbol.asyncIterator]();
  const line = async () => Number((await lines.next()).value);
  return { proc, line };
};
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
// A loop that starts a helper of its own (Pocket, the recogniser) and prints both pids; `stubborn` ignores SIGTERM.
const loopWithHelper = (stubborn: boolean) =>
  spawnNode(
    `const c = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(
      `${stubborn ? 'process.on("SIGTERM", () => {});' : ""} console.log(process.pid); setInterval(() => {}, 1e6);`,
    )}], { stdio: ["ignore", "inherit", "inherit"] });
     console.log(process.pid); setInterval(() => {}, 1e6);`,
    { detached: true },
  );

it("stopping a loop also stops the helpers it started, so none is left holding its ports", async () => {
  const { line } = loopWithHelper(false);
  const loop = await line();
  const helper = await line();
  await terminate(-loop);
  expect([alive(loop), alive(helper)]).toEqual([false, false]);
});

it("a helper that ignores SIGTERM is killed once the grace runs out", async () => {
  const { line } = loopWithHelper(true);
  const loop = await line();
  const helper = await line();
  await terminate(-loop, 200);
  expect([alive(loop), alive(helper)]).toEqual([false, false]);
});

it("a helper left by a loop that died is stopped through the loop's process group", async () => {
  const { proc, line } = loopWithHelper(false);
  const loop = await line();
  const helper = await line();
  const exited = new Promise((r) => proc.once("exit", r));
  process.kill(loop, "SIGKILL");
  await exited;
  expect(alive(helper)).toBe(true);
  await terminate(-loop);
  expect(alive(helper)).toBe(false);
});

it("finds who listens on a port in /proc/net/tcp", () => {
  const table = [
    "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
    "   0: 0100007F:E3A9 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 4242 1",
    "   1: 0100007F:E3A8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 4343 1",
    "   2: 0100007F:E3A9 0100007F:9C40 01 00000000:00000000 00:00000000 00000000  1000        0 4444 1",
  ].join("\n");
  expect(listenInodes(table, 58281)).toEqual(["4242"]);
  expect(listenInodes(table, 58280)).toEqual(["4343"]);
  expect(listenInodes(table, 1)).toEqual([]);
  expect(loopPorts({})).toEqual([58232, 58233]);
  expect(loopPorts({ R1_POCKET_PORT: "7000", R1_RECOGNIZER_PORT: "7001" })).toEqual([7000, 7001]);
});

it("on start, frees the loop's ports from its own orphan but never from someone else's process", async () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "r1-voice-"));
  const elsewhere = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "other-"));
  const listen = (cwd: string) =>
    spawnNode(
      `const s = require("node:net").createServer().listen(0, "127.0.0.1", () => console.log(s.address().port));`,
      { cwd },
    );
  const orphan = listen(dir);
  const stranger = listen(elsewhere);
  const [orphanPort, strangerPort] = [await orphan.line(), await stranger.line()];
  try {
    const lines = await clearStalePorts(dir, [orphanPort, strangerPort]);
    expect([...lines].sort()).toEqual([
      `port ${strangerPort} is held by pid ${stranger.proc.pid}, which is not the room loop's; leaving it`,
      `stopping pid ${orphan.proc.pid}, a leftover of an earlier room loop holding port ${orphanPort}`,
    ]);
    expect([alive(orphan.proc.pid!), alive(stranger.proc.pid!)]).toEqual([false, true]);
  } finally {
    stranger.proc.kill("SIGKILL");
    NodeFS.rmSync(dir, { recursive: true, force: true });
    NodeFS.rmSync(elsewhere, { recursive: true, force: true });
  }
});

const r1 = (id: string, mqttUrl: string | null = null): R1Device => ({
  deviceKey: `${id}-key-0123456789abcdef`,
  deviceId: id,
  mqttUrl,
  mqttUser: null,
  mqttPass: null,
});
const base = {
  dir: "/home/user/.t3/userdata/r1-voice",
  installed: true,
  setting: "",
  devices: [r1("r1-a"), r1("r1-b")],
  port: 3773,
  busKey: "bus",
  folderEnv: parseEnvFile("# voice\nR1_VOICE=anna\n\nR1_BRAIN_URL=http://elsewhere/chat\n"),
};

it("runs the loop against this server's own hub and brain, for every R1 on the hub", () => {
  const plan = loopPlan(base)!;
  expect(plan.node).toBe("/home/user/.t3/userdata/r1-voice/node/bin/node");
  expect(plan.env).toMatchObject({
    R1_VOICE: "anna",
    R1_MQTT_USER: "tessaya-bus",
    // The server's own brain, and so its hub, wins over the folder's.
    R1_BRAIN_URL: "http://127.0.0.1:3773/api/devices/tessel/v1/chat/completions",
    R1_INHOUSE: "r1-a,r1-b",
  });
  expect(plan.secrets.map((s) => s.value)).toEqual([
    "bus",
    "r1-a-key-0123456789abcdef",
    JSON.stringify({ "r1-a": "r1-a-key-0123456789abcdef", "r1-b": "r1-b-key-0123456789abcdef" }),
  ]);
  // an adopted R1 still logs in with its old broker password, so its reset is keyed by that
  const adopted = loopPlan({ ...base, devices: [{ ...r1("r1-a"), devicePass: "old-pass" }] })!;
  expect(JSON.parse(adopted.secrets[2]!.value)).toEqual({ "r1-a": "old-pass" });
});

it("hears a phone vessel like a Tessel, so the loop runs for it with no Tessel connected", () => {
  const devices = [r1("r1-a"), r1("r1-b", "mqtt://broker.local:1883")];
  expect(devicesHere(devices, (id) => id === "r1-a", [])).toEqual(["r1-a"]);
  // Tumble away and his phone on its own: the phone keeps the loop up.
  expect(devicesHere(devices, () => false, ["phone-p1"])).toEqual(["phone-p1"]);
  expect(devicesHere(devices, () => true, ["phone-p1"])).toEqual(["r1-a", "phone-p1"]);
  expect(
    elect({
      others: 0,
      here: 1,
      ready: true,
      lastOtherAt: 0,
      lastHereAt: 0,
      bornAt: 0,
      now: 60_000,
    }),
  ).toMatchObject({ answers: true, claims: true });
});

it("runs no loop when it is not installed, turned off, or no R1 is on this hub", () => {
  expect(loopPlan({ ...base, installed: false })).toBeNull();
  expect(loopPlan({ ...base, setting: "off" })).toBeNull();
  // An R1 on a broker of its own has its loop elsewhere.
  expect(loopPlan({ ...base, devices: [r1("r1-a", "mqtt://broker.local:1883")] })).toBeNull();
  expect(loopPlan({ ...base, devices: [] })).toBeNull();
});

it("runs a release bundle's own recogniser, Pocket and voice, unless the folder's env says otherwise", () => {
  const plan = loopPlan({ ...base, bundled: true, folderEnv: {} })!;
  expect(plan.env).toMatchObject({
    R1_RECOGNIZER_BIN: "/home/user/.t3/userdata/r1-voice/bin/tessaya-recognizer",
    R1_POCKET_BIN: "/home/user/.t3/userdata/r1-voice/models/pocket/pocket-tts",
    R1_VOICE: "eve",
  });
  // A folder installed by hand gets none of it.
  expect(loopPlan(base)!.env["R1_RECOGNIZER_BIN"]).toBeUndefined();
  expect(loopPlan({ ...base, bundled: true })!.env["R1_VOICE"]).toBe("anna");
});

it("tells him where the R1's voice is: downloading, running, elsewhere, or not in this build", () => {
  const at = {
    setting: "",
    onHub: true,
    available: true,
    elsewhere: false,
    standby: false,
    install: { kind: "idle" } as const,
    planned: false,
    running: false,
    restarts: 0,
  };
  expect(voiceLine({ ...at, onHub: false })).toBeNull();
  expect(
    voiceLine({
      ...at,
      install: { kind: "fetching", progress: { done: 512 * 1024 ** 2, total: 1024 ** 3 } },
    }),
  ).toBe("Downloading the Tessel's voice: 50% (0.5 GB of 1.0 GB).");
  expect(voiceLine({ ...at, install: { kind: "failed", why: "no room", at: 0 } })).toContain(
    "no room",
  );
  expect(voiceLine({ ...at, planned: true, running: true })).toBe(
    "The Tessel's voice runs on this server.",
  );
  expect(voiceLine({ ...at, elsewhere: true })).toBe("The Tessel's voice runs on another machine.");
  expect(voiceLine({ ...at, elsewhere: true, standby: true })).toBe(
    "The Tessel's voice runs on another machine; this server stands by to take over.",
  );
  expect(voiceLine({ ...at, available: false })).toContain("only Linux (x64)");
  expect(voiceLine({ ...at, setting: "off" })).toContain("turned off");
});

/** Runs the election over a timeline of (seconds since start, other loops heard): whether this server answers at each. */
const run = (timeline: ReadonlyArray<readonly [number, number]>) =>
  vote(timeline.map(([s, others]) => [s, others, 1, true] as const)).map((v) => v.answers);

/** The election over (seconds, other loops heard, Tessels on this hub, our loop up and hearing): each tick's vote. */
const vote = (timeline: ReadonlyArray<readonly [number, number, number, boolean]>) => {
  let lastOtherAt = 0;
  let lastHereAt = 0;
  return timeline.map(([s, others, here, ready]) => {
    const v = elect({ others, here, ready, lastOtherAt, lastHereAt, bornAt: 0, now: s * 1000 });
    lastOtherAt = v.lastOtherAt;
    lastHereAt = v.lastHereAt;
    return v;
  });
};

it("keeps the standby silent while another loop is heard, takes over when it goes quiet, hands back when it returns", () => {
  // Primary heard: silent, however long.
  expect(
    run([
      [31, 1],
      [60, 1],
      [600, 1],
    ]),
  ).toEqual([false, false, false]);
  // The hub drops the primary when its heartbeat stops; the standby answers 3 s later, not before.
  expect(
    run([
      [40, 1],
      [42, 0],
      [44, 0],
    ]),
  ).toEqual([false, false, true]);
  // A blip shorter than that never takes the room; the primary back hands it back at once.
  expect(
    run([
      [40, 1],
      [41, 0],
      [42, 1],
      [44, 0],
      [46, 0],
      [47, 1],
      [49, 1],
    ]),
  ).toEqual([false, false, false, false, true, false, false]);
});

it("answers alone after a start only once no other loop reconnected, so two starting together never both answer", () => {
  // Both start at once: the other connects within the startup wait, and this one never answers.
  expect(
    run([
      [0, 0],
      [2, 0],
      [10, 1],
      [40, 1],
    ]),
  ).toEqual([false, false, false, false]);
  // Alone after a restart: it answers once the wait is up, the same on every restart.
  expect(
    run([
      [0, 0],
      [29, 0],
      [30, 0],
    ]),
  ).toEqual([false, false, true]);
});

it("claims the room only while its own loop is up and hearing a Tessel on this hub", () => {
  // 18 Nov 19:34: the loop was off on the cloud server, she landed there, and it still recorded a takeover. Never ready, no claim.
  expect(
    vote([
      [31, 0, 1, false],
      [60, 0, 1, false],
    ]).map((v) => [v.answers, v.claims]),
  ).toEqual([
    [true, false],
    [true, false],
  ]);
  // No Tessel on this hub: nothing to serve, so no loop runs here and nothing is claimed, whatever else is quiet.
  expect(vote([[40, 0, 0, false]]).map((v) => [v.answers, v.claims])).toEqual([[false, false]]);
  // She arrives: the loop starts, and the claim follows once it hears her. She leaves: no claim, and after a minute
  // away the loop stops.
  expect(
    vote([
      [40, 0, 1, false],
      [42, 0, 1, true],
      [50, 0, 0, true],
      [111, 0, 0, true],
    ]).map((v) => [v.answers, v.claims]),
  ).toEqual([
    [true, false],
    [true, true],
    [true, false],
    [false, false],
  ]);
  // Another loop on this hub always wins, even with ours up.
  expect(vote([[40, 1, 1, true]]).map((v) => v.claims)).toEqual([false]);
});

it("records whichever loop serves the Tessel on this hub, its own or another (a voice service outside the server)", () => {
  const serving = (claims: boolean, others: ReadonlyArray<string>, here: number) =>
    servingLoops({ claims, ours: "tessaya-room-7", others, here });
  expect(serving(true, [], 1)).toEqual(["tessaya-room-7"]);
  expect(serving(false, ["tessaya-room-9"], 1)).toEqual(["tessaya-room-9"]);
  // Heard, but no Tessel here: that loop serves her on another hub.
  expect(serving(false, ["tessaya-room-9"], 0)).toEqual([]);
  expect(claimChange([], ["tessaya-room-9"])).toBe("room.loop.takeover");
  expect(claimChange(["tessaya-room-9"], ["tessaya-room-9"])).toBeNull();
  // The service restarted under a new id: the new one takes the room.
  expect(claimChange(["tessaya-room-9"], ["tessaya-room-12"])).toBe("room.loop.takeover");
  expect(claimChange(["tessaya-room-9"], [])).toBe("room.loop.handback");
});

it("a loop that reconnects within the hold is still serving, so the record tells no handback and takeover", () => {
  const loop = ["tessaya-room-1636370"];
  // 21 Nov 06:48:11: its hub stalled, it reconnected four seconds later
  const gone = heldServing({ claimed: loop, serving: [], goneSince: null, now: 1_000 });
  expect(gone).toEqual({ serving: loop, goneSince: 1_000 });
  const back = heldServing({ claimed: loop, serving: loop, goneSince: gone.goneSince, now: 5_000 });
  expect(back).toEqual({ serving: loop, goneSince: null });
  expect(claimChange(loop, back.serving)).toBeNull();
  // Gone past the hold: that is a real handback.
  const still = heldServing({
    claimed: loop,
    serving: [],
    goneSince: 1_000,
    now: 1_000 + HANDBACK_HOLD_MS,
  });
  expect(claimChange(loop, still.serving)).toBe("room.loop.handback");
});
