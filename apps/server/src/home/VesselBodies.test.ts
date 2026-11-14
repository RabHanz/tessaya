import { assert, it } from "@effect/vitest";
import type { VesselBodyMint } from "@t3tools/baton-contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";

import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { layerMemory as BatonDatabaseMemory } from "../baton/BatonDatabase.ts";
import { DeviceRegistry, layer as registryLayer } from "./DeviceRegistry.ts";
import { VesselBodies, layer as bodiesLayer } from "./VesselBodies.ts";

const layer = bodiesLayer.pipe(
  Layer.provideMerge(registryLayer),
  Layer.provideMerge(BatonDatabaseMemory),
  Layer.provide(
    Layer.mock(ServerSecretStore)({
      getOrCreateRandom: () => Effect.succeed(new Uint8Array(32).fill(7)),
    }),
  ),
);

const R1 = "r1-desk";
const UID = "04a1b2c3d4e5f6";
const manifest = {
  deviceId: R1,
  kind: "r1",
  name: "R1",
  schema: 1,
  items: [
    { id: "audio.volume", label: "Volume", type: "number", access: "read,write", safety: "free" },
    {
      id: "imu.profile",
      label: "Motion profile",
      type: "enum",
      values: ["calm", "focus", "playful", "mobile"],
      access: "read,write",
      safety: "free",
    },
    { id: "body.tags", label: "Body tags", type: "string", access: "read", safety: "free" },
  ],
};

/** Waits until the registry reports this value for the item, or any value when none is given. */
const reported = (
  sub: PubSub.Subscription<{ readonly itemId: string; readonly value: unknown }>,
  itemId: string,
  value?: unknown,
) =>
  Effect.gen(function* () {
    for (;;) {
      const c = yield* PubSub.take(sub);
      if (c.itemId === itemId && (value === undefined || c.value === value)) return c.value;
    }
  });

/** The device's side: takes `n` writes one at a time, acknowledging each, as a client vessel would. */
const takeWrites = (n: number) =>
  Effect.gen(function* () {
    const registry = yield* DeviceRegistry;
    const got: Array<[string, unknown]> = [];
    let acks: Array<{ id: string; ok: boolean }> = [];
    while (got.length < n) {
      const writes = yield* registry.take(R1, acks, 15_000);
      acks = writes.map((w) => ({ id: w.id, ok: true }));
      got.push(...writes.map((w): [string, unknown] => [w.itemId, w.value]));
    }
    yield* registry.take(R1, acks, 0);
    return got;
  });

it.effect(
  "adopts a signed body tag, keeps his own changes for that body, and gives the old values back when it leaves",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* DeviceRegistry;
        const bodies = yield* VesselBodies;
        const sub = yield* registry.changes;
        yield* registry.publish("client", manifest);
        yield* registry.report("client", R1, [
          { itemId: "audio.volume", value: 60 },
          { itemId: "imu.profile", value: "focus" },
        ]);

        // No host yet: nothing is signed with a domain nobody chose.
        const refused = yield* Effect.flip(bodies.mint({ uid: UID, type: "plush", name: "Bun" }));
        assert.include(refused.why, "host");
        yield* bodies.setLinksHost("tags.example.com");
        const mint: VesselBodyMint = yield* bodies.mint({ uid: UID, type: "plush", name: "Bun" });
        assert.match(
          mint.url,
          /^https:\/\/tags\.example\.com\/b\/1\/plush\/[a-z2-7]{8}\.[\w-]{16}$/,
        );
        // The same tag always gets the same password, so a re-tag can unlock it.
        assert.strictEqual(
          (yield* bodies.mint({ uid: UID, type: "plush", name: "Bun", bodyId: mint.bodyId }))
            .password,
          mint.password,
        );

        // Seated: the plush's motion profile goes out; the R1 takes it.
        yield* registry.report("client", R1, [
          { itemId: "body.tags", value: [{ uid: UID, url: mint.url }] },
        ]);
        const current = yield* Effect.forkChild(reported(sub, "body.current", "Bun"));
        assert.deepStrictEqual(yield* takeWrites(1), [["imu.profile", "playful"]]);
        assert.strictEqual(yield* Fiber.join(current), "Bun");
        assert.strictEqual(yield* registry.value(R1, "body.posture"), "in_body");

        // "This is the bedroom plush": the server's own item, answered without the device.
        const renamed = yield* registry.write(R1, "body.name", "bedroom plush");
        assert.include(renamed.line, "bedroom plush");
        assert.strictEqual(yield* registry.value(R1, "body.current"), "bedroom plush");

        // He turns it down while it is in the plush: kept for the plush.
        assert.include((yield* bodies.remember(R1, "audio.volume", 30, 60)) ?? "", "bedroom plush");
        yield* registry.report("client", R1, [{ itemId: "audio.volume", value: 30 }]);

        // Lifted out: what the plush replaced comes back.
        yield* registry.report("client", R1, [{ itemId: "body.tags", value: [] }]);
        const out = yield* Effect.forkChild(reported(sub, "body.current", "Tumble"));
        assert.sameDeepMembers(yield* takeWrites(2), [
          ["imu.profile", "focus"],
          ["audio.volume", 60],
        ]);
        assert.strictEqual(yield* Fiber.join(out), "Tumble");
        yield* registry.report("client", R1, [
          { itemId: "audio.volume", value: 60 },
          { itemId: "imu.profile", value: "focus" },
        ]);
        assert.deepStrictEqual(
          ((yield* registry.value(R1, "body.history")) as ReadonlyArray<{ event: string }>).map(
            (h) => h.event,
          ),
          ["out", "in"],
        );

        // Seated again: the plush brings his volume with it.
        yield* registry.report("client", R1, [
          { itemId: "body.tags", value: [{ uid: UID, url: mint.url }] },
        ]);
        assert.sameDeepMembers(yield* takeWrites(2), [
          ["imu.profile", "playful"],
          ["audio.volume", 30],
        ]);
      }),
    ).pipe(Effect.provide(layer)),
);

it.effect("never adopts a body from a link copied onto another tag", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const registry = yield* DeviceRegistry;
      const bodies = yield* VesselBodies;
      const sub = yield* registry.changes;
      yield* registry.publish("client", manifest);
      yield* bodies.setLinksHost("tags.example.com");
      const mint = yield* bodies.mint({ uid: UID, type: "dock", name: "Kitchen dock" });
      const current = yield* Effect.forkChild(reported(sub, "body.current"));
      yield* registry.report("client", R1, [
        { itemId: "body.tags", value: [{ uid: "04ffffffffffff", url: mint.url }] },
      ]);
      assert.strictEqual(yield* Fiber.join(current), "Tumble");
      assert.strictEqual(yield* registry.value(R1, "body.posture"), null);
    }),
  ).pipe(Effect.provide(layer)),
);
