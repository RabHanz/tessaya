// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off globalConsole:off
/**
 * `node replay.mjs <16 kHz wavs>`: his recordings to the running loop in real time as a pretend R1 (`replay-1`), then
 * end-of-voice to first-sound per clip and p50/p90. It shares the live loop: run it after 10 quiet minutes in the
 * loop's log; it refuses, or stops at once, when a real R1 sends audio or an event (online alone is not use).
 */
import * as NodeFS from "node:fs";

import { DOWN_FRAME_BYTES, fromBytes, toBytes } from "./audio.ts";
import { connectMqtt } from "@t3tools/baton-shared/mqtt";
import { realDeviceActivity } from "./mqtt.ts";

const env = (key: string, fallback?: string): string => {
  const v = process.env[key] ?? fallback;
  if (v === undefined) throw new Error(`${key} is not set`);
  return v;
};
const now = () => performance.timeOrigin + performance.now();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FRAME_MS = DOWN_FRAME_BYTES / 32;

const readWav = (path: string): Int16Array => {
  const b = NodeFS.readFileSync(path);
  const at = b.indexOf("data");
  return fromBytes(b.subarray(at + 8));
};

/** Where his voice ends in the clip: the last 60 ms frame above a tenth of the loudest one (his mics differ in level). */
const lastVoicedMs = (pcm: Int16Array): number => {
  const n = DOWN_FRAME_BYTES / 2;
  const rms: number[] = [];
  for (let s = 0; s + n <= pcm.length; s += n) {
    let sum = 0;
    for (let i = s; i < s + n; i += 1) sum += pcm[i]! * pcm[i]!;
    rms.push(Math.sqrt(sum / n));
  }
  const floor = Math.max(60, 0.1 * Math.max(0, ...rms));
  const last = rms.findLastIndex((r) => r > floor);
  return (((last + 1) * n) / 16_000) * 1000;
};

const pct = (xs: number[], p: number) => {
  const s = xs.toSorted((a, b) => a - b);
  return s.length === 0 ? null : s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
};

const main = async () => {
  const id = env("R1_REPLAY_DEVICE", "replay-1");
  let busy: string | null = null;
  let firstDown: number | null = null;
  let lastDown = 0;
  let metrics: Record<string, unknown> | null = null;
  // Only what comes after his voice ends counts: a reply to an earlier piece of the clip (he paused) is not the answer.
  let voiceEndAt = Number.POSITIVE_INFINITY;
  const mqtt = connectMqtt({
    url:
      process.env["R1_MQTT_URL"] || `mqtt://${env("R1_MQTT_HOST")}:${env("R1_MQTT_PORT", "1883")}`,
    clientId: `tessaya-replay-${process.pid}`,
    user: env("R1_MQTT_USER"),
    pass: NodeFS.readFileSync(env("R1_MQTT_PASS_FILE"), "utf8").trim(),
    subscribe: [
      `freya/r1/${id}/voice/down`,
      `freya/r1/${id}/event/voice/metrics`,
      "freya/r1/+/state/online",
      "freya/r1/+/voice/up",
      "freya/r1/+/event/#",
    ],
    onMessage: (t, p) => {
      busy ??= realDeviceActivity(t, String(p), id);
      if (!t.startsWith(`freya/r1/${id}/`)) return;
      if (now() < voiceEndAt) return;
      if (t.endsWith("/voice/down")) {
        firstDown ??= now();
        lastDown = now();
      } else if (t.endsWith("/event/voice/metrics"))
        metrics = JSON.parse(String(p)) as Record<string, unknown>;
    },
    log: () => undefined,
  });
  while (!mqtt.connected()) await sleep(50);
  // Retained online states arrive just after subscribing.
  await sleep(1_500);
  if (busy !== null) {
    console.log(JSON.stringify({ refused: `${busy}; a replay would share the loop with him` }));
    mqtt.close();
    process.exit(2);
  }
  const silence = new Int16Array(DOWN_FRAME_BYTES / 2);
  const results: number[] = [];
  for (const path of process.argv.slice(2)) {
    mqtt.publish(`freya/r1/${id}/cmd/voice/start`, "{}");
    await sleep(300);
    const pcm = readWav(path);
    const voicedMs = lastVoicedMs(pcm);
    firstDown = null;
    metrics = null;
    const t0 = now();
    // Half a second of room first, then the clip, then room tone until she has answered and gone quiet.
    const frames = [
      ...Array.from({ length: 8 }, () => silence),
      ...Array.from({ length: Math.ceil(pcm.length / silence.length) }, (_, i) =>
        pcm.subarray(i * silence.length, (i + 1) * silence.length),
      ),
    ];
    voiceEndAt = Number.POSITIVE_INFINITY;
    for (let i = 0; ; i += 1) {
      const frame = i < frames.length ? frames[i]! : silence;
      const padded = new Int16Array(silence.length);
      padded.set(frame);
      mqtt.publish(`freya/r1/${id}/voice/up`, toBytes(padded));
      if (i === 8 + Math.ceil(voicedMs / FRAME_MS) - 1) voiceEndAt = now();
      const due = t0 + (i + 1) * FRAME_MS;
      await sleep(Math.max(0, due - now()));
      const quietSince = firstDown === null ? 0 : now() - lastDown;
      if (metrics !== null && firstDown !== null && quietSince > 1_500) break;
      if (now() - t0 > frames.length * FRAME_MS + 30_000) break;
      if (busy !== null) break;
    }
    if (busy !== null) {
      mqtt.publish(`freya/r1/${id}/cmd/voice/stop`, "{}");
      console.log(JSON.stringify({ stopped: `${busy}; the replay gave the loop back to him` }));
      mqtt.close();
      process.exit(2);
    }
    const firstSoundMs = firstDown === null ? null : Math.round(firstDown - voiceEndAt);
    if (firstSoundMs !== null) results.push(firstSoundMs);
    console.log(
      JSON.stringify({
        clip: path.split("/").pop(),
        voicedMs: Math.round(voicedMs),
        firstSoundMs,
        loop: metrics,
      }),
    );
    mqtt.publish(`freya/r1/${id}/cmd/voice/stop`, "{}");
    await sleep(500);
  }
  console.log(JSON.stringify({ n: results.length, p50: pct(results, 50), p90: pct(results, 90) }));
  mqtt.close();
};

void main();
