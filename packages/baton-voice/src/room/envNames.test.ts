import { expect, it } from "vite-plus/test";

import { adoptTesselNames } from "./envNames.ts";

it("reads a TESSEL_ setting under its old R1_ name, the new one winning, and leaves the rest alone", () => {
  const env: Record<string, string | undefined> = {
    TESSEL_VOICE: "eve",
    R1_VOICE: "anna",
    R1_MQTT_URL: "ws://old/api/r1/mqtt",
    TESSEL_TALK_OVER: "open",
    HOME: "/home/user",
  };
  adoptTesselNames(env);
  expect(env).toEqual({
    TESSEL_VOICE: "eve",
    R1_VOICE: "eve",
    R1_MQTT_URL: "ws://old/api/r1/mqtt",
    TESSEL_TALK_OVER: "open",
    R1_TALK_OVER: "open",
    HOME: "/home/user",
  });
});
