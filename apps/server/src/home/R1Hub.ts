// @effect-diagnostics nodeBuiltinImport:off
/**
 * The server's own MQTT hub for R1 topics (`/api/r1/mqtt`): MQTT 3.1.1 over a WebSocket (subprotocol `mqtt`), only the
 * subset the firmware speaks. An R1 logs in as its device id and may use only `freya/r1/<its id>/`; the bus login (a
 * room loop, a watching server) may use every `freya/r1/`. The server's own code attaches in process.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";

import {
  createDecoder,
  packet,
  publishOnce,
  publishPacket,
  topicMatches,
  type Incoming,
} from "@t3tools/baton-shared/mqtt";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Socket from "effect/socket/Socket";

import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { isPrivateNetworkAddress } from "../startupAccess.ts";
import { HomeAssistantService, type R1Device } from "./HomeAssistantService.ts";

export const R1_HUB_PATH = "/api/r1/mqtt";
/** The bus login's user name; its key is the `r1-bus` secret. Checked before device ids, so no R1 can take it. */
const R1_BUS_USER = "tessaya-bus";
const BUS_SECRET = "r1-bus";
/** A `voice/down` frame is under 2 KB; nothing the R1 or the loop sends comes near this. */
const MAX_PACKET = 64 * 1024;
const MAX_RETAINED = 2_000;
const DEVICE_ID = /^[A-Za-z0-9_-]{1,60}$/;

export type HubGrant = { readonly kind: "device"; readonly id: string } | { readonly kind: "bus" };

/** A filter or topic this login may use: a device its own prefix, the bus every R1's. */
const hubAllows = (grant: HubGrant, filter: string): boolean =>
  filter.startsWith(grant.kind === "bus" ? "freya/r1/" : `freya/r1/${grant.id}/`);

export interface HubLink {
  readonly publish: (topic: string, payload: string | Uint8Array, retain?: boolean) => void;
  readonly connected: () => boolean;
  readonly close: () => void;
}

/** One socket's side of the hub: bytes in, and whether the hub has ended it. */
export interface HubSession {
  readonly receive: (chunk: Uint8Array) => Effect.Effect<void>;
  /** The socket is gone: publish the will unless it said goodbye. */
  readonly gone: () => void;
  /** How long the socket may stay silent: until CONNECT, then 1.5 times its keep-alive. */
  readonly idleMs: () => number;
}

interface Subscriber {
  readonly filters: Array<string>;
  readonly deliver: (topic: string, payload: Buffer, retained: boolean) => void;
}

const str = (body: Buffer, at: number): [Buffer, number] => {
  const len = body.readUInt16BE(at);
  if (at + 2 + len > body.length) throw new Error("MQTT string runs past its packet.");
  return [body.subarray(at + 2, at + 2 + len), at + 2 + len];
};

const parseConnect = (p: Incoming) => {
  const b = p.body;
  let at = 0;
  let name: Buffer;
  [name, at] = str(b, at);
  const level = b[at]!;
  const flags = b[at + 1]!;
  const keepAliveS = b.readUInt16BE(at + 2);
  at += 4;
  let clientId: Buffer;
  [clientId, at] = str(b, at);
  let will: { topic: string; payload: Buffer; retain: boolean } | null = null;
  if (flags & 0x04) {
    let topic: Buffer;
    let payload: Buffer;
    [topic, at] = str(b, at);
    [payload, at] = str(b, at);
    will = {
      topic: topic.toString("utf8"),
      payload: Buffer.from(payload),
      retain: (flags & 0x20) !== 0,
    };
  }
  let user = "";
  let pass = "";
  if (flags & 0x80) {
    let u: Buffer;
    [u, at] = str(b, at);
    user = u.toString("utf8");
  }
  if (flags & 0x40) pass = str(b, at)[0].toString("utf8");
  return {
    name: name.toString("utf8"),
    level,
    keepAliveS,
    clientId: clientId.toString("utf8"),
    will,
    user,
    pass,
  };
};

const connack = (code: number) => Buffer.from([0x20, 2, 0, code]);
const ack = (head: number, id: number) => Buffer.from([head, 2, id >> 8, id & 0xff]);

/**
 * The hub itself, with no sockets: tests drive it with bytes. `authenticate` says what a CONNECT's user and password
 * may do, or null for a refusal (CONNACK 5, then the socket closes).
 */
export const makeHub = (
  authenticate: (user: string, pass: string) => Effect.Effect<HubGrant | null>,
) => {
  const retained = new Map<string, Buffer>();
  const subscribers = new Set<Subscriber>();
  const sessions = new Map<string, { will: unknown; readonly close: () => void }>();

  const route = (topic: string, payload: Buffer, retain: boolean) => {
    if (retain) {
      if (payload.length === 0) retained.delete(topic);
      else if (retained.size < MAX_RETAINED || retained.has(topic)) retained.set(topic, payload);
    }
    for (const s of subscribers)
      if (s.filters.some((f) => topicMatches(f, topic))) s.deliver(topic, payload, false);
  };
  const sendRetained = (s: Subscriber, filters: ReadonlyArray<string>) => {
    for (const [topic, payload] of retained)
      if (filters.some((f) => topicMatches(f, topic))) s.deliver(topic, payload, true);
  };
  const toBuffer = (payload: string | Uint8Array) =>
    typeof payload === "string" ? Buffer.from(payload, "utf8") : Buffer.from(payload);

  /** The server's own subscriber: no socket, every R1 topic, retained messages first. */
  const attach = (
    filters: ReadonlyArray<string>,
    onMessage: (topic: string, payload: Buffer) => void,
  ): HubLink => {
    const sub: Subscriber = { filters: [...filters], deliver: (t, p) => onMessage(t, p) };
    subscribers.add(sub);
    sendRetained(sub, filters);
    return {
      publish: (topic, payload, retain = false) => route(topic, toBuffer(payload), retain),
      connected: () => true,
      close: () => void subscribers.delete(sub),
    };
  };

  const open = (io: {
    readonly send: (bytes: Uint8Array) => void;
    readonly close: () => void;
  }): HubSession => {
    const decode = createDecoder(MAX_PACKET);
    let grant: HubGrant | null = null;
    let clientId = "";
    let keepAliveS = 0;
    let ended = false;
    const self = {
      will: null as { topic: string; payload: Buffer; retain: boolean } | null,
      close: () => {
        ended = true;
        io.close();
      },
    };
    const sub: Subscriber = {
      filters: [],
      deliver: (topic, payload, retained) => io.send(publishPacket(topic, payload, retained)),
    };
    const end = () => {
      self.will = null;
      self.close();
    };

    // Untraced: it runs for every voice frame, 16 a second per R1.
    const handle = Effect.fnUntraced(function* (p: Incoming) {
      if (grant === null) {
        if (p.type !== 1) return end();
        const c = parseConnect(p);
        if (c.name !== "MQTT" || c.level !== 4) {
          io.send(connack(1));
          return end();
        }
        const given = yield* authenticate(c.user, c.pass);
        if (given === null || (c.will !== null && !hubAllows(given, c.will.topic))) {
          io.send(connack(5));
          return end();
        }
        // The same client id again (the R1 reconnecting before its old socket timed out): the new one wins, and the
        // old one's will is dropped so it cannot mark the device offline after it came back.
        const before = c.clientId === "" ? undefined : sessions.get(c.clientId);
        if (before !== undefined) {
          before.will = null;
          before.close();
        }
        grant = given;
        clientId = c.clientId === "" ? NodeCrypto.randomUUID() : c.clientId;
        keepAliveS = c.keepAliveS;
        self.will = c.will;
        sessions.set(clientId, self);
        subscribers.add(sub);
        io.send(connack(0));
        return;
      }
      const g = grant;
      switch (p.type) {
        case 3: {
          const qos = (p.flags >> 1) & 3;
          if (qos === 2) return end();
          const [t, at] = str(p.body, 0);
          const topic = t.toString("utf8");
          if (qos === 1) io.send(ack(0x40, p.body.readUInt16BE(at)));
          // A topic a login may not use is dropped quietly, as mosquitto does.
          if (hubAllows(g, topic) && !/[+#]/.test(topic))
            route(
              topic,
              Buffer.from(p.body.subarray(at + (qos === 1 ? 2 : 0))),
              (p.flags & 1) === 1,
            );
          return;
        }
        case 8: {
          const id = p.body.readUInt16BE(0);
          const codes: Array<number> = [];
          const added: Array<string> = [];
          for (let at = 2; at < p.body.length;) {
            const [f, next] = str(p.body, at);
            at = next + 1;
            const filter = f.toString("utf8");
            if (hubAllows(g, filter)) {
              added.push(filter);
              codes.push(0);
            } else codes.push(0x80);
          }
          sub.filters.push(...added);
          io.send(
            packet(0x90, Buffer.concat([Buffer.from([id >> 8, id & 0xff]), Buffer.from(codes)])),
          );
          sendRetained(sub, added);
          return;
        }
        case 10: {
          const id = p.body.readUInt16BE(0);
          for (let at = 2; at < p.body.length;) {
            const [f, next] = str(p.body, at);
            at = next;
            const i = sub.filters.indexOf(f.toString("utf8"));
            if (i >= 0) sub.filters.splice(i, 1);
          }
          io.send(ack(0xb0, id));
          return;
        }
        case 12:
          io.send(Buffer.from([0xd0, 0]));
          return;
        case 14:
          return end();
        default:
          return end();
      }
    });

    return {
      receive: (chunk) =>
        Effect.suspend(() => {
          if (ended) return Effect.void;
          const packets = decode(Buffer.from(chunk));
          return Effect.forEach(packets, (p) => (ended ? Effect.void : handle(p)), {
            discard: true,
          });
        }).pipe(Effect.catchDefect(() => Effect.sync(end))),
      gone: () => {
        ended = true;
        subscribers.delete(sub);
        if (sessions.get(clientId) === self) sessions.delete(clientId);
        const will = self.will;
        self.will = null;
        if (will !== null) route(will.topic, will.payload, will.retain);
      },
      idleMs: () => (grant === null ? 10_000 : keepAliveS === 0 ? 3_600_000 : keepAliveS * 1_500),
    };
  };

  /** One message from the server itself, as if a bus client had sent it. */
  const publish = (topic: string, payload: string | Uint8Array, retain = false) =>
    route(topic, toBuffer(payload), retain);

  return { attach, open, publish };
};

export type Hub = ReturnType<typeof makeHub>;

export class R1Hub extends Context.Service<
  R1Hub,
  Hub & {
    /** The bus login for the room loop or another server; the key is made on first ask and kept in the secret store. */
    readonly busLogin: Effect.Effect<{ readonly user: string; readonly key: string }>;
  }
>()("t3/home/R1Hub") {}

const digest = (s: string) => NodeCrypto.createHash("sha256").update(s).digest();
const sameKey = (given: string, expected: string) =>
  given !== "" && NodeCrypto.timingSafeEqual(digest(given), digest(expected));

/** What an R1 logs in with: its device key, or the password it already had on a broker of its own (adopted). */
export const deviceGrant = (
  device: R1Device | null,
  user: string,
  pass: string,
): HubGrant | null =>
  device?.deviceId === user &&
  DEVICE_ID.test(user) &&
  (sameKey(pass, device.deviceKey) ||
    (device.devicePass != null && sameKey(pass, device.devicePass)))
    ? { kind: "device", id: user }
    : null;

export const layer = Layer.effect(
  R1Hub,
  Effect.gen(function* () {
    const home = yield* HomeAssistantService;
    const secrets = yield* ServerSecretStore;
    const busKey = secrets.getOrCreateRandom(BUS_SECRET, 32).pipe(
      Effect.map((bytes) => Buffer.from(bytes).toString("hex")),
      Effect.option,
    );
    const hub = makeHub((user, pass) =>
      user === R1_BUS_USER
        ? Effect.map(busKey, (key) =>
            Option.isSome(key) && sameKey(pass, key.value) ? { kind: "bus" as const } : null,
          )
        : Effect.map(home.device, (device) => deviceGrant(device, user, pass)),
    );
    const tcp = yield* Config.String("TESSAYA_R1_MQTT_TCP").pipe(
      Config.withDefault(""),
      Effect.orDie,
    );
    if (tcp !== "") {
      const bind = tcpBind(tcp);
      if (bind === null)
        yield* Effect.logWarning(
          "TESSAYA_R1_MQTT_TCP must be a loopback or private host:port; TCP is off",
          {
            setting: tcp,
          },
        );
      else
        yield* serveTcp(hub, bind).pipe(
          Effect.catchDefect((cause) => Effect.logWarning("R1 hub TCP is off", { cause })),
        );
    }
    return R1Hub.of({
      ...hub,
      busLogin: Effect.map(busKey, (key) => ({
        user: R1_BUS_USER,
        key: Option.getOrElse(key, () => ""),
      })),
    });
  }),
);

/** `host:port` for plain TCP: only loopback or a private address, never a wildcard or a public one. */
export const tcpBind = (
  setting: string,
): { readonly host: string; readonly port: number } | null => {
  const m = /^(.+):(\d{1,5})$/.exec(setting.trim());
  if (m === null) return null;
  const host = m[1]!;
  const port = Number(m[2]);
  return port > 0 &&
    port < 65_536 &&
    host !== "0.0.0.0" &&
    (host === "localhost" ||
      host.startsWith("127.") ||
      host === "::1" ||
      isPrivateNetworkAddress(host))
    ? { host, port }
    : null;
};

/**
 * The same hub over plain TCP MQTT, when `TESSAYA_R1_MQTT_TCP` names where (`127.0.0.1:1884`): for a mosquitto bridge
 * during a migration, or a room loop on this machine. Same logins and topic rules as the WebSocket.
 */
export const serveTcp = Effect.fn("R1Hub.serveTcp")(function* (
  hub: Pick<Hub, "open">,
  bind: { readonly host: string; readonly port: number },
) {
  const run = Effect.runPromiseWith(yield* Effect.context<never>());
  return yield* Effect.acquireRelease(
    Effect.callback<NodeNet.Server>((resume) => {
      const server = NodeNet.createServer((socket) => {
        socket.setNoDelay(true);
        const session = hub.open({
          send: (bytes) => void socket.write(bytes),
          close: () => socket.destroySoon(),
        });
        socket.setTimeout(session.idleMs());
        // One chunk at a time, in order, as the WebSocket's reader does.
        let chain = Promise.resolve();
        socket.on("data", (chunk) => {
          chain = chain
            .then(() => run(session.receive(chunk)))
            .then(() => {
              socket.setTimeout(session.idleMs());
            });
        });
        socket.on("timeout", () => socket.destroy());
        socket.on("error", () => socket.destroy());
        socket.on("close", () => void chain.then(session.gone));
      });
      server.once("error", (cause) =>
        resume(
          Effect.die(
            new Error(`R1 hub TCP could not listen on ${bind.host}:${bind.port}`, { cause }),
          ),
        ),
      );
      server.listen(bind.port, bind.host, () => resume(Effect.succeed(server)));
    }),
    (server) => Effect.sync(() => void server.close()),
  ).pipe(Effect.catchDefect((cause) => Effect.logWarning("R1 hub TCP is off", { cause })));
});

/** One WebSocket on the hub: reads in order, writes through a bounded queue (a stalled socket loses QoS 0 frames). */
export const runHubSocket = Effect.fn("R1Hub.runSocket")(function* (
  socket: Socket.Socket,
  hub: Pick<Hub, "open">,
) {
  const writer = yield* socket.writer;
  const reader = yield* socket.reader;
  const out = yield* Queue.bounded<Uint8Array>(512);
  const closed = Deferred.makeUnsafe<void>();
  const session = hub.open({
    send: (bytes) => void Queue.offerUnsafe(out, bytes),
    close: () => void Deferred.doneUnsafe(closed, Effect.void),
  });
  const read = Effect.forever(
    Effect.gen(function* () {
      const frames = yield* reader.pull.pipe(Effect.timeout(session.idleMs()));
      for (const frame of frames)
        yield* session.receive(typeof frame === "string" ? Buffer.from(frame) : frame);
    }),
  );
  const write = Effect.forever(Effect.flatMap(Queue.take(out), (bytes) => writer.write(bytes)));
  yield* Effect.raceFirst(read, Effect.raceFirst(write, Deferred.await(closed))).pipe(
    Effect.ignore,
  );
  // What the hub said last (a refusal) goes out before the close.
  for (const bytes of yield* Queue.clear(out)) yield* writer.write(bytes).pipe(Effect.ignore);
  session.gone();
  yield* writer.write(new Socket.CloseEvent(1000)).pipe(Effect.ignore);
});

/**
 * One publish to an R1, from code that only has its record: this server's hub when the record names no broker,
 * otherwise a fresh connection to the broker it names (`mqtt://`, `ws://` or `wss://`).
 */
export const publishToDevice = (
  device: R1Device,
  topic: string,
  payload: string,
  retain = false,
): Effect.Effect<void> =>
  device.mqttUrl === null
    ? Effect.flatMap(Effect.serviceOption(R1Hub), (hub) =>
        Effect.sync(() => {
          if (Option.isSome(hub)) hub.value.publish(topic, payload, retain);
        }),
      )
    : Effect.callback<void>((resume) => {
        const cancel = publishOnce(
          {
            url: device.mqttUrl!,
            ...(device.mqttUser === null ? {} : { user: device.mqttUser }),
            ...(device.mqttPass === null ? {} : { pass: device.mqttPass }),
            topic,
            payload,
            retain,
          },
          () => resume(Effect.void),
        );
        return Effect.sync(cancel);
      });
