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

import { VoiceForgets, layer as VoiceForgetsLayer } from "../baton/VoiceForgets.ts";
import { MemberPreferences, layer as MemberPreferencesLayer } from "../baton/MemberPreferences.ts";
import { StepUps, layer as StepUpsLayer } from "./StepUps.ts";
import * as SqlClient from "effect/sql/SqlClient";

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
        [
          "streaming",
          { mac: "AA:BB:CC:DD:EE:FF", name: "Flip 5", kind: "speaker" },
          "auto",
          1,
          "Flip 5",
        ],
      );
      // No name from the firmware: the one it was heard by stays, and its Class of Device says headphones.
      yield* devices.receive(
        `${root}/state/bt`,
        '{"state":"idle","mac":"AA:BB:CC:DD:EE:FF","name":"","cod":2360344,"out":"auto","saved":true}',
      );
      assert.deepStrictEqual((yield* devices.overview).devices[0]!.speaker!.saved, {
        mac: "AA:BB:CC:DD:EE:FF",
        name: "Flip 5",
        cod: 2360344,
        kind: "headphones",
      });

      yield* devices.receive(
        `${root}/state/bt`,
        '{"state":"idle","mac":"","saved":false,"out":"onboard"}',
      );
      const after = (yield* devices.overview).devices[0]!.speaker!;
      assert.deepStrictEqual([after.state, after.saved, after.output], ["idle", null, "onboard"]);

      // Off Bluetooth also clears the output a connect forced to bt (13 Nov: replies went to a speaker that was gone).
      sent.length = 0;
      const route = (output: "bt" | "auto") =>
        serveDevicesCall(
          { kind: "act", op: "speaker", args: { id: ID, action: "route", output } },
          me,
        );
      yield* route("auto");
      yield* route("bt");
      assert.deepStrictEqual(sent, [
        { topic: "cmd/bt/route", payload: { out: "auto" } },
        { topic: "cmd/audio/output", payload: { to: "auto" } },
        { topic: "cmd/bt/route", payload: { out: "bt" } },
      ]);
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
    // Firmware that never reported its screen cannot turn it: refused, nothing sent.
    const old = yield* devices.command(ID, { op: "display", set: "flipped" }, me).pipe(Effect.flip);
    assert.include(old.why, "firmware update");
    assert.lengthOf(sent, 0);
    yield* devices.receive(`${root}/state/display`, '{"rotate":0,"mode":"auto"}');
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

it.effect(
  "gives every device the household's shared voices, retained one per member, and clears a member who is gone",
  () => {
    const { sent, layer } = setup();
    const profile = (id: string, version: number) => ({
      id,
      name: id,
      kind: "saved" as const,
      model: "m",
      centroid: "AACAPw==",
      samples: 5,
      sources: ["spoken" as const],
      enrolledAt: "2026-11-13T00:00:00Z",
      version,
      updatedAt: "2026-11-13T00:00:00Z",
    });
    return Effect.gen(function* () {
      const devices = yield* HomeDevices.HomeDevices;
      const voices = yield* VoiceForgets;
      yield* devices.tick;
      yield* voices.setProfiles([profile("sara", 1)]);
      // A device that comes online gets every member's voice at once.
      yield* devices.receive(`${root}/state/online`, "1");
      const voiceSends = () => sent.filter((s) => s.topic.startsWith("voice/profile/"));
      assert.deepStrictEqual(
        voiceSends().map((s) => [s.topic, (s.payload as { version: number }).version, s.retain]),
        [["voice/profile/sara", 1, true]],
      );
      sent.length = 0;
      yield* voices.setProfiles([profile("omar", 1)]);
      yield* TestClock.adjust("1 second");
      assert.deepStrictEqual(
        voiceSends().map((s) => [s.topic, s.payload, s.retain]),
        [
          ["voice/profile/omar", profile("omar", 1), true],
          ["voice/profile/sara", "", true],
        ],
      );
    }).pipe(Effect.provide(layer.pipe(Layer.provideMerge(VoiceForgetsLayer))));
  },
);

it.effect(
  "asks the R1 that held an act, runs it on its verified answer or the phone's yes, and never on a press elsewhere",
  () => {
    const { sent, layer } = setup();
    const ran: Array<unknown> = [];
    const held = (member: string | null) => ({
      device: ID,
      what: "settings set",
      member,
      needs: 2 as const,
      phone: true,
      run: (raised: unknown) => Effect.sync(() => void ran.push(raised)),
    });
    return Effect.gen(function* () {
      const devices = yield* HomeDevices.HomeDevices;
      const stepUps = yield* StepUps;
      const inbox = yield* BatonPhoneInbox;
      yield* devices.tick;
      const act = yield* stepUps.hold(held("owner"));
      assert.deepStrictEqual(
        sent.filter((s) => s.topic === "voice/stepup").map((s) => s.payload),
        [{ act, shared: true }],
      );
      // The act waits as a card on the phone too, so nothing is lost.
      assert.deepStrictEqual(
        (yield* inbox.pending).map((p) => p.id),
        [act],
      );
      const done = (from: string, how: string, ok = true) =>
        devices.receive(
          `freya/r1/${from}/voice/stepup/done`,
          JSON.stringify({ act, ok, how, member: "maya" }),
        );
      // S2 on another R1, S2 on this one (presence is only A1), and a reply that didn't verify: still held.
      yield* done("r1-other", "voice");
      yield* done(ID, "button");
      yield* done(ID, "voice", false);
      assert.deepStrictEqual(ran, []);
      yield* done(ID, "voice");
      assert.deepStrictEqual(ran, [{ member: "maya", assurance: 2 }]);
      assert.deepStrictEqual(yield* inbox.pending, []);
      // Answered once: a later answer finds nothing.
      yield* done(ID, "session");
      assert.strictEqual(ran.length, 1);
      // With no voice answer, the phone's yes runs it.
      const second = yield* stepUps.hold(held("owner"));
      assert.isTrue(yield* inbox.answerPrompt(second, 0));
      yield* TestClock.adjust("2 seconds");
      assert.deepStrictEqual(ran.at(-1), { member: "owner", assurance: 2 });
      // A replay's held act never reaches his phone; its own answer still runs it.
      const replay = yield* stepUps.hold({ ...held("owner"), phone: false });
      assert.deepStrictEqual(yield* inbox.pending, []);
      assert.isTrue(
        yield* stepUps.settle(ID, { act: replay, ok: true, how: "voice", member: null }),
      );
    }).pipe(
      Effect.provide(
        layer.pipe(
          Layer.provideMerge(
            StepUpsLayer.pipe(Layer.provide(inboxLayer), Layer.provide(BatonDatabaseMemory)),
          ),
        ),
      ),
    );
  },
);

it.effect(
  "gives every device each member's own persona and voice, retained, and clears them when they go",
  () => {
    const { sent, layer } = setup();
    return Effect.gen(function* () {
      const devices = yield* HomeDevices.HomeDevices;
      const prefs = yield* MemberPreferences;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO tessaya_member_preferences (member_id, key, value, updated_at)
        VALUES ('maya', 'persona', 'Freya', 'x'), ('maya', 'units', 'metric', 'x'), ('omar', 'voice', 'eve', 'x')`;
      yield* devices.tick;
      yield* devices.receive(`${root}/state/online`, "1");
      const prefSends = () => sent.filter((s) => s.topic.startsWith("voice/prefs/"));
      assert.deepStrictEqual(
        prefSends().map((s) => [s.topic, s.payload, s.retain]),
        [
          ["voice/prefs/maya", { persona: "Freya" }, true],
          ["voice/prefs/omar", { voice: "eve" }, true],
        ],
      );
      sent.length = 0;
      yield* sql`DELETE FROM tessaya_member_preferences WHERE member_id = 'maya' AND key = 'persona'`;
      yield* prefs.changed("maya");
      assert.deepStrictEqual(
        prefSends().map((s) => [s.topic, s.payload, s.retain]),
        [["voice/prefs/maya", "", true]],
      );
    }).pipe(
      Effect.provide(
        layer.pipe(
          Layer.provideMerge(MemberPreferencesLayer.pipe(Layer.provideMerge(BatonDatabaseMemory))),
        ),
      ),
    );
  },
);

it.effect(
  "reaches his Bluetooth devices by the names he uses, says the truth of the result, and pairs a new one after a scan",
  () => {
    const { sent, layer } = setup();
    return Effect.gen(function* () {
      const devices = yield* HomeDevices.HomeDevices;
      const registry = yield* DeviceRegistry;
      const him = { who: "Tessaya via R1", surface: "assistant", approved: true } as const;
      yield* devices.tick;
      yield* devices.receive(`${root}/state/online`, "1");
      yield* devices.receive(`${root}/state/caps`, '{"bt_speaker":true}');
      yield* devices.receive(
        `${root}/state/manifest`,
        JSON.stringify({
          deviceId: ID,
          kind: "r1",
          name: "R1",
          schema: 1,
          items: [
            {
              id: "audio.output",
              label: "Output",
              type: "enum",
              values: ["speaker", "bt", "auto"],
              access: "read,write",
              safety: "confirm",
            },
            {
              id: "bt.connect",
              label: "Connect Bluetooth",
              type: "action",
              access: "write",
              safety: "owner",
            },
          ],
        }),
      );
      // The R1's bond (no name of its own) and his laptop's paired list (names by address).
      yield* devices.receive(
        `${root}/state/bt`,
        '{"state":"idle","mac":"E8:07:BF:35:26:5C","name":"","saved":true}',
      );
      yield* registry.publish("client", {
        deviceId: "desktop-pc",
        kind: "desktop",
        name: "PC",
        schema: 1,
        items: [
          {
            id: "bt.paired",
            label: "Paired Bluetooth",
            type: "list",
            access: "read",
            safety: "free",
          },
        ],
      });
      yield* registry.report("client", "desktop-pc", [
        {
          itemId: "bt.paired",
          value: [
            { name: "MINISO-V5", mac: "E8:07:BF:35:26:5C" },
            { name: "WH-1000XM4", mac: "14:C6:00:00:00:01" },
          ],
        },
      ]);
      const say = (value: unknown, by: HomeDevices.DeviceActor = him) =>
        devices.command(ID, { op: "item", itemId: "bt.connect", value }, by);
      const connect = (value: unknown, state: string, mac = "E8:07:BF:35:26:5C") =>
        Effect.gen(function* () {
          sent.length = 0;
          const fiber = yield* say(value).pipe(Effect.forkChild({ startImmediately: true }));
          yield* devices.receive(`${root}/state/bt`, JSON.stringify({ state, mac, saved: true }));
          return yield* Fiber.join(fiber);
        });
      // "Switch to my speakers": the speaker, by its address, and the truth when it connects.
      const ok = yield* connect({ name: "my speakers" }, "connected");
      assert.deepStrictEqual(sent, [
        { topic: "cmd/audio/output", payload: { to: "bt", mac: "E8:07:BF:35:26:5C" } },
      ]);
      assert.strictEqual(ok.line, "Connected to MINISO-V5. I'll play through it.");
      // Taken by another phone: she says so, and how to fix it.
      const busy = yield* connect("the Miniso", "failed");
      assert.include(busy.line, "connected to another phone or laptop: disconnect it there first");
      // His headphones, known only from the laptop's list.
      const phones = yield* connect("my headphones", "connected", "14:C6:00:00:00:01");
      assert.strictEqual(phones.line, "Connected to WH-1000XM4. I'll play through it.");
      // Nothing by that name: no guess.
      assert.include((yield* say("the kitchen radio")).line, "If it's new, ask me to pair it");
      // "Pair my new JBL": a scan, his cue, then the match from the scan is paired.
      sent.length = 0;
      const pair = yield* say({ name: "new JBL speaker", pair: true });
      assert.include(pair.line, "Put it in pairing mode");
      assert.deepStrictEqual(sent, [{ topic: "cmd/bt/scan", payload: { secs: 12 } }]);
      sent.length = 0;
      yield* devices.receive(
        `${root}/event/bt/devices`,
        JSON.stringify({
          devices: [{ mac: "AA:BB:CC:DD:EE:01", name: "JBL Flip 5", rssi: -50, audio: true }],
        }),
      );
      assert.deepStrictEqual(sent, [
        { topic: "cmd/bt/pair", payload: { mac: "AA:BB:CC:DD:EE:01" } },
      ]);
      yield* devices.receive(
        `${root}/state/bt`,
        '{"state":"connected","mac":"AA:BB:CC:DD:EE:01","saved":true}',
      );
      assert.deepInclude(sent, {
        topic: "voice/say",
        payload: { text: "Connected to JBL Flip 5. I'll play through it." },
      });
      // A rehearsal is answered the same way and sends nothing.
      sent.length = 0;
      const dry = { ...him, dryRun: true } as const;
      assert.strictEqual(
        (yield* say({ name: "the Miniso" }, dry)).line,
        "Connecting to MINISO-V5.",
      );
      assert.include((yield* say({ name: "new one", pair: true }, dry)).line, "pairing mode");
      assert.deepStrictEqual(sent, []);
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "forgets a device when he asks his Tessaya, never for an outside agent, and drops a pretend R1",
  () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const devices = yield* HomeDevices.HomeDevices;
      const registry = yield* DeviceRegistry;
      yield* devices.tick;
      yield* devices.receive("freya/r1/replay-p5/state/online", "1");
      yield* devices.receive("freya/r1/replay-p5/state/power", '{"battery_pct":40}');
      assert.deepStrictEqual(
        (yield* devices.overview).devices.map((d) => d.id),
        [ID],
      );
      yield* registry.publish("client", {
        deviceId: "phone-old",
        kind: "phone",
        name: "Old phone",
        schema: 1,
        items: [],
      });
      const refused = yield* devices
        .command("phone-old", { op: "forget" }, agent)
        .pipe(Effect.flip);
      assert.include(refused.why, "Only he forgets");
      yield* devices.command(
        "phone-old",
        { op: "forget" },
        { who: "Tessaya via R1", surface: "assistant" },
      );
      assert.isNull(yield* registry.get("phone-old"));
    }).pipe(Effect.provide(layer));
  },
);
