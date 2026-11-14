// @effect-diagnostics globalDate:off nodeBuiltinImport:off
/**
 * The R1's room loop (packages/tessaya-voice/src/room) may hear his speech through this computer's recogniser, the
 * one dictation already keeps loaded (on the graphics card when he chose it), as one more of his recognisers. It
 * speaks native/tessaya-recognizer's protocol, listens only on his Tailscale address, asks for a token, and turns
 * the room away while he dictates or talks to Tessaya here: the room then uses its own host.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import type * as NodeStream from "node:stream";

export const ROOM_RECOGNIZER_PORT = 8797;
/** The longest request taken (120 s at 16 kHz), as the server recogniser. */
const MAX_SAMPLES = 120 * 16_000;
/** What health reports while he is using voice here, so the room picks another recogniser. */
export const BUSY_QUEUE = 9;

/** This computer's Tailscale address (the shared range Tailscale assigns from, RFC 6598), or null off his tailnet. */
export const tailnetAddress = (
  interfaces: ReturnType<typeof NodeOS.networkInterfaces> = NodeOS.networkInterfaces(),
): string | null => {
  for (const list of Object.values(interfaces)) {
    for (const a of list ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      const [x, y] = a.address.split(".").map(Number);
      if (x === 100 && y !== undefined && y >= 64 && y <= 127) return a.address;
    }
  }
  return null;
};

/** One whole client frame (masked, unfragmented: all the room loop sends), or null until it has all arrived. */
export const readFrame = (
  buf: Buffer,
): { readonly op: number; readonly payload: Buffer; readonly size: number } | null => {
  if (buf.length < 2) return null;
  const op = buf[0]! & 0x0f;
  const masked = (buf[1]! & 0x80) !== 0;
  let len = buf[1]! & 0x7f;
  let at = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    at = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    len = Number(buf.readBigUInt64BE(2));
    at = 10;
  }
  const maskAt = at;
  if (masked) at += 4;
  if (buf.length < at + len) return null;
  const payload = Buffer.from(buf.subarray(at, at + len));
  if (masked) for (let i = 0; i < len; i += 1) payload[i]! ^= buf[maskAt + (i % 4)]!;
  return { op, payload, size: at + len };
};

/** A server frame (unmasked, whole). */
export const frame = (op: number, payload: Buffer): Buffer => {
  const head =
    payload.length < 126
      ? Buffer.from([0x80 | op, payload.length])
      : payload.length < 65_536
        ? Buffer.concat([Buffer.from([0x80 | op, 126]), Buffer.alloc(2)])
        : Buffer.concat([Buffer.from([0x80 | op, 127]), Buffer.alloc(8)]);
  if (payload.length >= 126 && payload.length < 65_536) head.writeUInt16BE(payload.length, 2);
  else if (payload.length >= 65_536) head.writeBigUInt64BE(BigInt(payload.length), 2);
  return Buffer.concat([head, payload]);
};

const sameToken = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && NodeCrypto.timingSafeEqual(x, y);
};

export interface RoomRecognizerOptions {
  readonly host: string;
  readonly port?: number;
  readonly token: string;
  /** He is dictating or talking to Tessaya here: the room is turned away. */
  readonly busy: () => boolean;
  /** Whole-utterance recognition of 16 kHz mono PCM on this computer's loaded model. */
  readonly transcribe: (pcm: Int16Array) => Promise<string>;
  readonly log?: (line: string) => void;
}

/** Serves the room's requests one at a time; `close` stops listening and drops open connections. */
export const startRoomRecognizer = (options: RoomRecognizerOptions) => {
  let working = false;
  const sockets = new Set<NodeStream.Duplex>();
  const server = NodeHttp.createServer((_req, res) => {
    res.writeHead(426).end();
  });
  server.on("upgrade", (req, socket: NodeStream.Duplex) => {
    const bearer = String(req.headers["authorization"] ?? "").replace(/^Bearer\s+/i, "");
    const key = req.headers["sec-websocket-key"];
    if (typeof key !== "string" || !sameToken(bearer, options.token)) {
      socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return;
    }
    const accept = NodeCrypto.createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    sockets.add(socket);
    const send = (value: unknown) => {
      if (!socket.destroyed) socket.write(frame(0x1, Buffer.from(JSON.stringify(value))));
    };
    let pending = Buffer.alloc(0);
    let heard: Buffer[] | null = null;
    let samples = 0;
    let mine = false;
    const finish = () => {
      if (mine) working = false;
      mine = false;
      heard = null;
    };
    const onText = (text: string) => {
      const cmd = (() => {
        try {
          return String((JSON.parse(text) as { cmd?: unknown }).cmd ?? "");
        } catch {
          return "";
        }
      })();
      if (cmd === "health") {
        const busy = options.busy() || working;
        send({ ev: "health", queue: busy ? BUSY_QUEUE : 0, busy });
      } else if (cmd === "begin") {
        if (options.busy() || working) {
          send({ ev: "error", message: "busy" });
          return;
        }
        working = true;
        mine = true;
        heard = [];
        samples = 0;
      } else if (cmd === "end") {
        const chunks = heard;
        if (chunks === null) {
          send({ ev: "error", message: "no recording" });
          return;
        }
        heard = null;
        const bytes = Buffer.concat(chunks);
        const pcm = new Int16Array(
          Uint8Array.from(bytes.subarray(0, bytes.length - (bytes.length % 2))).buffer,
        );
        const started = Date.now();
        void options
          .transcribe(pcm)
          .then(
            (words) =>
              send({
                ev: "text",
                text: words,
                inferMs: Date.now() - started,
                pieces: 1,
                reused: false,
                releaseMs: Date.now() - started,
              }),
            (error: unknown) =>
              send({ ev: "error", message: error instanceof Error ? error.message : "failed" }),
          )
          .finally(finish);
      }
    };
    socket.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      for (let f = readFrame(pending); f !== null; f = readFrame(pending)) {
        pending = pending.subarray(f.size);
        if (f.op === 0x1) onText(f.payload.toString("utf8"));
        else if (f.op === 0x2 && heard !== null) {
          samples += f.payload.length / 2;
          if (samples > MAX_SAMPLES) {
            send({ ev: "error", message: "too long" });
            finish();
          } else heard.push(f.payload);
        } else if (f.op === 0x9) socket.write(frame(0xa, f.payload));
        else if (f.op === 0x8) socket.end(frame(0x8, Buffer.alloc(0)));
      }
    });
    const gone = () => {
      sockets.delete(socket);
      // A request whose client left frees the recogniser at once; one still decoding frees it when done.
      if (heard !== null && mine) finish();
    };
    socket.on("close", gone);
    socket.on("error", gone);
  });
  const ready = new Promise<void>((resolve) => server.once("listening", () => resolve()));
  server.listen(options.port ?? ROOM_RECOGNIZER_PORT, options.host);
  server.on("error", (error) => options.log?.(`room recogniser: ${error.message}`));
  return {
    close: () => {
      for (const s of sockets) s.destroy();
      server.close();
    },
    address: () => server.address(),
    ready,
  };
};
