// @effect-diagnostics nodeBuiltinImport:off
import type * as NodeNet from "node:net";

import { describe, expect, it } from "vite-plus/test";

import {
  BUSY_QUEUE,
  frame,
  readFrame,
  startRoomRecognizer,
  tailnetAddress,
} from "./roomRecognizer.ts";

const TOKEN = "t".repeat(32);

const serve = (busy: () => boolean, transcribe: (pcm: Int16Array) => Promise<string>) => {
  const room = startRoomRecognizer({ host: "127.0.0.1", port: 0, token: TOKEN, busy, transcribe });
  const port = () => (room.address() as NodeNet.AddressInfo).port;
  return { room, port };
};

/** A client as the room loop makes one; resolves with each message in order. */
const connect = (port: number, token = TOKEN) =>
  new Promise<{ ws: WebSocket; next: () => Promise<Record<string, unknown>> }>(
    (resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
        headers: { authorization: `Bearer ${token}` },
      } as unknown as string[]);
      const queue: Array<Record<string, unknown>> = [];
      const waiting: Array<(m: Record<string, unknown>) => void> = [];
      ws.addEventListener("message", (e) => {
        const m = JSON.parse(String(e.data)) as Record<string, unknown>;
        const w = waiting.shift();
        if (w) w(m);
        else queue.push(m);
      });
      ws.addEventListener("open", () =>
        resolve({
          ws,
          next: () =>
            queue.length > 0
              ? Promise.resolve(queue.shift()!)
              : new Promise((r) => waiting.push(r)),
        }),
      );
      ws.addEventListener("error", () => reject(new Error("refused")));
    },
  );

describe("the room's recogniser on this computer", () => {
  it("hears a request through this computer's model and answers in the server recogniser's shape", async () => {
    const got: Int16Array[] = [];
    const s = serve(
      () => false,
      async (pcm) => {
        got.push(pcm);
        return "turn on the study light";
      },
    );
    await s.room.ready;
    const c = await connect(s.port());
    c.ws.send(JSON.stringify({ cmd: "begin", language: "en" }));
    c.ws.send(new Int16Array([1, 2, 3, 4]));
    c.ws.send(new Int16Array(70_000).fill(7));
    c.ws.send(JSON.stringify({ cmd: "end" }));
    const m = await c.next();
    expect(m).toMatchObject({ ev: "text", text: "turn on the study light", pieces: 1 });
    expect(got[0]!.length).toBe(70_004);
    expect(Array.from(got[0]!.subarray(0, 4))).toEqual([1, 2, 3, 4]);
    c.ws.close();
    s.room.close();
  });

  it("turns the room away while he is using voice here, and says so in its health", async () => {
    const s = serve(
      () => true,
      async () => "",
    );
    await s.room.ready;
    const c = await connect(s.port());
    c.ws.send(JSON.stringify({ cmd: "health" }));
    expect(await c.next()).toEqual({ ev: "health", queue: BUSY_QUEUE, busy: true });
    c.ws.send(JSON.stringify({ cmd: "begin" }));
    expect(await c.next()).toEqual({ ev: "error", message: "busy" });
    c.ws.close();
    s.room.close();
  });

  it("refuses a connection without his token", async () => {
    const s = serve(
      () => false,
      async () => "",
    );
    await s.room.ready;
    await expect(connect(s.port(), "wrong")).rejects.toThrow("refused");
    s.room.close();
  });
});

describe("its WebSocket frames", () => {
  it("reads a masked client frame of each length form and writes server frames back", () => {
    for (const size of [5, 300, 70_000]) {
      const payload = Buffer.alloc(size, 3);
      const mask = Buffer.from([1, 2, 3, 4]);
      const head =
        size < 126
          ? Buffer.from([0x82, 0x80 | size])
          : size < 65_536
            ? Buffer.from([0x82, 0x80 | 126, size >> 8, size & 255])
            : Buffer.concat([Buffer.from([0x82, 0x80 | 127]), Buffer.alloc(8)]);
      if (size >= 65_536) head.writeBigUInt64BE(BigInt(size), 2);
      const body = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]!));
      const whole = Buffer.concat([head, mask, body]);
      expect(readFrame(whole.subarray(0, whole.length - 1))).toBeNull();
      const f = readFrame(whole)!;
      expect([f.op, f.size, f.payload.equals(payload)]).toEqual([2, whole.length, true]);
      const back = frame(0x2, payload);
      expect(back.subarray(back.length - size).equals(payload)).toBe(true);
    }
  });

  it("finds his Tailscale address and nothing else", () => {
    const iface = (address: string, internal = false) => ({
      address,
      family: "IPv4" as const,
      internal,
      netmask: "255.255.255.0",
      mac: "00:00:00:00:00:00",
      cidr: null,
    });
    expect(tailnetAddress({ eth: [iface("192.168.1.4")], ts: [iface("100.101.2.3")] })).toBe(
      "100.101.2.3",
    );
    expect(tailnetAddress({ eth: [iface("192.168.1.4"), iface("100.20.1.1")] })).toBeNull();
  });
});
