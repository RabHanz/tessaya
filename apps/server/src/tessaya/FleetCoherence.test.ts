// @effect-diagnostics globalDate:off
import { assert, it } from "@effect/vitest";
import type { FleetFingerprint, RegisteredDevice } from "@t3tools/tessaya-contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { HOME_KEY } from "./BrainHost.ts";
import { receiveAtBrain } from "./BrainReceive.ts";
import * as FleetCoherence from "./FleetCoherence.ts";
import { layerMemory as SqlitePersistenceMemory } from "./TessayaDatabase.ts";

const fp = (sentAt: number): FleetFingerprint => ({
  id: "laptop-env",
  name: "the laptop's server",
  kind: "server",
  host: "laptop",
  version: "0.1.186",
  commit: null,
  startedAt: 0,
  brain: "env:brain-env",
  account: null,
  stores: {},
  sentAt,
});

it.layer(Layer.mergeAll(SqlitePersistenceMemory, FleetCoherence.layer))(
  "the fleet check's door",
  (it) => {
    it.effect(
      "the brain keeps each worker's newest fingerprint, stamped with its own clock; a worker refuses",
      () =>
        Effect.gen(function* () {
          const fleet = yield* FleetCoherence.FleetCoherence;
          yield* TestClock.setTime(10_000);
          assert.deepStrictEqual(yield* receiveAtBrain("fingerprint", fp(9_000)), {
            ok: true,
            value: null,
          });
          yield* TestClock.setTime(20_000);
          yield* receiveAtBrain("fingerprint", fp(19_250));
          assert.deepStrictEqual(
            (yield* fleet.received).map((f) => [f.sentAt, f.receivedAt]),
            [[19_250, 20_000]],
          );
          assert.isFalse((yield* receiveAtBrain("fingerprint", { id: "x" })).ok);
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO fabric_settings (key, value) VALUES (${HOME_KEY}, 'Tessaya')`;
          assert.isFalse((yield* receiveAtBrain("fingerprint", fp(21_000))).ok);
        }),
    );
  },
);

it("a device is last heard at its newest value, not its stale lastSeen (Tumble, 21 Nov)", () => {
  const device: RegisteredDevice = {
    deviceId: "r1-3d57b3",
    kind: "r1",
    name: "Tumble",
    firmware: "smp-0.3.176",
    via: "mqtt",
    online: true,
    lastSeenAt: new Date(1_000).toISOString(),
    version: "26dc7c32",
    items: [],
    values: [
      { itemId: "power.charging", value: true, at: new Date(500).toISOString() },
      { itemId: "wifi.rssi", value: -54, at: new Date(60_000).toISOString() },
    ],
  };
  const got = FleetCoherence.deviceFingerprint(device, "brain-env");
  assert.strictEqual(got.receivedAt, 60_000);
  assert.strictEqual(got.brain, "env:brain-env");
  assert.strictEqual(got.version, "smp-0.3.176");
});
