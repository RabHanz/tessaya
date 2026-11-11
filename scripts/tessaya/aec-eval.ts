// The barge-in measurement of bargein-eval.ts with WebRTC AEC3 (native/baton-aec) in place of the heuristic echo guard, real speech for
// both voices (the recorded fixtures), and Silero on the cleaned signal as the trigger.
// node scripts/tessaya/aec-eval.ts <path-to-aec-eval> [seconds-per-room]   (AEC_VAD, AEC_FLOOR_K tune the detector)
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { evaluateGuard, synthMic, type EchoRun, type EchoScenario, type Room, type VoiceSource } from "../../packages/baton-voice/src/echoSim.ts";
import { createSileroVad } from "../../packages/baton-voice/src/providers/onnx.ts";

const FRAME = 320; // 20 ms at 16 kHz, the core's frame
const CONFIRM_FRAMES = 6; // 120 ms of cleaned speech
const WARM_S = 1.5; // the filter needs about this long to converge
const VAD = Number(process.env.AEC_VAD ?? 0.5); // Silero probability that counts as speech
const FLOOR_K = Number(process.env.AEC_FLOOR_K ?? 3); // cleaned energy over this many times the room's learned echo residual
const ROOMS: ReadonlyArray<Room> = [[140, 250], [90, 400], [200, 180], [250, 700], [60, 150], [300, 500]];

const root = NodePath.resolve(import.meta.dirname, "../..");
const fixtures = NodePath.join(root, "packages/baton-voice/test/fixtures");

/** Mono 16-bit PCM of a wav, as floats. */
const readWav = (path: string): Float32Array => {
  const b = NodeFS.readFileSync(path);
  let at = 12;
  while (at + 8 <= b.length && b.toString("ascii", at, at + 4) !== "data") at += 8 + b.readUInt32LE(at + 4);
  const n = Math.floor(Math.min(b.readUInt32LE(at + 4), b.length - at - 8) / 2);
  return Float32Array.from({ length: n }, (_, i) => b.readInt16LE(at + 8 + i * 2) / 32768);
};
const corpus = (() => {
  const parts = NodeFS.readdirSync(fixtures).filter((f) => f.endsWith(".wav")).sort().map((f) => readWav(NodePath.join(fixtures, f)));
  const gap = new Float32Array(4_000);
  const all = new Float32Array(parts.reduce((n, p) => n + p.length + gap.length, 0));
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.length + gap.length;
  }
  return all;
})();
const realSpeech: VoiceSource = (seconds, seed) => {
  const out = new Float32Array(Math.round(seconds * 16_000));
  let from = (seed * 7_919) % corpus.length;
  // An interruption is somebody speaking, not a pause: slide to the next stretch where every 100 ms block carries speech.
  if (seconds < 5) {
    const block = (at: number) => {
      let e = 0;
      for (let i = 0; i < 1_600; i += 1) e += corpus[(at + i) % corpus.length]! ** 2;
      return Math.sqrt(e / 1_600);
    };
    const live = (at: number) => Array.from({ length: Math.round(seconds * 10) }, (_, k) => block(at + k * 1_600)).every((r) => r > 0.01);
    for (let tries = 0; tries < corpus.length / 800 && !live(from); tries += 1) from = (from + 800) % corpus.length;
  }
  for (let i = 0; i < out.length; i += 1) out[i] = corpus[(from + i) % corpus.length]!;
  let e = 0;
  for (const v of out) e += v * v;
  const g = 0.1 / Math.sqrt(e / out.length + 1e-12);
  return out.map((v) => v * g);
};

const pcm = (f: Float32Array) => Int16Array.from(f, (v) => Math.max(-32768, Math.min(32767, Math.round(v * 32768))));
const energy = (a: Int16Array, from: number, n: number) => {
  let e = 0;
  for (let i = from; i < from + n; i += 1) e += a[i]! * a[i]!;
  return e / n;
};

const binary = process.argv[2];
if (binary === undefined) throw new Error("usage: aec-eval.ts <path-to-aec-eval> [seconds]");
const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "aec-"));
const vad = await createSileroVad(NodePath.join(root, "native/baton-dictation/models/silero_vad.onnx"), VAD);

const run = async (scenario: EchoScenario): Promise<EchoRun> => {
  const mic = pcm(synthMic(scenario));
  NodeFS.writeFileSync(NodePath.join(dir, "ref.raw"), pcm(scenario.tts));
  NodeFS.writeFileSync(NodePath.join(dir, "mic.raw"), mic);
  const r = NodeChildProcess.spawnSync(binary, [NodePath.join(dir, "ref.raw"), NodePath.join(dir, "mic.raw"), NodePath.join(dir, "out.raw")], { stdio: "inherit" });
  if (r.status !== 0) throw new Error("aec-eval failed");
  const raw = NodeFS.readFileSync(NodePath.join(dir, "out.raw"));
  const out = new Int16Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length));
  const detections: number[] = [];
  let streak = 0;
  let floor = 0;
  vad.reset();
  let speech = false;
  for (let f = 0; (f + 1) * FRAME <= out.length; f += 1) {
    const frame = out.subarray(f * FRAME, (f + 1) * FRAME);
    speech = vad.isSpeech(frame); // the score of the windows up to the previous frame: 20 ms late, counted in the latency
    await vad.drain();
    const e = energy(out, f * FRAME, FRAME);
    const flagged = speech && f * 0.02 > WARM_S && e > FLOOR_K * floor;
    // The room's echo residual: what is left of her own voice after the canceller, while nobody is flagged.
    if (!flagged) floor += (e - floor) * (floor === 0 ? 1 : 0.01);
    streak = flagged ? streak + 1 : 0;
    if (streak === CONFIRM_FRAMES) detections.push(((f + 1) * FRAME) / 16_000);
  }
  return { detections, readyAtS: null, seconds: mic.length / 16_000 };
};

try {
  const result = await evaluateGuard({ seconds: Number(process.argv[3] ?? 60), levelsDb: [-6, 0, 6, 12], rooms: ROOMS, source: realSpeech, run, windowS: Number(process.env.AEC_WINDOW_S ?? 0.42) });
  console.log(JSON.stringify({ vad: VAD, floorK: FLOOR_K, windowS: process.env.AEC_WINDOW_S ?? 0.42, ...result }));
  const ok = result.falsePer10Min <= 1 && (result.recall["0"] ?? 0) >= 0.9;
  console.log(ok ? "meets the target" : "does not meet the target (under 1 false per 10 min and recall >= 0.9 at 0 dB)");
} finally {
  NodeFS.rmSync(dir, { recursive: true, force: true });
}
