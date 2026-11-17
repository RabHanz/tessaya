import { it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { expect } from "vite-plus/test";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { layerMemory as TessayaDatabaseMemory } from "../tessaya/TessayaDatabase.ts";
import { DeviceSync, layer, mergeRecords, type SyncRecords } from "./DeviceSync.ts";
import { HomeAssistantService, type R1Device } from "./HomeAssistantService.ts";
import { makeHub, R1Hub } from "./R1Hub.ts";

const s = (v: unknown, at: number, by: string) => ({ v, at, by });

it("keeps the newest value per field, the same whichever order servers merge in, and twice is once", () => {
  const home: SyncRecords = {
    "r1-a": { outputs: s(["speaker"], 10, "home"), hubs: s(["home"], 5, "home") },
  };
  const cloud: SyncRecords = {
    "r1-a": { outputs: s(["AA"], 20, "cloud"), hubs: s(["cloud"], 1, "cloud") },
  };
  const a = mergeRecords(home, cloud);
  const b = mergeRecords(cloud, home);
  // A change on one server never undoes another field changed elsewhere.
  expect(a.next).toEqual(b.next);
  expect(a.next["r1-a"]).toEqual({ outputs: s(["AA"], 20, "cloud"), hubs: s(["home"], 5, "home") });
  expect(a.changed).toEqual([{ record: "r1-a", field: "outputs", v: ["AA"], at: 20 }]);
  // Merging what is already here changes nothing: no apply runs twice.
  expect(mergeRecords(a.next, cloud).changed).toEqual([]);
  // A tie goes to the later environment id, on both sides.
  const tie = mergeRecords({ x: { f: s(1, 7, "a") } }, { x: { f: s(2, 7, "b") } });
  expect(tie.next["x"]!["f"]!.v).toBe(2);
  expect(mergeRecords({ x: { f: s(2, 7, "b") } }, { x: { f: s(1, 7, "a") } }).changed).toEqual([]);
  // A value never confirmed since the upgrade only fills a gap; it never replaces what a server holds.
  expect(mergeRecords({ x: { f: s(1, 0, "a") } }, { x: { f: s(2, 0, "b") } }).changed).toEqual([]);
  expect(mergeRecords({}, { x: { f: s(2, 0, "b") } }).changed).toEqual([
    { record: "x", field: "f", v: 2, at: 0 },
  ]);
});

it.effect(
  "gives a standby hub the key the device really uses, onto its own hub, and never lets a stale one back",
  () => {
    const KEY1 = "1".repeat(32);
    const KEY2 = "2".repeat(32);
    let record: R1Device = {
      deviceId: "r1-a",
      deviceKey: "0".repeat(32),
      mqttUrl: "mqtt://10.0.0.9:1883",
      mqttUser: "brain",
      mqttPass: "pw",
    };
    let puts = 0;
    const hub = makeHub(() => Effect.succeed(null));
    const deps = Layer.mergeAll(
      Layer.mock(HomeAssistantService)({
        devices: Effect.sync(() => [record]),
        putDevice: (d) =>
          Effect.sync(() => {
            puts += 1;
            record = d;
            return { configured: true };
          }),
      }),
      Layer.succeed(R1Hub, {
        ...hub,
        busLogin: Effect.succeed({ user: "", key: "" }),
        noteKeyUse: () => Effect.void,
        keyUsedOutside: () => null,
      }),
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getEnvironmentId: Effect.succeed(EnvironmentId.make("env-cloud")),
      }),
      TessayaDatabaseMemory,
    );
    const key = (deviceKey: string) => ({ deviceKey, previousKey: null, devicePass: null });
    return Effect.gen(function* () {
      const sync = yield* DeviceSync;
      // Its first look at this server's records runs once the clock moves (the broker record is left alone).
      yield* TestClock.adjust("1 minute");
      // Home's key, not confirmed yet: this server held none for a hub, so it fills the gap, on this server's hub.
      yield* sync.exchange({ "r1-a": { key: s(key(KEY1), 0, "env-home") } });
      expect(record).toMatchObject({ deviceKey: KEY1, mqttUrl: null, mqttPass: null });
      // A newer key (a rotation on home) follows; the older one coming round again is ignored.
      yield* sync.exchange({ "r1-a": { key: s(key(KEY2), 10, "env-home") } });
      expect(record.deviceKey).toBe(KEY2);
      const back = yield* sync.exchange({ "r1-a": { key: s(key(KEY1), 5, "env-home") } });
      expect(record.deviceKey).toBe(KEY2);
      expect(back["r1-a"]!["key"]!.at).toBe(10);
      // The same records again change nothing here.
      const before = puts;
      yield* sync.exchange(back);
      expect(puts).toBe(before);
      // A change made here (a re-pair) is stamped now and goes out as this server's.
      record = { ...record, deviceKey: "3".repeat(32) };
      yield* TestClock.adjust("31 seconds");
      const mine = (yield* sync.get("r1-a"))["key"]!;
      expect(mine).toMatchObject({ by: "env-cloud", v: { deviceKey: "3".repeat(32) } });
      expect(mine.at).toBeGreaterThan(10);
    }).pipe(Effect.provide(layer.pipe(Layer.provide(deps))));
  },
);
