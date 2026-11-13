import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import { layerMemory as BatonDatabaseMemory } from "../baton/BatonDatabase.ts";
import { BatonPhoneInbox, layer as inboxLayer } from "../baton/BatonPhoneInbox.ts";
import { layer as recordLayer } from "../baton/BatonRecordService.ts";
import { DeviceRegistry, layer as registryLayer } from "./DeviceRegistry.ts";
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
    Layer.provideMerge(Layer.mergeAll(broker, home, inboxLayer, recordLayer, registryLayer)),
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
  assert.include(fold("state/online", "1"), { id: ID, cameOnline: true, tag: null });
  assert.isFalse(fold("state/online", "1")!.cameOnline);
  // The firmware's older topics become its manifest's items for the registry.
  assert.deepStrictEqual(fold("state/battery", "71")!.items, [
    { itemId: "power.battery_pct", value: 71 },
  ]);
  assert.deepStrictEqual(fold("state/wifi", '{"rssi":-61,"quality":"good"}')!.items, [
    { itemId: "wifi.rssi", value: -61 },
    { itemId: "wifi.quality", value: "good" },
  ]);
  assert.deepStrictEqual(fold("event/announce", '{"fw_ver":"3.29.10"}')!.items, [
    { itemId: "system.firmware", value: "3.29.10" },
  ]);
  assert.deepStrictEqual(
    fold("state/power", '{"battery_pct":-1,"charging":true,"uptime_ms":23500}')!.items,
    [
      { itemId: "power.charging", value: true },
      { itemId: "system.uptime", value: 24 },
    ],
  );
  assert.deepStrictEqual(fold("state/item/imu.posture", '{"value":"face_down","at":5}')!.items, [
    { itemId: "imu.posture", value: "face_down" },
  ]);
  assert.deepStrictEqual(fold("state/audio/output", '{"out":"onboard","device":""}')!.items, [
    { itemId: "audio.output", value: "speaker" },
    { itemId: "audio.device", value: "" },
  ]);
  assert.deepStrictEqual(fold("state/item/ack", '{"cmd":"item/audio.volume","ok":true}')!.ack, {
    itemId: "audio.volume",
    ok: true,
  });
  fold("state/ota", '{"phase":"failed","rc":-3,"extra":"no space"}');
  assert.include(fold("event/nfc", "04A1B2C3"), { id: ID, cameOnline: false, tag: "04a1b2c3" });
  assert.isNull(fold("event/nfc", "left")!.tag);
  for (const first of [900, 1100, 1000])
    fold(
      "event/voice/metrics",
      JSON.stringify({ asrMs: 120, firstSoundMs: first, text: "unlock the door" }),
    );
  const d = devices.get(ID)!;
  assert.strictEqual(d.ota?.line, "failed (code -3): no space");
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
  // The room loop's enrolment card is kept for the clients, a malformed one is not, and neither is logged.
  const card = {
    title: "Read these aloud",
    lead: "",
    lines: [{ text: "Hi Tessaya", state: "now", heard: 1, why: null }],
    mic: "Agora R1 (room mic)",
    level: 0.4,
    phase: "reading",
    summary: null,
  };
  const logged = d.log.length;
  fold("event/enrol", JSON.stringify(card));
  fold("event/enrol", JSON.stringify({ ...card, phase: "dancing" }));
  assert.deepStrictEqual<unknown>(devices.get(ID)!.enrol, card);
  assert.strictEqual(devices.get(ID)!.log.length, logged);
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

it.effect(
  "runs a button's Tessaya action only when the R1 did nothing with the press, and round-trips a rebind",
  () => {
    const { sent, scenes, topics, layer } = setup();
    return Effect.gen(function* () {
      const devices = yield* HomeDevices.HomeDevices;
      yield* devices.tick;
      yield* devices.receive(`${root}/state/online`, "1");
      sent.length = 0;
      const press = (key: string, act: string, did: string, ms = 0) =>
        devices.receive(`${root}/event/key`, JSON.stringify({ key, act, ms, did }));
      const view = () => devices.overview.pipe(Effect.map((o) => o.devices[0]!));

      // S2 double, which he has not changed: the next persona, announced by the room loop.
      yield* press("s2", "double", "none");
      assert.deepStrictEqual(sent, [{ topic: "voice/persona", payload: {} }]);
      // Presses the R1 acted on itself are left alone.
      sent.length = 0;
      yield* press("s1", "long", "muted", 3000);
      yield* press("s2", "tap", "start");
      assert.lengthOf(sent, 0);

      // S1 long to a prompt: the R1 is told to do nothing there, and its ack is kept.
      yield* devices.command(
        ID,
        { op: "keyBind", slot: "s1.long", bind: { kind: "prompt", text: "Read me my day." } },
        me,
      );
      assert.deepStrictEqual(sent, [
        { topic: "cmd/key/bind", payload: { key: "s1", act: "long", do: "none" } },
      ]);
      yield* devices.receive(
        `${root}/state/key/bind`,
        '{"s1":{"double":"none","long":"none"},"s2":{"double":"none"},"s3":{"double":"vol_up","long":"sleep"}}',
      );
      const keys = (yield* view()).keys;
      assert.deepStrictEqual(
        [keys["s1.long"], keys["s3.double"], keys["s2.double"]],
        [
          { kind: "prompt", text: "Read me my day." },
          { kind: "device", do: "vol_up" },
          { kind: "persona" },
        ],
      );
      sent.length = 0;
      yield* press("s1", "long", "none", 3000);
      assert.deepStrictEqual(sent, [{ topic: "voice/ask", payload: { text: "Read me my day." } }]);

      // A hold runs on release, and not when it was held on into a long press.
      yield* devices.command(
        ID,
        { op: "keyBind", slot: "s3.hold", bind: { kind: "home", entityId: "light.desk" } },
        me,
      );
      sent.length = 0;
      yield* press("s3", "hold", "none");
      yield* press("s3", "hold_end", "none", 3500);
      assert.lengthOf(scenes, 0);
      yield* press("s3", "hold_end", "none", 800);
      assert.deepStrictEqual(scenes, [{ entity_id: "light.desk" }]);
      assert.deepStrictEqual(topics(), ["voice/say"]);

      // S2 double back to nothing; a refused rebind is shown; a fixed press cannot be rebound.
      yield* devices.command(
        ID,
        { op: "keyBind", slot: "s2.double", bind: { kind: "device", do: "none" } },
        me,
      );
      sent.length = 0;
      yield* press("s2", "double", "none");
      assert.lengthOf(sent, 0);
      yield* devices.receive(`${root}/state/key/bind`, '{"ok":false}');
      assert.include((yield* view()).keyNote, "refused");
      const fixed = yield* devices
        .command(ID, { op: "keyBind", slot: "s2.tap", bind: { kind: "mute" } }, me)
        .pipe(Effect.flip);
      assert.include(fixed.why, "cannot be changed");
    }).pipe(Effect.provide(layer));
  },
);

it.effect("turns the R1's screen as asked and shows what it reports back", () => {
  const { sent, layer } = setup();
  return Effect.gen(function* () {
    const devices = yield* HomeDevices.HomeDevices;
    yield* devices.tick;
    yield* devices.receive(`${root}/state/online`, "1");
    sent.length = 0;
    for (const set of ["auto", "normal", "flipped", "calibrate"] as const)
      yield* devices.command(ID, { op: "display", set }, me);
    assert.deepStrictEqual(
      sent.map((s) => s.payload),
      [{ mode: "auto" }, { deg: 0 }, { deg: 180 }, { mode: "calibrate" }],
    );
    yield* devices.receive(`${root}/state/display`, '{"rotate":180,"mode":"auto"}');
    const view = () => devices.overview.pipe(Effect.map((o) => o.devices[0]!.display));
    assert.deepStrictEqual(yield* view(), { rotate: 180, mode: "auto", note: null });
    yield* devices.receive(`${root}/state/display`, '{"ok":false,"reason":"not standing"}');
    assert.deepStrictEqual(yield* view(), { rotate: 180, mode: "auto", note: "not standing" });
  }).pipe(Effect.provide(layer));
});

it.effect(
  "sets how loud she speaks on the R1 in steps from the level it reports, and keeps it",
  () => {
    const { sent, layer } = setup();
    return Effect.gen(function* () {
      const devices = yield* HomeDevices.HomeDevices;
      yield* devices.tick;
      yield* devices.receive(`${root}/state/online`, "1");
      sent.length = 0;
      const set = (to: "up" | "down" | "max" | "default") =>
        devices.command(ID, { op: "volume", to }, agent);
      // No report yet: a step starts from the firmware's 0 dB.
      assert.include((yield* set("up")).line, "louder");
      // The firmware's own report wins (his S1/S3 presses change it too).
      yield* devices.receive(`${root}/state/volume`, '{"pct":40}');
      yield* set("down");
      yield* devices.receive(`${root}/state/volume`, '{"pct":25}');
      yield* set("max");
      yield* devices.receive(`${root}/state/volume`, '{"pct":100}');
      assert.strictEqual((yield* set("max")).line, "Already as loud as this device goes.");
      yield* set("default");
      assert.deepStrictEqual(
        sent.map((s) => [s.topic, s.payload]),
        [
          ["cmd/volume", { pct: 86 }],
          ["cmd/volume", { pct: 25 }],
          ["cmd/volume", { pct: 100 }],
          ["cmd/volume", { pct: 100 }],
          ["cmd/volume", { pct: 71 }],
        ],
      );
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "keeps the R1's manifest and values in the registry, shows them, and sends an item write it acknowledges",
  () => {
    const { sent, layer } = setup();
    return Effect.gen(function* () {
      const devices = yield* HomeDevices.HomeDevices;
      const registry = yield* DeviceRegistry;
      yield* devices.tick;
      yield* devices.receive(`${root}/state/online`, "1");
      yield* devices.receive(
        `${root}/state/manifest`,
        JSON.stringify({
          deviceId: ID,
          kind: "r1",
          name: "R1",
          firmware: "smp-0.3.46",
          schema: 1,
          version: "cb7e6b0d",
          items: [
            {
              id: "power.battery_pct",
              label: "Battery",
              type: "number",
              unit: "%",
              range: [0, 100],
              access: "read",
              safety: "free",
            },
            {
              id: "audio.volume",
              label: "Volume",
              type: "number",
              range: [0, 100],
              access: "read,write",
              safety: "free",
            },
            // The device calls its camera free; the server's floor makes it his owner yes.
            {
              id: "camera.capture",
              label: "Camera",
              type: "action",
              access: "write",
              safety: "free",
            },
          ],
        }),
      );
      yield* devices.receive(`${root}/state/power`, '{"battery_pct":64,"charging":false}');
      const r1 = (yield* registry.get(ID))!;
      assert.deepStrictEqual(
        r1.items.map((i) => [i.id, i.safety, i.privacy === true]),
        [
          ["power.battery_pct", "free", false],
          ["audio.volume", "free", false],
          ["camera.capture", "owner", true],
        ],
      );
      const view = (yield* devices.overview).devices[0]!;
      assert.deepStrictEqual([view.batteryPct, view.charging], [64, false]);
      sent.length = 0;
      const write = yield* registry
        .write(ID, "audio.volume", 40)
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* devices.receive(`${root}/state/item/ack`, '{"cmd":"item/audio.volume","ok":true}');
      assert.strictEqual((yield* Fiber.join(write)).status, "done");
      assert.deepStrictEqual(sent, [{ topic: "cmd/item/audio.volume", payload: { value: 40 } }]);
      const refused = yield* registry.write(ID, "audio.volume", 140).pipe(Effect.flip);
      assert.include(refused.why, "from 0 to 100");
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "reads the R1's battery for any vessel's turn and gates each set by its safety class, the camera on his phone",
  () => {
    const { sent, topics, layer } = setup();
    return Effect.gen(function* () {
      const devices = yield* HomeDevices.HomeDevices;
      const inbox = yield* BatonPhoneInbox;
      const her = { who: "Tessaya via R1", surface: "assistant" } as const;
      yield* devices.tick;
      yield* devices.receive(`${root}/state/online`, "1");
      yield* devices.receive(
        `${root}/state/manifest`,
        JSON.stringify({
          deviceId: ID,
          kind: "r1",
          name: "R1",
          schema: 1,
          items: [
            {
              id: "power.battery_pct",
              label: "Battery",
              type: "number",
              unit: "%",
              range: [0, 100],
              access: "read",
              safety: "free",
              group: "power",
            },
            {
              id: "audio.volume",
              label: "Volume",
              type: "number",
              range: [0, 100],
              access: "read,write",
              safety: "free",
            },
            {
              id: "audio.output",
              label: "Output",
              type: "enum",
              values: ["speaker", "bt", "auto"],
              access: "read,write",
              safety: "confirm",
            },
            {
              id: "camera.capture",
              label: "Camera",
              type: "action",
              access: "write",
              safety: "owner",
              privacy: true,
            },
          ],
        }),
      );
      yield* devices.receive(`${root}/state/power`, '{"battery_pct":14,"charging":false}');
      const call = (kind: "read" | "act", op: string, args: Record<string, unknown>) =>
        serveDevicesCall({ kind, op, args }, her);
      // device_read: the battery with its words and age.
      const read = (yield* call("read", "read", { id: ID, items: ["power.battery_pct"] })) as {
        value: {
          values: Array<{ item: string; value: unknown; said: string; ageSeconds: number }>;
        };
      };
      assert.deepStrictEqual(read.value.values, [
        { item: "power.battery_pct", label: "Battery", value: 14, said: "14 %", ageSeconds: 0 },
      ] as never);
      // free: at once, as an item write the R1 acknowledges.
      sent.length = 0;
      const ack = yield* devices
        .command(ID, { op: "item", itemId: "audio.volume", value: 30 }, her)
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* devices.receive(`${root}/state/item/ack`, '{"cmd":"item/audio.volume","ok":true}');
      assert.strictEqual((yield* Fiber.join(ack)).line, "Volume on R1 is now 30.");
      // confirm: she asks him first; his yes in the conversation lets it run.
      const first = yield* devices.command(
        ID,
        { op: "item", itemId: "audio.output", value: "bt" },
        her,
      );
      assert.strictEqual(first.status, "confirm");
      assert.notInclude(topics(), "cmd/item/audio.output");
      const yes = yield* devices
        .command(ID, { op: "item", itemId: "audio.output", value: "bt", confirmed: true }, her)
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* devices.receive(`${root}/state/item/ack`, '{"cmd":"item/audio.output","ok":true}');
      assert.strictEqual((yield* Fiber.join(yes)).status, "done");
      // An agent's confirm item, and anyone's camera, wait for his yes on the phone.
      assert.strictEqual(
        (yield* devices.command(ID, { op: "item", itemId: "audio.output", value: "auto" }, agent))
          .status,
        "asked",
      );
      const asked = yield* call("act", "set", { id: ID, itemId: "camera.capture" });
      assert.deepStrictEqual((asked as { value: { status: string } }).value.status, "asked");
      assert.notInclude(topics(), "cmd/camera/capture");
      const card = (yield* inbox.pending).find((p) => p.detail.includes("camera.capture"));
      assert.strictEqual(card?.needs, "cloud-approve");
      assert.isTrue(yield* inbox.answerPrompt(card!.id, 0));
      yield* devices.tick;
      // His yes: the picture goes through the R1's own window, with the live light on.
      assert.include(topics(), "cmd/camera/capture");
      const r1 = (yield* devices.overview).registry!.find((d) => d.deviceId === ID)!;
      assert.deepStrictEqual(
        r1.live?.map((l) => l.itemId),
        ["camera.capture"],
      );
    }).pipe(Effect.provide(layer));
  },
);
