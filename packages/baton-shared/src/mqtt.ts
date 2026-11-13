// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
/**
 * The smallest MQTT 3.1.1 client the R1's helpers need: QoS 0 publish and subscribe, keep-alive pings, and a reconnect
 * with back-off. Voice frames are QoS 0 on purpose: a late 60 ms frame is worth less than none. One codec for the room
 * loop and the server, over TCP (`mqtt://host:port`) or a WebSocket with the `mqtt` subprotocol (`ws://`, `wss://`), as
 * the R1 itself speaks it to the server's `/api/r1/mqtt`.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";

const str = (s: string): Buffer => {
  const b = Buffer.from(s, "utf8");
  const len = Buffer.alloc(2);
  len.writeUInt16BE(b.length);
  return Buffer.concat([len, b]);
};

const remaining = (n: number): Buffer => {
  const out: number[] = [];
  do {
    let byte = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) byte |= 0x80;
    out.push(byte);
  } while (n > 0);
  return Buffer.from(out);
};

export const packet = (head: number, body: Buffer): Buffer =>
  Buffer.concat([Buffer.from([head]), remaining(body.length), body]);

export const connectPacket = (input: {
  readonly clientId: string;
  readonly user?: string;
  readonly pass?: string;
  readonly keepAliveS: number;
}): Buffer => {
  const flags =
    0x02 | (input.user === undefined ? 0 : 0x80) | (input.pass === undefined ? 0 : 0x40);
  const keep = Buffer.alloc(2);
  keep.writeUInt16BE(input.keepAliveS);
  return packet(
    0x10,
    Buffer.concat([
      str("MQTT"),
      Buffer.from([4, flags]),
      keep,
      str(input.clientId),
      ...(input.user === undefined ? [] : [str(input.user)]),
      ...(input.pass === undefined ? [] : [str(input.pass)]),
    ]),
  );
};

export const subscribePacket = (id: number, topics: ReadonlyArray<string>): Buffer => {
  const pid = Buffer.alloc(2);
  pid.writeUInt16BE(id);
  return packet(0x82, Buffer.concat([pid, ...topics.flatMap((t) => [str(t), Buffer.from([0])])]));
};

export const publishPacket = (topic: string, payload: Uint8Array, retain = false): Buffer =>
  packet(retain ? 0x31 : 0x30, Buffer.concat([str(topic), payload]));

export const DISCONNECT = Buffer.from([0xe0, 0]);

export interface Incoming {
  readonly type: number;
  readonly flags: number;
  readonly body: Buffer;
}

/**
 * Splits a byte stream into whole packets; keeps a partial one for the next chunk. A packet longer than `maxBytes`
 * throws, so a peer cannot make it buffer without end.
 */
export const createDecoder = (maxBytes = Number.POSITIVE_INFINITY) => {
  let buf: Buffer = Buffer.alloc(0);
  return (chunk: Buffer): Incoming[] => {
    buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
    const out: Incoming[] = [];
    for (;;) {
      if (buf.length < 2) break;
      let len = 0;
      let i = 1;
      let shift = 0;
      let done = false;
      while (i < buf.length && i <= 4) {
        const b = buf[i++]!;
        len += (b & 0x7f) * 2 ** shift;
        shift += 7;
        if (b < 0x80) {
          done = true;
          break;
        }
      }
      if (done && len > maxBytes) throw new Error(`MQTT packet of ${len} bytes is too large.`);
      if (!done || buf.length < i + len) break;
      out.push({ type: buf[0]! >> 4, flags: buf[0]! & 0x0f, body: buf.subarray(i, i + len) });
      buf = buf.subarray(i + len);
    }
    return out;
  };
};

/** A PUBLISH body's topic and payload; QoS above 0 carries a packet id after the topic. */
export const parsePublish = (p: Incoming): { readonly topic: string; readonly payload: Buffer } => {
  const tlen = p.body.readUInt16BE(0);
  const topic = p.body.subarray(2, 2 + tlen).toString("utf8");
  const qos = (p.flags >> 1) & 3;
  return { topic, payload: p.body.subarray(2 + tlen + (qos > 0 ? 2 : 0)) };
};

/** MQTT topic filter match with `+` and a trailing `#`. */
export const topicMatches = (filter: string, topic: string): boolean => {
  const f = filter.split("/");
  const t = topic.split("/");
  for (let i = 0; i < f.length; i += 1) {
    if (f[i] === "#") return true;
    if (i >= t.length || (f[i] !== "+" && f[i] !== t[i])) return false;
  }
  return f.length === t.length;
};

interface Wire {
  readonly write: (bytes: Uint8Array) => void;
  readonly end: () => void;
}

/** One connection to `url`: TCP for `mqtt://`, a WebSocket with the `mqtt` subprotocol for `ws://` and `wss://`. */
const openWire = (
  url: string,
  on: {
    readonly open: () => void;
    readonly data: (chunk: Buffer) => void;
    readonly close: () => void;
  },
): Wire => {
  const u = new URL(url);
  if (u.protocol === "ws:" || u.protocol === "wss:") {
    const ws = new WebSocket(u, "mqtt");
    ws.binaryType = "arraybuffer";
    ws.addEventListener("open", on.open);
    ws.addEventListener("message", (e: MessageEvent) => {
      if (typeof e.data !== "string") on.data(Buffer.from(e.data as ArrayBuffer));
    });
    ws.addEventListener("close", on.close);
    return {
      write: (bytes) => {
        // Every buffer here is a Node Buffer over a plain ArrayBuffer.
        if (ws.readyState === WebSocket.OPEN) ws.send(bytes as Uint8Array<ArrayBuffer>);
      },
      end: () => ws.close(),
    };
  }
  const s = NodeNet.connect({ host: u.hostname, port: Number(u.port || 1883) });
  s.setNoDelay(true);
  s.on("connect", on.open);
  s.on("data", on.data);
  s.on("error", () => s.destroy());
  s.on("close", on.close);
  // destroySoon: what was written still goes out, then the socket is gone even if the peer never answers.
  return { write: (bytes) => void s.write(bytes), end: () => s.destroySoon() };
};

export interface MqttClient {
  readonly publish: (topic: string, payload: Uint8Array | string, retain?: boolean) => void;
  readonly connected: () => boolean;
  readonly close: () => void;
}

export const connectMqtt = (input: {
  /** `mqtt://host:port`, `ws://host:port/path` or `wss://host/path`. */
  readonly url: string;
  readonly clientId: string;
  readonly user?: string;
  readonly pass?: string;
  readonly subscribe: ReadonlyArray<string>;
  readonly onMessage: (topic: string, payload: Buffer) => void;
  readonly log: (line: string) => void;
}): MqttClient => {
  const KEEP_S = 30;
  let wire: Wire | null = null;
  let up = false;
  let closed = false;
  let backoff = 1_000;
  let ping: ReturnType<typeof setInterval> | null = null;
  const open = () => {
    if (closed) return;
    const decode = createDecoder();
    const w: Wire = openWire(input.url, {
      open: () =>
        w.write(
          connectPacket({
            clientId: input.clientId,
            keepAliveS: KEEP_S,
            ...(input.user === undefined ? {} : { user: input.user }),
            ...(input.pass === undefined ? {} : { pass: input.pass }),
          }),
        ),
      data: (chunk) => {
        for (const p of decode(chunk)) {
          if (p.type === 2) {
            if (p.body[1] !== 0) {
              input.log(`mqtt refused (code ${p.body[1]})`);
              w.end();
              return;
            }
            up = true;
            backoff = 1_000;
            w.write(subscribePacket(1, input.subscribe));
            ping = setInterval(() => w.write(Buffer.from([0xc0, 0])), (KEEP_S * 1000) / 2);
            input.log("mqtt connected");
          } else if (p.type === 3) {
            const { topic, payload } = parsePublish(p);
            input.onMessage(topic, payload);
          }
        }
      },
      close: () => {
        if (ping !== null) clearInterval(ping);
        ping = null;
        if (wire !== w) return;
        wire = null;
        up = false;
        if (closed) return;
        input.log(`mqtt down; retry in ${backoff} ms`);
        setTimeout(open, backoff);
        backoff = Math.min(backoff * 2, 30_000);
      },
    });
    wire = w;
  };
  open();
  return {
    publish: (topic, payload, retain) => {
      if (wire === null || !up) return;
      wire.write(
        publishPacket(topic, typeof payload === "string" ? Buffer.from(payload) : payload, retain),
      );
    },
    connected: () => up,
    close: () => {
      closed = true;
      wire?.write(DISCONNECT);
      wire?.end();
    },
  };
};

/**
 * One publish on a fresh connection: log in, publish once CONNACK says yes, disconnect. `done` gets whether it went
 * out; after 3 s it gets false. Returns a cancel.
 */
export const publishOnce = (
  input: {
    readonly url: string;
    readonly user?: string;
    readonly pass?: string;
    readonly topic: string;
    readonly payload: string;
    readonly retain?: boolean;
  },
  done: (sent: boolean) => void,
): (() => void) => {
  let settled = false;
  const finish = (sent: boolean) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    w.end();
    done(sent);
  };
  const decode = createDecoder();
  const w = openWire(input.url, {
    open: () =>
      w.write(
        connectPacket({
          clientId: `tessaya-${NodeCrypto.randomBytes(4).toString("hex")}`,
          keepAliveS: 30,
          ...(input.user === undefined ? {} : { user: input.user }),
          ...(input.pass === undefined ? {} : { pass: input.pass }),
        }),
      ),
    data: (chunk) => {
      const ack = decode(chunk).find((p) => p.type === 2);
      if (ack === undefined) return;
      if (ack.body[1] !== 0) return finish(false);
      w.write(
        Buffer.concat([
          publishPacket(input.topic, Buffer.from(input.payload), input.retain),
          DISCONNECT,
        ]),
      );
      finish(true);
    },
    close: () => finish(false),
  });
  const timer = setTimeout(() => finish(false), 3_000);
  return () => finish(false);
};
