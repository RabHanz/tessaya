import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { layerMemory as TessayaDatabaseMemory } from "../tessaya/TessayaDatabase.ts";
import { DeviceRegistry, layer as registryLayer } from "./DeviceRegistry.ts";
import { HouseholdCaller, TessayaHousehold } from "../tessaya/TessayaHousehold.ts";
import { SessionMember } from "../tessaya/TessayaTurn.ts";
import { serveDevicesCall } from "./HomeDeviceCalls.ts";
import { HomeDevices } from "./HomeDevices.ts";

// The door's R1 ops need HomeDevices; a vessel's report never reaches it.
const layer = Layer.mergeAll(registryLayer, Layer.mock(HomeDevices)({})).pipe(
  Layer.provideMerge(TessayaDatabaseMemory),
);
const vessel = { who: "the desktop", surface: "settings" } as const;
const DESK = "desk-laptop";
const manifest = {
  deviceId: DESK,
  kind: "desktop",
  name: "His laptop",
  schema: 1,
  items: [
    {
      id: "audio.input",
      label: "Microphone",
      type: "enum",
      values: ["Scarlett", "DJI"],
      access: "read,write",
      safety: "confirm",
    },
    { id: "presence.hello", label: "Windows Hello", type: "bool", access: "read", safety: "free" },
    { id: "power.on_battery", label: "On battery", type: "bool", access: "read", safety: "free" },
  ],
};

it.effect("keeps whose a client vessel is from the session that first reported it", () =>
  Effect.gen(function* () {
    const registry = yield* DeviceRegistry;
    const publish = (member: string) =>
      serveDevicesCall(
        {
          kind: "vessel",
          op: "publish",
          args: { deviceId: "desk-sara", manifest: { ...manifest, deviceId: "desk-sara" } },
        },
        vessel,
      ).pipe(Effect.provideService(SessionMember, member));
    yield* publish("sara");
    assert.strictEqual((yield* registry.get("desk-sara"))?.member, "sara");
    // Another session reporting the same id never takes it over.
    yield* publish("owner");
    assert.strictEqual((yield* registry.get("desk-sara"))?.member, "sara");
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "takes a desktop's manifest and values over the devices door and hands it the writes meant for it",
  () =>
    Effect.gen(function* () {
      const registry = yield* DeviceRegistry;
      const publish = (args: Record<string, unknown>) =>
        serveDevicesCall(
          { kind: "vessel", op: "publish", args: { deviceId: DESK, ...args } },
          vessel,
        );
      const first = yield* publish({
        manifest,
        values: [{ itemId: "power.on_battery", value: true }],
      });
      assert.deepStrictEqual(first, { ok: true, value: { writes: [] } });
      const desk = (yield* registry.get(DESK))!;
      assert.isTrue(desk.online);
      // A Windows Hello reading is biometric: private whatever the device says.
      assert.isTrue(desk.items.find((i) => i.id === "presence.hello")!.privacy);
      assert.deepStrictEqual(
        desk.values.map((v) => [v.itemId, v.value]),
        [["power.on_battery", true]],
      );
      // A manifest for another device is refused, and an agent's kinds cannot publish.
      assert.isFalse((yield* publish({ manifest: { ...manifest, deviceId: "other" } })).ok);
      assert.isFalse(
        (yield* serveDevicesCall({ kind: "act", op: "publish", args: { deviceId: DESK } }, vessel))
          .ok,
      );
      // A write waits for the desktop's next call, and its ack ends it.
      const write = yield* registry
        .write(DESK, "audio.input", "DJI")
        .pipe(Effect.forkChild({ startImmediately: true }));
      const taken = (yield* publish({})) as {
        value: { writes: Array<{ id: string; itemId: string; value: unknown }> };
      };
      assert.deepStrictEqual(
        taken.value.writes.map((w) => [w.itemId, w.value]),
        [["audio.input", "DJI"]],
      );
      yield* publish({
        acks: [{ id: taken.value.writes[0]!.id, ok: true }],
        values: [{ itemId: "audio.input", value: "DJI" }],
      });
      assert.strictEqual((yield* Fiber.join(write)).status, "done");
      assert.include(
        (yield* registry.write(DESK, "audio.input", "Blue Yeti").pipe(Effect.flip)).why,
        "one of",
      );
      assert.include(
        (yield* registry.write(DESK, "power.on_battery", false).pipe(Effect.flip)).why,
        "only be read",
      );
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "keeps manifests and last values across a restart, and forgets a device completely",
  () => {
    // Each run builds the registry afresh over the same database: a server restart.
    const fresh = <A>(f: (r: DeviceRegistry["Service"]) => Effect.Effect<A>) =>
      Effect.flatMap(DeviceRegistry, f).pipe(Effect.provide(registryLayer));
    return Effect.gen(function* () {
      yield* fresh((r) =>
        Effect.andThen(
          r.publish("client", manifest),
          r.report("client", DESK, [{ itemId: "power.on_battery", value: false }]),
        ),
      );
      const desk = (yield* fresh((r) => r.get(DESK)))!;
      assert.deepStrictEqual(
        desk.values.map((v) => v.value),
        [false],
      );
      assert.strictEqual(desk.items.length, 3);
      yield* fresh((r) => r.forget(DESK));
      assert.isNull(yield* fresh((r) => r.get(DESK)));
    }).pipe(Effect.provide(TessayaDatabaseMemory));
  },
);

it.effect(
  "never keeps a pretend vessel, removes ones kept before, and marks a device unseen for two weeks stale",
  () => {
    const fresh = <A>(f: (r: DeviceRegistry["Service"]) => Effect.Effect<A>) =>
      Effect.flatMap(DeviceRegistry, f).pipe(Effect.provide(registryLayer));
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // Rows a suite run left before pretend vessels were refused (13 Nov: he saw a second R1).
      yield* sql`
        INSERT INTO fabric_devices (id, kind, name, firmware, via, version, manifest, last_seen, updated_at)
        VALUES ('replay-p5', 'r1', 'R1', NULL, 'mqtt', NULL, '{}', 1, 1)
      `;
      yield* sql`INSERT INTO fabric_device_state (device_id, item_id, value, at) VALUES ('room-suite', 'power.battery_pct', '50', 1)`;
      const kept = yield* fresh((r) =>
        Effect.gen(function* () {
          yield* r.publish("mqtt", { ...manifest, deviceId: "replay-audit", kind: "r1" });
          yield* r.publish("client", { ...manifest, deviceId: "desk-x", test: true });
          yield* r.report("mqtt", "bench-r1", [{ itemId: "power.battery_pct", value: 9 }]);
          yield* r.seen("suite-r1", true);
          yield* r.publish("client", manifest);
          return (yield* r.list).map((d) => d.deviceId);
        }),
      );
      assert.deepStrictEqual(kept, [DESK]);
      const rows = yield* sql<{ n: number }>`
        SELECT (SELECT count(*) FROM fabric_devices) + (SELECT count(*) FROM fabric_device_state) AS n
      `;
      assert.strictEqual(rows[0]!.n, 1);
      yield* TestClock.adjust("15 days");
      assert.isTrue((yield* fresh((r) => r.get(DESK)))?.stale);
    }).pipe(Effect.provide(TessayaDatabaseMemory));
  },
);

it.effect("reads and sets only the signed-in member's own preferences over the vessel door", () =>
  Effect.gen(function* () {
    const asked: Array<unknown> = [];
    const household = Layer.mock(TessayaHousehold)({
      call: (input) => {
        asked.push(input);
        return Effect.succeed({
          status: "done" as const,
          line: "Done.",
          preferences: { location: "on" },
        });
      },
    });
    const call = (op: string, args: Record<string, unknown>, member: string | null) =>
      serveDevicesCall({ kind: "vessel", op, args }, vessel).pipe(
        Effect.provideService(HouseholdCaller, { member, assurance: 2, via: "a paired device" }),
        Effect.provide(household),
      );
    // Another member's id in the args is ignored: the session's member is the one asked about.
    const set = yield* call("setPreference", { id: "sara", key: "location", value: "on" }, "zayd");
    assert.deepStrictEqual(set, {
      ok: true,
      value: { line: "Done.", preferences: { location: "on" } },
    });
    assert.deepStrictEqual(asked, [
      { op: "setPreference", id: "zayd", key: "location", value: "on" },
    ]);
    // No member behind the session, or a key that is not a preference: refused before the household is asked.
    assert.isFalse((yield* call("preferences", {}, null)).ok);
    assert.isFalse((yield* call("setPreference", { key: "role", value: "owner" }, "zayd")).ok);
    assert.strictEqual(asked.length, 1);
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "a Tessel gone from its hub is offline since it left, not live on its retained readings (20 Nov 20:37)",
  () =>
    Effect.gen(function* () {
      const registry = yield* DeviceRegistry;
      yield* registry.seen("tumble", true);
      yield* registry.report("mqtt", "tumble", [{ itemId: "power.charging", value: true }]);
      yield* TestClock.adjust("1 minute");
      yield* registry.seen("tumble", false);
      const left = (yield* registry.get("tumble"))!;
      assert.isFalse(left.online);
      assert.deepStrictEqual(left.values, []);
      // The hub serves her retained readings again hours later: she is still gone since she left.
      yield* TestClock.adjust("4 hours");
      yield* registry.seen("tumble", false);
      yield* registry.report("mqtt", "tumble", [{ itemId: "power.battery_pct", value: 99 }]);
      assert.strictEqual((yield* registry.get("tumble"))!.lastSeenAt, left.lastSeenAt);
      assert.strictEqual(Date.parse(left.lastSeenAt!), 60_000);
      // Says online but has sent nothing for 10 minutes: its session dropped without a word.
      yield* registry.seen("dock", true);
      assert.isTrue((yield* registry.get("dock"))!.online);
      yield* TestClock.adjust("11 minutes");
      assert.isFalse((yield* registry.get("dock"))!.online);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "a Tessel put to sleep is asleep, not a fault, and a free change waits for her to wake",
  () =>
    Effect.gen(function* () {
      const registry = yield* DeviceRegistry;
      const sent: Array<string> = [];
      yield* registry.attachWriter("mqtt", (_id, itemId, value) =>
        Effect.sync(() => {
          sent.push(`${itemId}=${String(value)}`);
          return { ok: true };
        }),
      );
      yield* registry.publish("mqtt", {
        deviceId: "tumble",
        kind: "r1",
        name: "Tumble",
        schema: 1,
        items: [
          {
            id: "audio.volume",
            label: "Volume",
            type: "number",
            access: "read,write",
            safety: "free",
          },
          {
            id: "system.reboot",
            label: "Restart",
            type: "action",
            access: "write",
            safety: "confirm",
          },
        ],
      });
      yield* registry.seen("tumble", true);
      // Asleep she stays on the hub: online, asleep, and never "gone" for being quiet.
      yield* registry.sleeping("tumble", true);
      yield* TestClock.adjust("30 minutes");
      const asleep = (yield* registry.get("tumble"))!;
      assert.isTrue(asleep.asleep);
      assert.isTrue(asleep.online);
      const later = yield* registry.write("tumble", "audio.volume", 40);
      assert.include(later.line, "asleep");
      assert.deepStrictEqual(sent, []);
      const ask = yield* registry.write("tumble", "system.reboot", true).pipe(Effect.flip);
      assert.include(String((ask as { why?: string }).why), "asleep");
      // She wakes: the change he asked for is sent.
      yield* registry.sleeping("tumble", false);
      yield* TestClock.adjust("1 second");
      assert.deepStrictEqual(sent, ["audio.volume=40"]);
      assert.isUndefined((yield* registry.get("tumble"))!.asleep);
    }).pipe(Effect.provide(layer)),
);
