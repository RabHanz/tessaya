import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";

import { layerMemory as TessayaDatabaseMemory } from "../tessaya/TessayaDatabase.ts";
import { TessayaOneShot } from "../tessaya/TessayaOneShot.ts";
import { TessayaPhoneInbox, layer as inboxLayer } from "../tessaya/TessayaPhoneInbox.ts";
import { layer as recordLayer } from "../tessaya/TessayaRecordService.ts";
import { DeviceRegistry, layer as registryLayer } from "./DeviceRegistry.ts";
import { DeviceTriggers, layer as triggersLayer } from "./DeviceTriggers.ts";
import { HomeAssistantService } from "./HomeAssistantService.ts";
import * as HomeDevices from "./HomeDevices.ts";

const PHONE = "phone-pixel";
const R1 = "r1-3d57b3";
const me = { who: "Tessaya via R1", surface: "assistant" } as const;

const setup = (judge: (prompt: string) => unknown = () => ({ fire: false, action: null })) => {
  const commands: Array<{ id: string; command: unknown }> = [];
  const devices = Layer.mock(HomeDevices.HomeDevices)({
    command: (id, command) =>
      Effect.sync(() => {
        commands.push({ id, command });
        return { status: "done" as const, line: "done" };
      }),
  });
  const oneShot = Layer.mock(TessayaOneShot)({
    run: ({ prompt, outputSchema }) =>
      Effect.succeed(Schema.decodeUnknownSync(outputSchema as never)(judge(prompt))) as never,
  });
  const layer = triggersLayer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        registryLayer,
        devices,
        oneShot,
        inboxLayer,
        recordLayer,
        Layer.mock(HomeAssistantService)({}),
      ),
    ),
    Layer.provideMerge(TessayaDatabaseMemory),
  );
  return { commands, layer };
};

const manifests = Effect.gen(function* () {
  const registry = yield* DeviceRegistry;
  yield* registry.publish("client", {
    deviceId: PHONE,
    kind: "phone",
    name: "Phone",
    schema: 1,
    items: [
      {
        id: "power.battery_pct",
        label: "Battery",
        type: "number",
        unit: "%",
        access: "read",
        safety: "free",
      },
    ],
  });
  yield* registry.publish("mqtt", {
    deviceId: R1,
    kind: "r1",
    name: "R1",
    schema: 1,
    items: [
      { id: "imu.posture", label: "Posture", type: "enum", access: "read,event", safety: "free" },
      {
        id: "audio.volume",
        label: "Volume",
        type: "number",
        range: [0, 100],
        access: "read,write",
        safety: "free",
      },
    ],
  });
  return registry;
});

it.effect(
  "warns him once as the phone drops under 15%, and not again until it has gone back up",
  () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const registry = yield* manifests;
      const triggers = yield* DeviceTriggers;
      const inbox = yield* TessayaPhoneInbox;
      const fired = yield* triggers.fired;
      const saved = yield* triggers.watch(
        {
          rule: {
            name: "Phone battery low",
            deviceId: PHONE,
            itemId: "power.battery_pct",
            when: { op: "<", value: 15 },
            intent: null,
            then: { kind: "notify", text: "Your phone is under 15%." },
          },
          request: "warn me when my phone is under 15%",
        },
        me,
      );
      for (const pct of [40, 14, 12, 50, 9])
        yield* registry.report("client", PHONE, [{ itemId: "power.battery_pct", value: pct }]);
      assert.strictEqual((yield* PubSub.take(fired)).id, saved.id);
      assert.strictEqual((yield* PubSub.take(fired)).id, saved.id);
      const cards = (yield* inbox.pending).filter((p) => p.title === "Tessaya noticed");
      assert.strictEqual(cards.length, 2);
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "judges a rule in his words on the R1's posture change and mutes it through the device's own gate",
  () => {
    const prompts: Array<string> = [];
    const { commands, layer } = setup((prompt) => {
      prompts.push(prompt);
      return prompt.includes("face_down")
        ? {
            fire: true,
            action: { kind: "device_set", deviceId: R1, itemId: "audio.volume", value: 0 },
          }
        : { fire: false, action: null };
    });
    return Effect.gen(function* () {
      const registry = yield* manifests;
      const triggers = yield* DeviceTriggers;
      const fired = yield* triggers.fired;
      yield* triggers.watch(
        {
          rule: {
            name: "Face down is quiet",
            deviceId: R1,
            itemId: "imu.posture",
            when: null,
            intent: "if the R1 is turned face down, mute it",
            then: null,
          },
          request: "if the R1 is turned face down, mute it",
        },
        me,
      );
      yield* registry.report("mqtt", R1, [{ itemId: "imu.posture", value: "face_down" }]);
      assert.include((yield* PubSub.take(fired)).line, "Face down is quiet");
      assert.deepStrictEqual(commands, [
        { id: R1, command: { op: "item", itemId: "audio.volume", value: 0, confirmed: true } },
      ]);
      // His words reach the model quoted, as data.
      assert.include(prompts[0], '"if the R1 is turned face down, mute it"');
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "refuses a rule on an item the device does not have, and one with nothing to check",
  () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      yield* manifests;
      const triggers = yield* DeviceTriggers;
      const base = { name: "x", deviceId: PHONE, intent: null, then: null } as const;
      const bad = yield* triggers
        .watch({ rule: { ...base, itemId: "location", when: { op: "changes" } }, request: "x" }, me)
        .pipe(Effect.flip);
      assert.include(bad.why, "has no item location");
      const empty = yield* triggers
        .watch({ rule: { ...base, itemId: null, when: null }, request: "x" }, me)
        .pipe(Effect.flip);
      assert.include(empty.why, "needs a condition");
    }).pipe(Effect.provide(layer));
  },
);
