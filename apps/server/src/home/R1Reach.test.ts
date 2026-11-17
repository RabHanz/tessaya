import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import { connectPacket, publishPacket } from "@t3tools/tessaya-shared/mqtt";
import { expect } from "vite-plus/test";

import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { CLOUD_ENDPOINT_RUNTIME_CONFIG } from "../cloud/config.ts";
import { CloudManagedEndpointRuntime } from "../cloud/ManagedEndpointRuntime.ts";
import { DirectEndpoints } from "../environment/DirectEndpoints.ts";
import { HomeAssistantService, type R1Device } from "./HomeAssistantService.ts";
import { makeHub, R1Hub } from "./R1Hub.ts";
import { DeviceSync, HUBS_RECORD } from "./DeviceSync.ts";
import {
  composeEndpoints,
  hubOrder,
  ownHubUrls,
  ownProxy,
  R1Reach,
  reportMatches,
} from "./R1Reach.ts";
import * as R1ReachModule from "./R1Reach.ts";

const HUB = "/api/r1/mqtt";

it("puts the LAN first, the tunnel only when away is on, and keeps a fallback broker in the last slots", () => {
  const lan = ["http://192.168.1.20:3773/", "http://10.0.0.5:3773/"];
  const one = (
    away: boolean,
    fallback: ReadonlyArray<string> = [],
    l = lan,
    host = "t-1.example.net",
  ) =>
    composeEndpoints({
      hubs: [ownHubUrls({ lan: l, tunnelHost: host, away })],
      fallback,
      proxy: ownProxy({ lan: l, tunnelHost: host, away }),
    });
  expect(one(false)).toEqual({
    broker: [`ws://192.168.1.20:3773${HUB}`, `ws://10.0.0.5:3773${HUB}`],
    proxy: "http://192.168.1.20:3773",
  });
  expect(one(true, ["ws://old:9002/mqtt"]).broker).toEqual([
    `ws://192.168.1.20:3773${HUB}`,
    `ws://10.0.0.5:3773${HUB}`,
    `wss://t-1.example.net${HUB}`,
    "ws://old:9002/mqtt",
  ]);
  // Four LAN addresses and the tunnel: the tunnel keeps its slot.
  const many = ["a", "b", "c", "d"].map((h) => `http://${h}:1/`);
  expect(one(true, [], many, "t").broker.at(-1)).toBe(`wss://t${HUB}`);
  // No LAN listener (a cloud box, a desktop without network access): the tunnel alone, and uploads through it.
  expect(one(false, [], [], "t")).toEqual({ broker: [`wss://t${HUB}`], proxy: "https://t" });
  expect(reportMatches('{"broker":["x"],"proxy":""}', { broker: ["x"], proxy: "" })).toBe(true);
  expect(reportMatches("garbage", { broker: ["x"], proxy: "" })).toBe(false);
});

it("gives every hub a slot in his order, and every server the same list, so she moves back to the first", () => {
  const home = ["ws://192.168.1.20:3773/api/r1/mqtt", "wss://home.example.net/api/r1/mqtt"];
  const cloud = ["wss://cloud.example.net/api/r1/mqtt"];
  const laptop = ["ws://192.168.1.30:3773/api/r1/mqtt"];
  // Home with its LAN and tunnel, the cloud box, the laptop: four slots, each hub first in his order.
  expect(composeEndpoints({ hubs: [home, cloud, laptop], fallback: [], proxy: "" }).broker).toEqual(
    [...home, ...cloud, ...laptop],
  );
  // A fifth address: each hub keeps one slot before any keeps a second; cut to one, home keeps its tunnel, which
  // answers from anywhere.
  const big = ["ws://10.0.0.1/api/r1/mqtt", ...home];
  expect(
    composeEndpoints({ hubs: [big, cloud, laptop], fallback: ["ws://old/mqtt"], proxy: "" }).broker,
  ).toEqual([big.at(-1), cloud[0], laptop[0], "ws://old/mqtt"]);
  const known = [
    { id: "env-home", label: "home" },
    { id: "env-cloud", label: "cloud" },
    { id: "env-laptop", label: "laptop" },
  ];
  // No saved order: the hub the device was given first stays first on every server, the rest by name.
  for (const _server of ["env-home", "env-cloud"])
    expect(hubOrder({ saved: null, known, first: "env-home" })).toEqual([
      "env-home",
      "env-cloud",
      "env-laptop",
    ]);
  // His order wins; a hub he has not placed yet goes after it, and one that is gone drops out.
  expect(hubOrder({ saved: ["env-cloud", "env-gone"], known, first: "env-home" })).toEqual([
    "env-cloud",
    "env-home",
    "env-laptop",
  ]);
});

it.effect("on the standby hub, keeps the first hub first and says which one the device is on", () =>
  Effect.gen(function* () {
    const hub = makeHub(() => Effect.succeed(null));
    const record: R1Device = {
      deviceKey: "k".repeat(32),
      mqttUrl: null,
      mqttUser: null,
      mqttPass: null,
      deviceId: "r1-a",
    };
    const HOME = "wss://home.example.net/api/r1/mqtt";
    const stamps: Record<string, Record<string, { v: unknown; at: number; by: string }>> = {
      [HUBS_RECORD]: { "env-home": { v: { label: "home", urls: [HOME] }, at: 5, by: "env-home" } },
      "r1-a": { key: { v: {}, at: 5, by: "env-home" } },
    };
    const layer = R1ReachModule.layerWith(() => ({ memAvailMb: null, memPsiFull10: null })).pipe(
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
            get: (name) =>
              Effect.succeed(
                name === CLOUD_ENDPOINT_RUNTIME_CONFIG
                  ? Option.some(new Uint8Array([1]))
                  : name === "r1-tunnel-host"
                    ? Option.some(new TextEncoder().encode("cloud.example.net"))
                    : Option.none(),
              ),
            set: () => Effect.void,
          }),
          Layer.mock(DeviceSync)({
            self: "env-cloud",
            put: (record, field, v) =>
              Effect.sync(() => {
                stamps[record] = { ...stamps[record], [field]: { v, at: 9, by: "env-cloud" } };
              }),
            get: (record) => Effect.sync(() => stamps[record] ?? {}),
            onMerged: () => Effect.void,
          }),
        ),
      ),
    );
    const pushed = yield* Queue.unbounded<string>();
    hub.attach(["freya/r1/+/cmd/net/endpoints"], (_t, p) =>
      Queue.offerUnsafe(pushed, p.toString("utf8")),
    );
    yield* Effect.gen(function* () {
      const reach = yield* R1Reach;
      // The cloud box has no LAN: it is reached through its tunnel, and lists home first as the device was given.
      hub.publish(
        "freya/r1/r1-a/state/net/endpoints",
        JSON.stringify({ broker: [HOME], current: `wss://cloud.example.net${HUB}` }),
        true,
      );
      hub.publish("freya/r1/r1-a/state/online", "1", true);
      expect(JSON.parse(yield* Queue.take(pushed)).broker).toEqual([
        HOME,
        `wss://cloud.example.net${HUB}`,
      ]);
      expect((yield* reach.hubs("r1-a")).map((h) => `${h.label}:${h.current}`)).toEqual([
        "home:false",
        "this server:true",
      ]);
    }).pipe(Effect.provide(layer));
  }),
);

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
    const layer = R1ReachModule.layerWith(() => ({ memAvailMb: null, memPsiFull10: null })).pipe(
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

it.effect(
  "moves a device off a starving hub once it holds the new list and the room is quiet",
  () =>
    Effect.gen(function* () {
      const KEY = "k".repeat(32);
      const hub = makeHub((user, pass) =>
        Effect.succeed(user === "r1-a" && pass === KEY ? { kind: "device", id: "r1-a" } : null),
      );
      const record: R1Device = {
        deviceKey: KEY,
        mqttUrl: null,
        mqttUser: null,
        mqttPass: null,
        deviceId: "r1-a",
      };
      const CLOUD = `wss://cloud.example.net${HUB}`;
      const stamps: Record<string, Record<string, { v: unknown; at: number; by: string }>> = {
        [HUBS_RECORD]: {
          "env-cloud": { v: { label: "cloud", urls: [CLOUD] }, at: 5, by: "env-cloud" },
        },
        "@health": { "env-cloud": { v: "ok", at: 5, by: "env-cloud" } },
        "r1-a": { key: { v: {}, at: 5, by: "env-home" } },
      };
      const placed: Array<unknown> = [];
      // onnyx on 17 Nov: 195 MB free, memory PSI full 30%.
      const layer = R1ReachModule.layerWith(() => ({ memAvailMb: 195, memPsiFull10: 30 })).pipe(
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
              get: () => Effect.succeedNone,
              set: () => Effect.void,
            }),
            Layer.mock(DirectEndpoints)({
              resolveAvailable: () =>
                Effect.succeed([{ kind: "lan", httpBaseUrl: "http://192.168.1.20:3773/" }]),
            }),
            Layer.mock(DeviceSync)({
              self: "env-home",
              put: (rec, field, v) =>
                Effect.sync(() => {
                  if (rec === "r1-a" && field === "placed") placed.push(v);
                  stamps[rec] = { ...stamps[rec], [field]: { v, at: 9, by: "env-home" } };
                }),
              get: (rec) => Effect.sync(() => stamps[rec] ?? {}),
              onMerged: () => Effect.void,
            }),
          ),
        ),
      );
      const pushed: Array<string> = [];
      hub.attach(["freya/r1/+/cmd/net/endpoints"], (_t, p) => void pushed.push(p.toString("utf8")));
      let closed = false;
      const device = hub.open({ send: () => {}, close: () => void (closed = true) });
      yield* device.receive(
        connectPacket({ clientId: "r1-a", user: "r1-a", pass: KEY, keepAliveS: 600 }),
      );
      const report = (json: string) =>
        device.receive(publishPacket("freya/r1/r1-a/state/net/endpoints", Buffer.from(json), true));
      yield* Effect.gen(function* () {
        yield* device.receive(publishPacket("freya/r1/r1-a/state/online", Buffer.from("1"), true));
        yield* TestClock.adjust("1 second");
        expect(JSON.parse(pushed.at(-1)!).broker[0]).toBe(`ws://192.168.1.20:3773${HUB}`);
        yield* report(pushed.at(-1)!);
        // Degraded only once the bad figures have held 60 s; then the cloud hub goes first.
        yield* TestClock.adjust("50 seconds");
        expect(placed).toEqual([]);
        yield* TestClock.adjust("20 seconds");
        expect(placed).toEqual(["env-cloud"]);
        expect(JSON.parse(pushed.at(-1)!).broker[0]).toBe(CLOUD);
        // His order is pinned first, so the move back has something to return to.
        expect(stamps["r1-a"]?.["hubs"]?.v).toEqual(["env-home", "env-cloud"]);
        yield* report(pushed.at(-1)!);
        // He is talking: voice keeps flowing, so the socket stays.
        for (let i = 0; i < 6; i++) {
          yield* device.receive(publishPacket("freya/r1/r1-a/voice/up", Buffer.from([1, 2])));
          yield* TestClock.adjust("10 seconds");
        }
        expect(closed).toBe(false);
        // 30 s of quiet: relinked, and no second move inside the dwell.
        yield* TestClock.adjust("40 seconds");
        expect(closed).toBe(true);
        expect(placed).toEqual(["env-cloud"]);
      }).pipe(Effect.provide(layer));
    }),
);
