import { expect, it } from "vite-plus/test";

import type { R1Device } from "./HomeAssistantService.ts";
import { elect, loopPlan, parseEnvFile, voiceLine } from "./R1Loop.ts";

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
  folderEnv: parseEnvFile("# voice\nR1_VOICE=anna\n\nR1_MQTT_URL=ws://elsewhere/mqtt\n"),
};

it("runs the loop against this server's own hub and brain, for every R1 on the hub", () => {
  const plan = loopPlan(base)!;
  expect(plan.node).toBe("/home/user/.t3/userdata/r1-voice/node/bin/node");
  expect(plan.env).toMatchObject({
    R1_VOICE: "anna",
    // The server's own hub wins over the folder's.
    R1_MQTT_URL: "ws://127.0.0.1:3773/api/tessel/mqtt",
    R1_MQTT_USER: "tessaya-bus",
    R1_BRAIN_URL: "http://127.0.0.1:3773/api/devices/tessel/v1/chat/completions",
    R1_INHOUSE: "r1-a,r1-b",
  });
  expect(plan.secrets.map((s) => s.value)).toEqual(["bus", "r1-a-key-0123456789abcdef"]);
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
const run = (timeline: ReadonlyArray<readonly [number, number]>) => {
  let lastOtherAt = 0;
  return timeline.map(([s, others]) => {
    const vote = elect({ others, lastOtherAt, bornAt: 0, now: s * 1000 });
    lastOtherAt = vote.lastOtherAt;
    return vote.answers;
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
