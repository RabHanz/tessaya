// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
/**
 * Voice match on his own recordings (VOICE-ID): enrol from WAVs, score groups (a microphone, Tessaya's recordings) in
 * 2 s and 4 s windows, and report how often he is rejected at the benchmark's cut-offs. Aggregates only.
 *   node speaker-lab.mjs <model.onnx> <plan.json>   plan: { "enrol": [wav], "groups": { name: [wav] }, "impostors"?: [wav] }
 * Impostors are other people's clips (a public speaker set): how often each cut-off takes them for him.
 */
import * as NodeFS from "node:fs";

import { createSpeakerEmbedder } from "../../../packages/tessaya-voice/src/providers/speakerOnnx.ts";
import { CAMPLUS_POLICY, cosine, enrol } from "../../../packages/tessaya-voice/src/speaker.ts";

const RATE = 16_000;
/** Windows quieter than this (about -40 dBFS) are mostly silence and are skipped. */
const QUIET_RMS = 330;

const readWav = (file: string): Int16Array => {
  const b = NodeFS.readFileSync(file);
  let at = 12;
  while (at + 8 <= b.length) {
    const id = b.toString("ascii", at, at + 4);
    const size = b.readUInt32LE(at + 4);
    if (id === "fmt ") {
      if (
        b.readUInt16LE(at + 10) !== 1 ||
        b.readUInt32LE(at + 12) !== RATE ||
        b.readUInt16LE(at + 22) !== 16
      )
        throw new Error(`${file}: not 16 kHz mono 16-bit`);
    }
    if (id === "data")
      return new Int16Array(b.buffer.slice(b.byteOffset + at + 8, b.byteOffset + at + 8 + size));
    at += 8 + size + (size % 2);
  }
  throw new Error(`${file}: no data`);
};

const windows = (pcm: Int16Array, seconds: number): ReadonlyArray<Int16Array> => {
  const n = seconds * RATE;
  const out: Int16Array[] = [];
  for (let start = 0; start + n <= pcm.length; start += n) {
    const w = pcm.subarray(start, start + n);
    let sum = 0;
    for (const v of w) sum += v * v;
    if (Math.sqrt(sum / n) >= QUIET_RMS) out.push(w);
  }
  return out;
};

const [, , modelPath, planPath] = process.argv;
const plan = JSON.parse(NodeFS.readFileSync(planPath!, "utf8")) as {
  enrol: ReadonlyArray<string>;
  groups: Readonly<Record<string, ReadonlyArray<string>>>;
  impostors?: ReadonlyArray<string>;
};
const embedder = await createSpeakerEmbedder(modelPath!, "lab");

const started = performance.now();
const enrolVectors: Float32Array[] = [];
let enrolSeconds = 0;
for (const file of plan.enrol) {
  const pcm = readWav(file);
  enrolSeconds += pcm.length / RATE;
  const v = await embedder.embed(pcm);
  if (v !== null) enrolVectors.push(v);
}
const made = enrol(enrolVectors);
if (made === null) throw new Error("too few enrolment clips");

const pct = (xs: ReadonlyArray<number>, p: number) =>
  xs.toSorted((a, b) => a - b)[Math.floor((xs.length - 1) * p)] ?? NaN;
const rejected = (xs: ReadonlyArray<number>, cut: number) =>
  xs.length === 0 ? "n/a" : `${((100 * xs.filter((x) => x < cut).length) / xs.length).toFixed(1)}%`;
const accepted = (xs: ReadonlyArray<number>, cut: number) =>
  xs.length === 0
    ? "n/a"
    : `${((100 * xs.filter((x) => x >= cut).length) / xs.length).toFixed(2)}% (${xs.filter((x) => x >= cut).length}/${xs.length})`;

/** Scores of one set of clips: every 2 s and 4 s window, and the mean of each 3 consecutive 2 s windows of a clip. */
const scoreAll = async (files: ReadonlyArray<string>, centroid: Float32Array) => {
  const s2: number[] = [];
  const s4: number[] = [];
  const avg3: number[] = [];
  for (const file of files) {
    const pcm = readWav(file);
    const two: number[] = [];
    for (const w of windows(pcm, 2)) {
      const v = await embedder.embed(w);
      if (v !== null) two.push(cosine(v, centroid));
    }
    s2.push(...two);
    for (let i = 0; i + 3 <= two.length; i += 3)
      avg3.push((two[i]! + two[i + 1]! + two[i + 2]!) / 3);
    for (const w of windows(pcm, 4)) {
      const v = await embedder.embed(w);
      if (v !== null) s4.push(cosine(v, centroid));
    }
  }
  return { s2, s4, avg3 };
};

const report: Record<string, unknown> = {
  enrolClips: plan.enrol.length,
  enrolSeconds: Math.round(enrolSeconds),
  kept: made.kept,
  dropped: made.dropped,
};
for (const [group, files] of Object.entries(plan.groups)) {
  const { s2, s4, avg3 } = await scoreAll(files, made.centroid);
  const p = CAMPLUS_POLICY;
  report[group] = {
    clips: files.length,
    windows2s: s2.length,
    windows4s: s4.length,
    avg3: avg3.length,
    score2s: { p5: pct(s2, 0.05), p50: pct(s2, 0.5) },
    score4s: { p5: pct(s4, 0.05), p50: pct(s4, 0.5) },
    rejected: {
      listen2s: rejected(s2, p.single.listen),
      steer2s: rejected(s2, p.single.steer),
      steerAvg3: rejected(avg3, p.averaged.steer),
      act4s: rejected(s4, p.single.act),
      actAvg3: rejected(avg3, p.averaged.act),
    },
  };
}
if (plan.impostors !== undefined && plan.impostors.length > 0) {
  const { s2, s4, avg3 } = await scoreAll(plan.impostors, made.centroid);
  const p = CAMPLUS_POLICY;
  report["impostors"] = {
    clips: plan.impostors.length,
    score2s: { p50: pct(s2, 0.5), p95: pct(s2, 0.95), p99: pct(s2, 0.99) },
    accepted: {
      listen2s: accepted(s2, p.single.listen),
      steer2s: accepted(s2, p.single.steer),
      steer4s: accepted(s4, p.single.steer),
      steerAvg3: accepted(avg3, p.averaged.steer),
      act4s: accepted(s4, p.single.act),
      actAvg3: accepted(avg3, p.averaged.act),
    },
  };
}
report["seconds"] = Math.round((performance.now() - started) / 1000);
console.log(JSON.stringify(report, null, 2));
