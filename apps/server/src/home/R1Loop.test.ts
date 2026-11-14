import { expect, it } from "vite-plus/test";

import type { R1Device } from "./HomeAssistantService.ts";
import { loopPlan, parseEnvFile } from "./R1Loop.ts";

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
