// @effect-diagnostics nodeBuiltinImport:off
/**
 * The desktop's recogniser for its own server (apps/server/src/speech/TessayaVoice.ts): when a phone or a browser
 * dictates to this machine, the server hands the audio here, so it is heard on the graphics card by the same
 * `tessaya-voice` as a dictation key. A local pipe (a socket file off Windows), named with a fresh token at each start
 * and told only to the server this app starts.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const id = NodeCrypto.randomUUID();
/** The same for the server's environment and the app; `platform` as `process.platform` says it. */
const pathFor = (platform: string) =>
  platform === "win32"
    ? `\\\\.\\pipe\\tessaya-voice-${id}`
    : NodePath.join(NodeOS.tmpdir(), `tessaya-voice-${id}.sock`);
const TOKEN = NodeCrypto.randomBytes(32).toString("hex");
/** Five minutes of 16 kHz mono Float32, the server's own limit. */
const MAX_BYTES = 16_000 * 4 * 300;

/** For the server's environment; it answers T3's model in place of the desktop's while the door is shut. */
export const voiceDoorEnv = (platform: string) => ({
  TESSAYA_VOICE_DOOR: pathFor(platform),
  TESSAYA_VOICE_DOOR_TOKEN: TOKEN,
});

const authorized = (header: string | undefined) => {
  const given = Buffer.from(header ?? "");
  const wanted = Buffer.from(`Bearer ${TOKEN}`);
  return given.length === wanted.length && NodeCrypto.timingSafeEqual(given, wanted);
};

/** The server's Float32 samples as the recogniser's 16-bit ones. */
const toInt16 = (bytes: Buffer): Int16Array => {
  const floats = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 2);
  return Int16Array.from(floats, (s) => Math.round(Math.max(-1, Math.min(1, s)) * 32767));
};

/** Opens the door. `hear` answers null while the recogniser is absent or busy, and the server uses T3's model. */
export const openVoiceDoor = (
  platform: string,
  hear: (pcm: Int16Array) => Promise<string | null>,
) => {
  const path = pathFor(platform);
  const windows = platform === "win32";
  const server = NodeHttp.createServer((request, response) => {
    const reply = (status: number, body?: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(body === undefined ? undefined : JSON.stringify(body));
    };
    if (request.method !== "POST" || request.url !== "/transcribe") return reply(404);
    if (!authorized(request.headers.authorization)) return reply(401);
    const parts: Buffer[] = [];
    let size = 0;
    request.on("data", (part: Buffer) => {
      size += part.byteLength;
      if (size > MAX_BYTES) request.destroy();
      else parts.push(part);
    });
    request.on("end", () => {
      const bytes = Buffer.concat(parts);
      if (bytes.byteLength === 0 || bytes.byteLength % 4 !== 0) return reply(400);
      hear(toInt16(bytes)).then(
        (text) => (text === null ? reply(503) : reply(200, { text })),
        () => reply(503),
      );
    });
  });
  if (!windows) NodeFS.rmSync(path, { force: true });
  server.on("error", () => undefined);
  const ready = new Promise<void>((resolve) => server.listen(path, resolve));
  return {
    ready,
    close: () => {
      server.close();
      if (!windows) NodeFS.rmSync(path, { force: true });
    },
  };
};
