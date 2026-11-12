import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { HomeAssistantService, type R1Device } from "./HomeAssistantService.ts";
import * as PhoneSatellite from "./PhoneSatellite.ts";

const ID = "phone-a1b2c3d4";
const root = `freya/r1/${ID}`;

const setup = (record: R1Device | null) => {
  const sent: Array<{ topic: string; payload: string; retain: boolean }> = [];
  let subscribed: ReadonlyArray<string> = [];
  let deliver: (topic: string, payload: Uint8Array) => void = () => {};
  let closed = 0;
  const broker = Layer.succeed(PhoneSatellite.SatelliteBroker, {
    connect: (input) =>
      Effect.sync(() => {
        subscribed = input.subscribe;
        deliver = input.onMessage;
        return {
          publish: (topic: string, payload: Uint8Array | string, retain?: boolean) =>
            void sent.push({
              topic: topic.replace(`${root}/`, ""),
              payload: typeof payload === "string" ? payload : Buffer.from(payload).toString("hex"),
              retain: retain === true,
            }),
          close: () => void (closed += 1),
        };
      }),
  });
  const home = Layer.mock(HomeAssistantService)({ device: Effect.succeed(record) });
  const layer = PhoneSatellite.layer.pipe(Layer.provide(Layer.mergeAll(broker, home)));
  return {
    sent,
    layer,
    subscribed: () => subscribed,
    deliver: (tail: string, payload: string | Uint8Array) =>
      deliver(
        `${root}/${tail}`,
        typeof payload === "string" ? new TextEncoder().encode(payload) : payload,
      ),
    closed: () => closed,
  };
};

const R1: R1Device = {
  deviceKey: "k".repeat(30),
  mqttUrl: "mqtt://broker.local:1883",
  mqttUser: "tessaya",
  mqttPass: "pw",
  deviceId: "r1-3d57b3",
};

it.effect("relays the room's messages to the phone and the phone's microphone to the room", () => {
  const t = setup(R1);
  return Effect.gen(function* () {
    const satellite = yield* PhoneSatellite.PhoneSatellite;
    const fiber = yield* satellite
      .link({ id: ID, name: "Pixel 6a" })
      .pipe(Stream.take(4), Stream.runCollect, Effect.forkScoped);
    yield* Effect.yieldNow;
    assert.deepStrictEqual(t.subscribed(), [
      `${root}/voice/down`,
      `${root}/voice/ctl`,
      `${root}/cmd/#`,
    ]);
    assert.deepStrictEqual(t.sent, [
      { topic: "state/name", payload: "Pixel 6a", retain: true },
      { topic: "state/online", payload: "1", retain: true },
    ]);
    t.deliver("cmd/voice/start", "{}");
    t.deliver("voice/down", new Uint8Array([1, 0, 255, 255]));
    t.deliver("voice/ctl", '{"ev":"mute"}');
    t.deliver("cmd/eye/set", '{"mood":"happy"}');
    t.deliver("voice/ctl", '{"ev":"flush"}');
    const got = yield* Fiber.join(fiber);
    assert.deepStrictEqual(Array.from(got), [
      { kind: "start" },
      { kind: "audio", pcm: "AQD//w==" },
      { kind: "face", mood: "happy" },
      { kind: "flush" },
    ]);
    // The stream ended: the phone is offline and its connection closed.
    assert.deepStrictEqual(t.sent.at(-1), { topic: "state/online", payload: "0", retain: true });
    assert.strictEqual(t.closed(), 1);
  }).pipe(Effect.scoped, Effect.provide(t.layer));
});

it.effect("sends the phone's frames as bytes and its events as text, only while linked", () => {
  const t = setup(R1);
  return Effect.gen(function* () {
    const satellite = yield* PhoneSatellite.PhoneSatellite;
    const refused = yield* Effect.flip(
      satellite.up({ id: ID, items: [{ topic: "voice/up", data: "AQD//w==" }] }),
    );
    assert.match(refused.why, /not linked/);
    yield* satellite.link({ id: ID, name: "Pixel" }).pipe(Stream.runDrain, Effect.forkScoped);
    yield* Effect.yieldNow;
    yield* satellite.up({
      id: ID,
      items: [
        { topic: "voice/wake", data: "AQD//w==" },
        { topic: "voice/wake/end", data: "" },
        { topic: "event/session/end", data: "{}" },
      ],
    });
    assert.deepStrictEqual(t.sent.slice(2), [
      { topic: "voice/wake", payload: "0100ffff", retain: false },
      { topic: "voice/wake/end", payload: "", retain: false },
      { topic: "event/session/end", payload: "{}", retain: false },
    ]);
  }).pipe(Effect.scoped, Effect.provide(t.layer));
});

it.effect("says what to set up when there is no broker", () => {
  const t = setup(null);
  return Effect.gen(function* () {
    const satellite = yield* PhoneSatellite.PhoneSatellite;
    const error = yield* Effect.flip(
      satellite.link({ id: ID, name: "Pixel" }).pipe(Stream.runDrain),
    );
    assert.match(error.why, /Settings → Home/);
  }).pipe(Effect.provide(t.layer));
});
