import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { it } from "@effect/vitest";
import {
  connectMqtt,
  connectPacket,
  createDecoder,
  DISCONNECT,
  packet,
  parsePublish,
  publishOnce,
  publishPacket,
  subscribePacket,
} from "@t3tools/baton-shared/mqtt";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import type * as NetAddress from "effect/net/NetAddress";
import { expect } from "vite-plus/test";

import type { R1Device } from "./HomeAssistantService.ts";
import { deviceGrant, makeHub, runHubSocket, type HubGrant } from "./R1Hub.ts";

const KEY = "k".repeat(32);
const logins: Record<string, HubGrant> = {
  [`r1-a:${KEY}`]: { kind: "device", id: "r1-a" },
  [`r1-b:${KEY}`]: { kind: "device", id: "r1-b" },
  "tessaya-bus:bus": { kind: "bus" },
};
const hubForTest = () => makeHub((user, pass) => Effect.succeed(logins[`${user}:${pass}`] ?? null));

/** One fake socket on the hub: what it was sent, decoded, and whether the hub closed it. */
const socketOn = (hub: ReturnType<typeof hubForTest>) => {
  const decode = createDecoder();
  const got: Array<{
    type: number;
    topic?: string;
    payload?: string;
    retain?: boolean;
    body: Buffer;
  }> = [];
  let closed = false;
  const session = hub.open({
    send: (bytes) => {
      for (const p of decode(Buffer.from(bytes)))
        got.push(
          p.type === 3
            ? {
                type: 3,
                topic: parsePublish(p).topic,
                payload: parsePublish(p).payload.toString("utf8"),
                retain: (p.flags & 1) === 1,
                body: p.body,
              }
            : { type: p.type, body: p.body },
        );
    },
    close: () => {
      closed = true;
    },
  });
  const send = (bytes: Uint8Array) => session.receive(bytes);
  const publishes = () => got.filter((g) => g.type === 3).map((g) => `${g.topic}=${g.payload}`);
  return { session, send, got, publishes, closed: () => closed };
};

const will = (clientId: string, user: string, pass: string, topic: string) =>
  packet(
    0x10,
    Buffer.concat([
      Buffer.from([0, 4, 0x4d, 0x51, 0x54, 0x54, 4, 0xc2 | 0x04 | 0x20, 0, 60]),
      ...[clientId, topic, "0", user, pass].map((s) => {
        const b = Buffer.from(s);
        return Buffer.concat([Buffer.from([b.length >> 8, b.length & 0xff]), b]);
      }),
    ]),
  );

it.effect(
  "refuses a wrong key with CONNACK 5 and closes, and lets the device in with its own",
  () =>
    Effect.gen(function* () {
      const hub = hubForTest();
      const wrong = socketOn(hub);
      yield* wrong.send(
        connectPacket({ clientId: "r1-a", user: "r1-a", pass: "nope", keepAliveS: 60 }),
      );
      expect([...wrong.got[0]!.body]).toEqual([0, 5]);
      expect(wrong.closed()).toBe(true);
      const right = socketOn(hub);
      yield* right.send(
        connectPacket({ clientId: "r1-a", user: "r1-a", pass: KEY, keepAliveS: 60 }),
      );
      expect([...right.got[0]!.body]).toEqual([0, 0]);
      expect(right.closed()).toBe(false);
      // Nothing before CONNECT: a PUBLISH first closes the socket.
      const early = socketOn(hub);
      yield* early.send(publishPacket("freya/r1/r1-a/state/online", Buffer.from("1")));
      expect(early.closed()).toBe(true);
    }),
);

it.effect("keeps a device to its own topics, and gives the bus and the server every R1's", () =>
  Effect.gen(function* () {
    const hub = hubForTest();
    const server: Array<string> = [];
    const link = hub.attach(["freya/r1/+/state/#"], (t, p) => server.push(`${t}=${p}`));
    const a = socketOn(hub);
    const b = socketOn(hub);
    const bus = socketOn(hub);
    yield* a.send(connectPacket({ clientId: "r1-a", user: "r1-a", pass: KEY, keepAliveS: 60 }));
    yield* b.send(connectPacket({ clientId: "r1-b", user: "r1-b", pass: KEY, keepAliveS: 60 }));
    yield* bus.send(
      connectPacket({ clientId: "loop", user: "tessaya-bus", pass: "bus", keepAliveS: 30 }),
    );
    yield* a.send(
      subscribePacket(1, ["freya/r1/r1-a/cmd/#", "freya/r1/r1-b/state/#", "freya/r1/+/state/#"]),
    );
    expect([...a.got.at(-1)!.body]).toEqual([0, 1, 0, 0x80, 0x80]);
    yield* bus.send(subscribePacket(1, ["freya/r1/+/state/#"]));
    expect([...bus.got.at(-1)!.body]).toEqual([0, 1, 0]);
    // r1-b's publish under r1-a's prefix is dropped; its own reaches the bus and the server, not r1-a.
    yield* b.send(publishPacket("freya/r1/r1-a/state/online", Buffer.from("x")));
    yield* b.send(publishPacket("freya/r1/r1-b/state/online", Buffer.from("1")));
    expect(bus.publishes()).toEqual(["freya/r1/r1-b/state/online=1"]);
    expect(server).toEqual(["freya/r1/r1-b/state/online=1"]);
    expect(a.publishes()).toEqual([]);
    // The server and the bus can command a device.
    link.publish("freya/r1/r1-a/cmd/eye/set", "{}");
    yield* bus.send(publishPacket("freya/r1/r1-a/cmd/led", Buffer.from("red")));
    expect(a.publishes()).toEqual(["freya/r1/r1-a/cmd/eye/set={}", "freya/r1/r1-a/cmd/led=red"]);
    // A QoS 1 publish (some firmware topics) is acknowledged with its packet id.
    const qos1 = publishPacket("freya/r1/r1-b/state/battery", Buffer.from("80"));
    const withId = Buffer.concat([
      Buffer.from([0x32, qos1[1]! + 2]),
      qos1.subarray(2, 31),
      Buffer.from([0, 7]),
      qos1.subarray(31),
    ]);
    yield* b.send(withId);
    expect([...b.got.at(-1)!.body]).toEqual([0, 7]);
    expect(server.at(-1)).toBe("freya/r1/r1-b/state/battery=80");
    yield* a.send(Buffer.from([0xc0, 0]));
    expect(a.got.at(-1)!.type).toBe(13);
  }),
);

it.effect(
  "hands retained messages to a later subscriber, and publishes the will only on a drop",
  () =>
    Effect.gen(function* () {
      const hub = hubForTest();
      const a = socketOn(hub);
      yield* a.send(will("r1-a", "r1-a", KEY, "freya/r1/r1-a/state/online"));
      yield* a.send(publishPacket("freya/r1/r1-a/state/online", Buffer.from("1"), true));
      const later: Array<string> = [];
      hub.attach(["freya/r1/+/state/online"], (t, p) => later.push(`${t}=${p}`));
      expect(later).toEqual(["freya/r1/r1-a/state/online=1"]);
      // The same client id again: the old socket is closed and its will dropped, so the device stays online.
      const again = socketOn(hub);
      yield* again.send(will("r1-a", "r1-a", KEY, "freya/r1/r1-a/state/online"));
      expect(a.closed()).toBe(true);
      a.session.gone();
      expect(later).toEqual(["freya/r1/r1-a/state/online=1"]);
      // A drop without DISCONNECT publishes the will, retained.
      again.session.gone();
      expect(later.at(-1)).toBe("freya/r1/r1-a/state/online=0");
      const bus = socketOn(hub);
      yield* bus.send(
        connectPacket({ clientId: "w", user: "tessaya-bus", pass: "bus", keepAliveS: 30 }),
      );
      yield* bus.send(subscribePacket(2, ["freya/r1/r1-a/state/online"]));
      expect(bus.got.filter((g) => g.type === 3).map((g) => [g.payload, g.retain])).toEqual([
        ["0", true],
      ]);
      // A goodbye first: no will.
      const polite = socketOn(hub);
      yield* polite.send(will("r1-b", "r1-b", KEY, "freya/r1/r1-b/state/online"));
      yield* polite.send(DISCONNECT);
      polite.session.gone();
      expect(later.some((l) => l.startsWith("freya/r1/r1-b"))).toBe(false);
    }),
);

it("accepts an R1 by its device key or the password it had on its own broker, and nothing else", () => {
  const record: R1Device = {
    deviceKey: KEY,
    mqttUrl: null,
    mqttUser: null,
    mqttPass: null,
    deviceId: "r1-a",
    devicePass: "old-broker-pass",
  };
  expect(deviceGrant(record, "r1-a", KEY)).toEqual({ kind: "device", id: "r1-a" });
  expect(deviceGrant(record, "r1-a", "old-broker-pass")).toEqual({ kind: "device", id: "r1-a" });
  expect(deviceGrant(record, "r1-a", "")).toBeNull();
  expect(deviceGrant(record, "r1-b", KEY)).toBeNull();
  expect(deviceGrant({ ...record, devicePass: null }, "r1-a", "old-broker-pass")).toBeNull();
  expect(deviceGrant(null, "r1-a", KEY)).toBeNull();
});

it.live(
  "carries an R1's publish to the room loop over a real WebSocket with the mqtt subprotocol",
  () =>
    Effect.gen(function* () {
      const hub = hubForTest();
      const routes = HttpRouter.add(
        "GET",
        "/api/r1/mqtt",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const socket = yield* request.upgrade;
          yield* runHubSocket(socket, hub).pipe(Effect.scoped);
          return HttpServerResponse.empty();
        }),
      );
      yield* Layer.build(HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }));
      const address = (yield* HttpServer.HttpServer).address as NetAddress.InetAddress;
      const url = `ws://127.0.0.1:${address.port}/api/r1/mqtt`;
      yield* Effect.promise(async () => {
        const once = (pass: string) =>
          new Promise<boolean>((resolve) =>
            publishOnce(
              {
                url,
                user: "r1-a",
                pass,
                topic: "freya/r1/r1-a/state/online",
                payload: "1",
                retain: true,
              },
              resolve,
            ),
          );
        expect(await once("wrong")).toBe(false);
        expect(await once(KEY)).toBe(true);
        // Retained, so the loop that logs in afterwards hears it whatever order the sockets reach the hub.
        const heard = Promise.withResolvers<string>();
        const loop = connectMqtt({
          url,
          clientId: "loop",
          user: "tessaya-bus",
          pass: "bus",
          subscribe: ["freya/r1/+/state/online"],
          onMessage: (t, p) => heard.resolve(`${t}=${p.toString("utf8")}`),
          log: () => {},
        });
        try {
          expect(await heard.promise).toBe("freya/r1/r1-a/state/online=1");
        } finally {
          loop.close();
        }
      });
    }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
);
