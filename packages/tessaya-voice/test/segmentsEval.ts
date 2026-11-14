// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
/**
 * `node test/segmentsEval.ts <campplus.onnx> <wav dir>`: the several-voices eval (HOUSEHOLD-DESIGN §9b). The dir
 * holds `<voice>-<n>.wav` per voice (any rate, mono s16): lines 0-2 enrol the voice, the rest are test lines. It
 * mixes voices two at a time in turn, overlapped by 25% and 50%, and three at once, and scores `voicesOf` on them.
 * Needs the model, so CI never runs it.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { createSpeakerEmbedder } from "../src/providers/speakerOnnx.ts";
import { voicesOf, type TurnVoices } from "../src/room/segments.ts";
import { CAMPLUS_POLICY, enrol, type SpeakerProfile } from "../src/speaker.ts";

const RATE = 16_000;
const [modelPath, dir] = process.argv.slice(2);
if (modelPath === undefined || dir === undefined)
  throw new Error("usage: segmentsEval.ts <campplus.onnx> <wav dir>");

const readWav = (path: string): Int16Array => {
  const b = NodeFS.readFileSync(path);
  const rate = b.readUInt32LE(24);
  const at = b.indexOf("data");
  const raw = new Int16Array(Uint8Array.from(b.subarray(at + 8)).buffer);
  const out = new Int16Array(Math.floor((raw.length * RATE) / rate));
  for (let i = 0; i < out.length; i += 1) {
    const x = (i * rate) / RATE;
    const j = Math.floor(x);
    out[i] = Math.round(raw[j]! + (x - j) * ((raw[j + 1] ?? raw[j]!) - raw[j]!));
  }
  // Trim the synthesiser's silence at both ends.
  const loud = (s: number) => Math.abs(s) > 300;
  const from = out.findIndex(loud);
  const to = out.findLastIndex(loud);
  return from < 0 ? out : out.slice(from, to + 1);
};

const files = NodeFS.readdirSync(dir).filter((f) => f.endsWith(".wav"));
const voices = [...new Set(files.map((f) => f.replace(/-\d+\.wav$/, "")))].toSorted();
const clips = new Map(
  voices.map((v) => [
    v,
    files
      .filter((f) => f.startsWith(`${v}-`))
      .toSorted((a, b) => Number(a.match(/(\d+)\.wav$/)![1]) - Number(b.match(/(\d+)\.wav$/)![1]))
      .map((f) => readWav(NodePath.join(dir, f))),
  ]),
);

const model = "campplus";
const policy = { ...CAMPLUS_POLICY, model };
const embedder = await createSpeakerEmbedder(modelPath, model, 1);
const profiles: SpeakerProfile[] = [];
for (const [i, v] of voices.entries()) {
  const vectors = await Promise.all(
    clips
      .get(v)!
      .slice(0, 3)
      .map((c) => embedder.embed(c)),
  );
  const made = enrol(vectors.filter((x) => x !== null));
  if (made === null) throw new Error(`could not enrol ${v}`);
  profiles.push({
    id: i === 0 ? "owner" : v,
    name: v,
    kind: i === 0 ? "owner" : "saved",
    model,
    centroid: made.centroid,
    samples: made.kept,
    sources: ["spoken"],
    enrolledAt: "1970-01-01T00:00:00.000Z",
  });
}
const idOf = (v: string) => profiles[voices.indexOf(v)]!.id;
const tests = (v: string) => clips.get(v)!.slice(3);
const GAP = Math.round(0.15 * RATE);
const FRAME = 480;
/** One person's turn: two of their lines with a breath between, as a request usually runs (2.5-6 s). */
const turnOf = (v: string, n: number): Int16Array => {
  const [x, y] = [tests(v)[n % tests(v).length]!, tests(v)[(n + 1) % tests(v).length]!];
  const out = new Int16Array(x.length + GAP + y.length);
  out.set(x);
  out.set(y, x.length + GAP);
  return out;
};

/** A mix and, per sample, who is in it (a bit per voice). */
interface Mix {
  readonly pcm: Int16Array;
  readonly who: Uint8Array;
  readonly parts: ReadonlyArray<{
    readonly id: string;
    readonly from: number;
    readonly to: number;
  }>;
}
const mix = (
  parts: ReadonlyArray<{ readonly v: string; readonly pcm: Int16Array; readonly at: number }>,
): Mix => {
  const len = Math.max(...parts.map((p) => p.at + p.pcm.length));
  const sum = new Float32Array(len);
  const who = new Uint8Array(len);
  parts.forEach((p, k) => {
    for (let i = 0; i < p.pcm.length; i += 1) sum[p.at + i] = sum[p.at + i]! + p.pcm[i]!;
    // A voice is present where its own 30 ms frame is speech (above -40 dBFS), not in its breaths.
    for (let f = 0; f < p.pcm.length; f += FRAME) {
      const frame = p.pcm.subarray(f, f + FRAME);
      const rms = Math.sqrt(frame.reduce((n, x) => n + x * x, 0) / frame.length);
      if (20 * Math.log10(rms / 32768 + 1e-9) > -40)
        for (let i = f; i < f + frame.length; i += 1) who[p.at + i] = who[p.at + i]! | (1 << k);
    }
  });
  return {
    pcm: Int16Array.from(sum, (x) => Math.max(-32768, Math.min(32767, Math.round(x)))),
    who,
    parts: parts.map((p) => ({ id: idOf(p.v), from: p.at, to: p.at + p.pcm.length })),
  };
};

const timings: number[] = [];
const decide = async (m: Mix): Promise<TurnVoices> => {
  const t0 = performance.now();
  const out = await voicesOf({ pcm: m.pcm, embed: embedder.embed, profiles, policy, at: 0 });
  timings.push(performance.now() - t0);
  return out;
};

type Tally = {
  segments: number;
  correct: number;
  turns: number;
  oneAtATime: number;
  missed: number;
  leaks: number;
  spans: number;
  leakingTurns: number;
};
const tally = (): Tally => ({
  segments: 0,
  correct: 0,
  turns: 0,
  oneAtATime: 0,
  missed: 0,
  leaks: 0,
  spans: 0,
  leakingTurns: 0,
});

/**
 * A part (one voice's line) of 1.5 s or more of its own is attributed when a span inside it carries its name and none
 * inside it carries another's. A span leaks when over 100 ms of it is a voice other than the one it names.
 */
const score = (t: Tally, m: Mix, out: TurnVoices) => {
  t.turns += 1;
  if (out.kind === "one-at-a-time") t.oneAtATime += 1;
  if (out.kind === "one") t.missed += 1;
  const spans = out.kind === "many" ? out.spans : [];
  // One voice alone is right only when the turn stays one voice.
  if (m.parts.every((p) => p.id === m.parts[0]!.id)) {
    t.segments += 1;
    if (out.kind === "one") t.correct += 1;
    return;
  }
  const leaking = new Set(
    spans.filter((s) => {
      const k = m.parts.findIndex((p) => p.id === s.identity.personId);
      let other = 0;
      for (
        let i = Math.round((s.startMs / 1000) * RATE);
        i < Math.round((s.endMs / 1000) * RATE);
        i += 1
      )
        if ((m.who[i]! & ~(k < 0 ? 0 : 1 << k)) !== 0) other += 1;
      return other > 0.1 * RATE;
    }),
  );
  t.spans += spans.length;
  t.leaks += leaking.size;
  if (leaking.size > 0) t.leakingTurns += 1;
  m.parts.forEach((p, k) => {
    let alone = 0;
    for (let i = p.from; i < p.to; i += 1) if (m.who[i] === 1 << k) alone += 1;
    if (alone < 1.5 * RATE) return;
    t.segments += 1;
    const inside = spans.filter((s) => {
      const mid = ((s.startMs + s.endMs) / 2000) * RATE;
      return mid >= p.from && mid < p.to;
    });
    if (
      inside.some((s) => s.identity.personId === p.id) &&
      inside.every((s) => s.identity.personId === p.id && !leaking.has(s))
    )
      t.correct += 1;
  });
};

const alone = tally();
const sequential = tally();
const overlap = { 25: tally(), 50: tally() };
const three = tally();
for (const a of voices) {
  // One voice, two lines in a row: must stay one voice.
  for (let n = 0; n < tests(a).length; n += 1) {
    const one = mix([{ v: a, pcm: turnOf(a, n), at: 0 }]);
    score(alone, one, await decide(one));
  }
  for (const b of voices) {
    if (a === b) continue;
    for (let n = 0; n < tests(a).length; n += 3) {
      const x = turnOf(a, n);
      const y = turnOf(b, n + 4);
      const seq = mix([
        { v: a, pcm: x, at: 0 },
        { v: b, pcm: y, at: x.length + GAP },
      ]);
      score(sequential, seq, await decide(seq));
      for (const pct of [25, 50] as const) {
        const shared = Math.round((Math.min(x.length, y.length) * pct) / 100);
        const ov = mix([
          { v: a, pcm: x, at: 0 },
          { v: b, pcm: y, at: x.length - shared },
        ]);
        score(overlap[pct], ov, await decide(ov));
      }
    }
  }
}
for (let i = 0; i < voices.length; i += 1) {
  const [a, b, c] = [0, 1, 2].map((k) => voices[(i + k) % voices.length]!);
  for (let n = 0; n < 3; n += 1) {
    const m = mix([
      { v: a!, pcm: turnOf(a!, n), at: 0 },
      { v: b!, pcm: turnOf(b!, n + 3), at: Math.round(0.4 * RATE) },
      { v: c!, pcm: turnOf(c!, n + 6), at: Math.round(0.8 * RATE) },
    ]);
    score(three, m, await decide(m));
  }
}

const pct = (n: number, d: number) =>
  d === 0 ? "n/a" : `${((100 * n) / d).toFixed(1)}% (${n}/${d})`;
const row = (name: string, t: Tally) =>
  console.log(
    `${name.padEnd(22)} attributed ${pct(t.correct, t.segments).padEnd(18)} one-at-a-time ${pct(t.oneAtATime, t.turns).padEnd(18)} kept as one voice ${pct(t.missed, t.turns).padEnd(18)} leaking spans ${pct(t.leaks, t.spans).padEnd(16)} turns with a leak ${pct(t.leakingTurns, t.turns)}`,
  );
console.log(`voices ${voices.join(", ")} (owner ${voices[0]}), ${profiles.length} enrolled`);
row("one voice, two lines", alone);
row("two in turn", sequential);
row("two, 25% overlap", overlap[25]);
row("two, 50% overlap", overlap[50]);
row("three at once", three);
const sorted = timings.toSorted((a, b) => a - b);
console.log(
  `voicesOf per turn: p50 ${sorted[Math.floor(sorted.length / 2)]!.toFixed(0)} ms, p90 ${sorted[Math.floor(sorted.length * 0.9)]!.toFixed(0)} ms over ${sorted.length} turns`,
);
