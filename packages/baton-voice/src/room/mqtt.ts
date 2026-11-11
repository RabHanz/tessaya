// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
/**
 * The smallest MQTT 3.1.1 client the room needs: QoS 0 publish and subscribe over one TCP socket (the tailnet does the
 * encryption), keep-alive pings, and a reconnect with back-off. Voice frames are QoS 0 on purpose: a late 60 ms frame is
 * worth less than none.
 *
 * @module baton-voice/room/mqtt
 */
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

const packet = (head: number, body: Buffer): Buffer =>
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

export interface Incoming {
  readonly type: number;
  readonly flags: number;
  readonly body: Buffer;
}

/** Splits a byte stream into whole packets; keeps a partial one for the next chunk. */
export const createDecoder = () => {
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

export interface MqttClient {
  readonly publish: (topic: string, payload: Uint8Array | string, retain?: boolean) => void;
  readonly connected: () => boolean;
  readonly close: () => void;
}

export const connectMqtt = (input: {
  readonly host: string;
  readonly port: number;
  readonly clientId: string;
  readonly user?: string;
  readonly pass?: string;
  readonly subscribe: ReadonlyArray<string>;
  readonly onMessage: (topic: string, payload: Buffer) => void;
  readonly log: (line: string) => void;
}): MqttClient => {
  const KEEP_S = 30;
  let socket: NodeNet.Socket | null = null;
  let up = false;
  let closed = false;
  let backoff = 1_000;
  let ping: ReturnType<typeof setInterval> | null = null;
  const open = () => {
    if (closed) return;
    const s = NodeNet.connect({ host: input.host, port: input.port });
    socket = s;
    s.setNoDelay(true);
    const decode = createDecoder();
    s.on("connect", () => {
      const auth = { clientId: input.clientId, keepAliveS: KEEP_S };
      s.write(
        connectPacket({
          ...auth,
          ...(input.user === undefined ? {} : { user: input.user }),
          ...(input.pass === undefined ? {} : { pass: input.pass }),
        }),
      );
    });
    s.on("data", (chunk) => {
      for (const p of decode(chunk)) {
        if (p.type === 2) {
          if (p.body[1] !== 0) {
            input.log(`mqtt refused (code ${p.body[1]})`);
            s.destroy();
            return;
          }
          up = true;
          backoff = 1_000;
          s.write(subscribePacket(1, input.subscribe));
          ping = setInterval(() => s.write(Buffer.from([0xc0, 0])), (KEEP_S * 1000) / 2);
          input.log("mqtt connected");
        } else if (p.type === 3) {
          const { topic, payload } = parsePublish(p);
          input.onMessage(topic, payload);
        }
      }
    });
    const drop = () => {
      if (ping !== null) clearInterval(ping);
      ping = null;
      if (socket !== s) return;
      socket = null;
      up = false;
      if (closed) return;
      input.log(`mqtt down; retry in ${backoff} ms`);
      setTimeout(open, backoff);
      backoff = Math.min(backoff * 2, 30_000);
    };
    s.on("error", () => s.destroy());
    s.on("close", drop);
  };
  open();
  return {
    publish: (topic, payload, retain) => {
      if (socket === null || !up) return;
      socket.write(
        publishPacket(topic, typeof payload === "string" ? Buffer.from(payload) : payload, retain),
      );
    },
    connected: () => up,
    close: () => {
      closed = true;
      socket?.end(Buffer.from([0xe0, 0]));
    },
  };
};
