import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import { layerMemory as BatonDatabaseMemory } from "../baton/BatonDatabase.ts";
import { BatonPhoneInbox, layer as inboxLayer } from "../baton/BatonPhoneInbox.ts";
import { layer as recordLayer } from "../baton/BatonRecordService.ts";
import { HomeAssistantService, type R1Device } from "./HomeAssistantService.ts";
import { serveDevicesCall } from "./HomeDeviceCalls.ts";
import * as HomeDevices from "./HomeDevices.ts";

const ID = "r1-3d57b3";
const root = `freya/r1/${ID}`;

const setup = () => {
  const sent: Array<{ topic: string; payload: unknown; retain?: boolean }> = [];
  const scenes: Array<unknown> = [];
  let record: R1Device | null = {
    deviceKey: "k".repeat(30),
    mqttUrl: "mqtt://broker.local:1883",
    mqttUser: "tessaya",
    mqttPass: "pw",
    deviceId: ID,
  };
  const broker = Layer.succeed(HomeDevices.HomeDeviceBroker, {
    connect: () =>
      Effect.succeed({
        publish: (topic: string, payload: string, retain?: boolean) =>
          void sent.push({
            topic: topic.replace(`${root}/`, ""),
            payload: payload === "" ? "" : JSON.parse(payload),
            ...(retain === true ? { retain } : {}),
          }),
        connected: () => true,
        close: () => {},
      }),
  });
  const home = Layer.mock(HomeAssistantService)({
    device: Effect.sync(() => record),
    setDevice: (d) =>
      Effect.sync(() => {
        record = d;
        return { configured: d !== null };
      }),
    call: (request) =>
      Effect.sync(() => {
        scenes.push(request.target);
        return { status: "done", id: "x", line: "done", undoId: null, states: [] };
      }),
  });
  const layer = HomeDevices.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(broker, home, inboxLayer, recordLayer)),
    Layer.provideMerge(BatonDatabaseMemory),
  );
  const topics = () => sent.map((s) => s.topic);
  return { sent, scenes, topics, layer, record: () => record };
};

const me = { who: "the Director", surface: "settings" } as const;
const agent = { who: "an agent in T3", surface: "agent" } as const;

it("folds the firmware's topics into a device, keeping only the times of a voice turn", () => {
  const devices = new Map<string, HomeDevices.Heard>();
  const fold = (topic: string, payload: string, at = 1000) =>
    HomeDevices.applyMessage(devices, `${root}/${topic}`, payload, at);
  assert.deepStrictEqual(fold("state/online", "1"), { id: ID, cameOnline: true, tag: null });
  assert.isFalse(fold("state/online", "1")!.cameOnline);
  fold("state/battery", "71");
  fold("state/wifi", '{"rssi":-61,"quality":"good"}');
  fold("event/announce", '{"fw_ver":"3.29.10"}');
  fold("state/ota", '{"phase":"failed","rc":-3,"extra":"no space"}');
  assert.deepStrictEqual(fold("event/nfc", "04A1B2C3"), {
    id: ID,
    cameOnline: false,
    tag: "04a1b2c3",
  });
  assert.isNull(fold("event/nfc", "left")!.tag);
  for (const first of [900, 1100, 1000])
    fold(
      "event/voice/metrics",
      JSON.stringify({ asrMs: 120, firstSoundMs: first, text: "unlock the door" }),
    );
  const d = devices.get(ID)!;
  assert.deepStrictEqual(
    [d.batteryPct, d.rssi, d.signal, d.firmware, d.ota?.line],
    [71, -61, "good", "3.29.10", "failed (code -3): no space"],
  );
  const stages = HomeDevices.stagesOf(d);
  assert.deepStrictEqual(
    stages.find((s) => s.name === "Heard to first sound"),
    {
      name: "Heard to first sound",
      lastMs: 1000,
      p50Ms: 1000,
      samples: 3,
    },
  );
  assert.notInclude(JSON.stringify(d.log), "unlock the door");
  fold("state/online", "0");
  assert.isFalse(devices.get(ID)!.online);
  assert.isNull(HomeDevices.applyMessage(devices, "other/topic", "1", 1));
});

it.effect(
  "re-arms in-house voice and his mute after each boot, and refuses an offline device",
  () => {
    const { sent, topics, layer } = setup();
    return Effect.gen(function* () {
      const devices = yield* HomeDevices.HomeDevices;
      yield* devices.tick;
      const refused = yield* devices
        .command(ID, { op: "eye", mood: "happy" }, me)
        .pipe(Effect.flip);
      assert.include(refused.why, "offline");
      assert.lengthOf(sent, 0);

      yield* devices.receive(`${root}/state/online`, "1");
      yield* devices.command(ID, { op: "mute", muted: true }, me);
      sent.length = 0;
      yield* TestClock.adjust("20 seconds");
      assert.deepStrictEqual(topics(), [
        "cmd/voice/mode",
        "voice/ctl",
        "cmd/voice/mode",
        "voice/ctl",
        "cmd/voice/mode",
        "voice/ctl",
      ]);
      assert.deepStrictEqual(sent[0]!.payload, { mode: "inhouse" });
      assert.deepStrictEqual(sent[1]!.payload, { ev: "mute" });
      const view = (yield* devices.overview).devices[0]!;
      assert.deepStrictEqual(
        [view.id, view.configured, view.online, view.muted, view.earcons],
        [ID, true, true, true, true],
      );
      // Her cues off for this R1: kept, and retained on the broker so the room loop has it after a restart.
      sent.length = 0;
      yield* devices.command(ID, { op: "earcons", on: false }, me);
      assert.deepStrictEqual(sent, [
        { topic: "cmd/voice/earcons", payload: { on: false }, retain: true },
      ]);
      assert.isFalse((yield* devices.overview).devices[0]!.earcons);
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "goes back to in-house, muted, when a transport trial is not kept, and not when it is",
  () => {
    const { sent, layer } = setup();
    return Effect.gen(function* () {
      const devices = yield* HomeDevices.HomeDevices;
      yield* devices.tick;
      yield* devices.receive(`${root}/state/online`, "1");
      yield* TestClock.adjust("20 seconds");
      sent.length = 0;

      yield* devices.command(ID, { op: "transport", transport: "agora" }, me);
      assert.isNotNull((yield* devices.overview).devices[0]!.revertAt);
      yield* TestClock.adjust("61 seconds");
      yield* devices.tick;
      const after = (yield* devices.overview).devices[0]!;
      assert.deepStrictEqual(
        [after.transport, after.muted, after.revertAt],
        ["inhouse", true, null],
      );
      assert.deepStrictEqual(
        sent.map((s) => s.payload),
        [{ mode: "agora" }, { mode: "inhouse" }, { ev: "mute" }],
      );

      yield* devices.command(ID, { op: "transport", transport: "agora" }, me);
      yield* devices.command(ID, { op: "transportConfirm" }, me);
      yield* TestClock.adjust("61 seconds");
      yield* devices.tick;
      assert.strictEqual((yield* devices.overview).devices[0]!.transport, "agora");
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "asks his phone before an agent's camera picture, and keeps a picture only inside his window",
  () => {
    const { topics, layer } = setup();
    return Effect.gen(function* () {
      const devices = yield* HomeDevices.HomeDevices;
      const inbox = yield* BatonPhoneInbox;
      yield* devices.tick;
      yield* devices.receive(`${root}/state/online`, "1");
      const jpeg = new Uint8Array([0xff, 0xd8, 0xff]);
      assert.isFalse(yield* devices.acceptShot(ID, jpeg));

      const asked = yield* devices.command(ID, { op: "camera" }, agent);
      assert.strictEqual(asked.status, "asked");
      assert.notInclude(topics(), "cmd/camera/capture");
      const card = (yield* inbox.pending).find((p) => p.title.includes("R1"));
      assert.strictEqual(card?.needs, "cloud-approve");
      assert.isTrue(yield* inbox.answerPrompt(card!.id, 0));
      yield* devices.tick;
      assert.include(topics(), "cmd/camera/capture");
      assert.isNotNull((yield* devices.overview).devices[0]!.camera.armedUntil);

      assert.isTrue(yield* devices.acceptShot(ID, jpeg));
      assert.isFalse(yield* devices.acceptShot(ID, jpeg));
      assert.include((yield* devices.cameraView(ID))!.dataUrl, "data:image/jpeg;base64,");
      yield* TestClock.adjust("11 minutes");
      yield* devices.tick;
      assert.isNull(yield* devices.cameraView(ID));

      // His own spoken request at the R1, his voice verified: his yes, through the same gate.
      const shots = () => topics().filter((t) => t.endsWith("cmd/camera/capture")).length;
      const before = shots();
      const his = yield* devices.command(
        ID,
        { op: "camera" },
        { who: "Tessaya in the room", surface: "assistant", approved: true },
      );
      assert.strictEqual(his.status, "done");
      assert.strictEqual(shots(), before + 1);
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "runs a tapped tag's action, refuses an owner op on the act kind, and forgets the device",
  () => {
    const { sent, scenes, layer, record } = setup();
    return Effect.gen(function* () {
      const devices = yield* HomeDevices.HomeDevices;
      yield* devices.tick;
      yield* devices.receive(`${root}/state/online`, "1");
      const assign = yield* serveDevicesCall(
        {
          kind: "act",
          op: "nfcAssign",
          args: {
            uid: "04A1",
            label: "Desk dock",
            action: { kind: "scene", entityId: "scene.desk" },
          },
        },
        me,
      );
      assert.isTrue(assign.ok);
      yield* devices.receive(`${root}/event/nfc`, "04a1");
      assert.deepStrictEqual(scenes, [{ entity_id: "scene.desk" }]);

      const wrongKind = yield* serveDevicesCall(
        { kind: "act", op: "reboot", args: { id: ID } },
        me,
      );
      assert.isFalse(wrongKind.ok);
      assert.notInclude(
        sent.map((s) => s.topic),
        "cmd/reboot",
      );

      const forgot = yield* serveDevicesCall({ kind: "act", op: "forget", args: { id: ID } }, me);
      assert.isTrue(forgot.ok);
      assert.isNull(record());
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "keeps the speaker controls off until the firmware says it drives one, then sends them and folds what it reports",
  () => {
    const { sent, layer } = setup();
    return Effect.gen(function* () {
      const devices = yield* HomeDevices.HomeDevices;
      yield* devices.tick;
      yield* devices.receive(`${root}/state/online`, "1");
      yield* TestClock.adjust("20 seconds");
      sent.length = 0;
      const pair = {
        kind: "act",
        op: "speaker",
        args: { id: ID, action: "pair", mac: "AA:BB:CC:DD:EE:FF" },
      } as const;

      const early = yield* serveDevicesCall(pair, me);
      assert.isFalse(early.ok);
      assert.include(early.error, "cannot drive a Bluetooth speaker");
      assert.isNull((yield* devices.overview).devices[0]!.speaker);
      assert.lengthOf(sent, 0);

      yield* devices.receive(`${root}/state/caps`, '{"fw":"smp-0.1.0","bt_speaker":true}');
      const badMac = yield* serveDevicesCall(
        { kind: "act", op: "speaker", args: { id: ID, action: "pair", mac: "AA:BB" } },
        me,
      );
      assert.isFalse(badMac.ok);
      assert.isTrue((yield* serveDevicesCall(pair, me)).ok);
      assert.deepStrictEqual(sent, [
        { topic: "cmd/bt/pair", payload: { mac: "AA:BB:CC:DD:EE:FF" } },
      ]);

      yield* devices.receive(
        `${root}/event/bt/devices`,
        '{"devices":[{"mac":"AA:BB:CC:DD:EE:FF","name":"Flip 5","rssi":-58,"audio":true},{"mac":"junk"}]}',
      );
      yield* devices.receive(
        `${root}/state/bt`,
        '{"state":"streaming","mac":"AA:BB:CC:DD:EE:FF","name":"Flip 5","out":"auto","saved":true}',
      );
      const speaker = (yield* devices.overview).devices[0]!.speaker!;
      assert.deepStrictEqual(
        [
          speaker.state,
          speaker.saved,
          speaker.output,
          speaker.found.length,
          speaker.found[0]!.name,
        ],
        ["streaming", { mac: "AA:BB:CC:DD:EE:FF", name: "Flip 5" }, "auto", 1, "Flip 5"],
      );

      yield* devices.receive(
        `${root}/state/bt`,
        '{"state":"idle","mac":"","saved":false,"out":"onboard"}',
      );
      const after = (yield* devices.overview).devices[0]!.speaker!;
      assert.deepStrictEqual([after.state, after.saved, after.output], ["idle", null, "onboard"]);
    }).pipe(Effect.provide(layer));
  },
);
