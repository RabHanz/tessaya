import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import { expect } from "vite-plus/test";

import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { CLOUD_ENDPOINT_RUNTIME_CONFIG } from "../cloud/config.ts";
import { CloudManagedEndpointRuntime } from "../cloud/ManagedEndpointRuntime.ts";
import { DirectEndpoints } from "../environment/DirectEndpoints.ts";
import { HomeAssistantService, type R1Device } from "./HomeAssistantService.ts";
import { makeHub, R1Hub } from "./R1Hub.ts";
import { composeEndpoints, R1Reach, reportMatches } from "./R1Reach.ts";
import * as R1ReachModule from "./R1Reach.ts";

const HUB = "/api/r1/mqtt";

it("puts the LAN first, the tunnel only when away is on, and keeps a fallback broker in the last slots", () => {
  const lan = ["http://192.168.1.20:3773/", "http://10.0.0.5:3773/"];
  expect(
    composeEndpoints({ lan, tunnelHost: "t-1.example.net", away: false, fallback: [] }),
  ).toEqual({
    broker: [`ws://192.168.1.20:3773${HUB}`, `ws://10.0.0.5:3773${HUB}`],
    proxy: "http://192.168.1.20:3773",
  });
  expect(
    composeEndpoints({
      lan,
      tunnelHost: "t-1.example.net",
      away: true,
      fallback: ["ws://old:9002/mqtt"],
    }).broker,
  ).toEqual([
    `ws://192.168.1.20:3773${HUB}`,
    `ws://10.0.0.5:3773${HUB}`,
    `wss://t-1.example.net${HUB}`,
    "ws://old:9002/mqtt",
  ]);
  // Four LAN addresses and the tunnel: the tunnel keeps its slot.
  const many = ["a", "b", "c", "d"].map((h) => `http://${h}:1/`);
  expect(
    composeEndpoints({ lan: many, tunnelHost: "t", away: true, fallback: [] }).broker.at(-1),
  ).toBe(`wss://t${HUB}`);
  // No LAN listener (a desktop without network access): the tunnel alone, and uploads through it.
  expect(composeEndpoints({ lan: [], tunnelHost: "t", away: true, fallback: [] })).toEqual({
    broker: [`wss://t${HUB}`],
    proxy: "https://t",
  });
  expect(reportMatches('{"broker":["x"],"proxy":""}', { broker: ["x"], proxy: "" })).toBe(true);
  expect(reportMatches("garbage", { broker: ["x"], proxy: "" })).toBe(false);
});

it.effect("sends the R1 its list when it comes online, again only when the list changes", () =>
  Effect.gen(function* () {
    const store = new Map<string, Uint8Array>();
    const hub = makeHub(() => Effect.succeed(null));
    const record: R1Device = {
      deviceKey: "k".repeat(32),
      mqttUrl: null,
      mqttUser: null,
      mqttPass: null,
      deviceId: "r1-a",
    };
    const layer = R1ReachModule.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(R1Hub, {
            ...hub,
            busLogin: Effect.succeed({ user: "", key: "" }),
            noteKeyUse: () => Effect.void,
            keyUsedOutside: () => null,
          }),
          Layer.mock(HomeAssistantService)({ devices: Effect.succeed([record]) }),
          Layer.mock(ServerSecretStore)({
            get: (name) => Effect.sync(() => Option.fromNullishOr(store.get(name))),
            set: (name, value) => Effect.sync(() => void store.set(name, value)),
          }),
          Layer.mock(DirectEndpoints)({
            resolveAvailable: () =>
              Effect.succeed([{ kind: "lan", httpBaseUrl: "http://192.168.1.20:3773/" }]),
          }),
          Layer.mock(CloudManagedEndpointRuntime)({
            inspectConnector: Effect.succeed({
              pid: 1,
              readyConnections: 1,
              hostname: "t-1.example.net",
              protocol: null,
            }),
          }),
        ),
      ),
    );
    const sent: Array<string> = [];
    const pushed = yield* Queue.unbounded<string>();
    hub.attach(["freya/r1/+/cmd/net/endpoints"], (_t, p) => {
      sent.push(p.toString("utf8"));
      Queue.offerUnsafe(pushed, p.toString("utf8"));
    });
    yield* Effect.gen(function* () {
      const reach = yield* R1Reach;
      // Setup asks once: not answered yet; any change of the setting counts as the answer.
      expect((yield* reach.status).offered).toBe(false);
      // Coming online wakes the sender; the list arrives on its own.
      hub.publish("freya/r1/r1-a/state/online", "1", true);
      expect(JSON.parse(yield* Queue.take(pushed)).broker).toEqual([
        `ws://192.168.1.20:3773${HUB}`,
      ]);
      // The R1 reports it took the list: asking again sends nothing.
      hub.publish("freya/r1/r1-a/state/net/endpoints", sent[0]!, true);
      yield* reach.setAway(false);
      expect(sent).toHaveLength(1);
      // Away on, not linked yet: the line says to link, and the list is unchanged.
      expect((yield* reach.setAway(true)).tunnel).toBe(false);
      expect((yield* reach.status).offered).toBe(true);
      expect(sent).toHaveLength(1);
      // Linked: turning it on again pushes the tunnel; off takes it back out.
      store.set(CLOUD_ENDPOINT_RUNTIME_CONFIG, new Uint8Array([1]));
      expect((yield* reach.setAway(true)).tunnel).toBe(true);
      expect(JSON.parse(sent.at(-1)!).broker.at(-1)).toBe(`wss://t-1.example.net${HUB}`);
      hub.publish("freya/r1/r1-a/state/net/endpoints", sent.at(-1)!, true);
      yield* reach.setAway(false);
      expect(JSON.parse(sent.at(-1)!).broker).toEqual([`ws://192.168.1.20:3773${HUB}`]);
    }).pipe(Effect.provide(layer));
  }),
);
