import { expect, it } from "vite-plus/test";

import type { R1Device } from "./HomeAssistantService.ts";
import { loopPlan, parseEnvFile, voiceLine } from "./R1Loop.ts";

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
    R1_MQTT_URL: "ws://127.0.0.1:3773/api/r1/mqtt",
    R1_MQTT_USER: "tessaya-bus",
    R1_BRAIN_URL: "http://127.0.0.1:3773/api/devices/r1/v1/chat/completions",
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
  ).toBe("Downloading the R1's voice: 50% (0.5 GB of 1.0 GB).");
  expect(voiceLine({ ...at, install: { kind: "failed", why: "no room", at: 0 } })).toContain(
    "no room",
  );
  expect(voiceLine({ ...at, planned: true, running: true })).toBe(
    "The R1's voice runs on this server.",
  );
  expect(voiceLine({ ...at, elsewhere: true })).toBe("The R1's voice runs on another machine.");
  expect(voiceLine({ ...at, available: false })).toContain("only Linux (x64)");
  expect(voiceLine({ ...at, setting: "off" })).toContain("turned off");
});
