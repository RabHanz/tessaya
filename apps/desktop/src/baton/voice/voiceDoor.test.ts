// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";

import { expect, it } from "vite-plus/test";

import { openVoiceDoor, voiceDoorEnv } from "./voiceDoor.ts";

// A pipe on Windows, a socket file elsewhere: what this machine can listen on.
const PLATFORM = NodePath.sep === "\\" ? "win32" : "linux";

const post = (authorization: string, body: Buffer) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = NodeHttp.request(
      {
        socketPath: voiceDoorEnv(PLATFORM).TESSAYA_VOICE_DOOR,
        path: "/transcribe",
        method: "POST",
        headers: { authorization },
      },
      (response) => {
        const parts: Buffer[] = [];
        response.on("data", (part: Buffer) => parts.push(part));
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(parts).toString() }),
        );
      },
    );
    request.on("error", reject);
    request.end(body);
  });

it("hears the server's audio only with its token, and says when it is busy", async () => {
  const heard: Int16Array[] = [];
  let busy = false;
  const door = openVoiceDoor(PLATFORM, async (pcm) => {
    heard.push(pcm);
    return busy ? null : "hello there";
  });
  await door.ready;
  try {
    const audio = Buffer.from(new Float32Array([0.5, -1, 2]).buffer);
    const token = `Bearer ${voiceDoorEnv(PLATFORM).TESSAYA_VOICE_DOOR_TOKEN}`;
    expect((await post("Bearer wrong", audio)).status).toBe(401);
    expect(heard).toHaveLength(0);
    expect(await post(token, audio)).toEqual({ status: 200, body: '{"text":"hello there"}' });
    expect([...heard[0]!]).toEqual([16384, -32767, 32767]);
    busy = true;
    expect((await post(token, audio)).status).toBe(503);
  } finally {
    door.close();
  }
});
