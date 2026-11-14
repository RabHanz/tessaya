// @effect-diagnostics globalConsole:off nodeBuiltinImport:off
// Talking over Tessaya on the R1 (docs/baton/BARGE_IN.md): her playback through an R1-like chain (small speaker, room,
// the device's ~8 dB echo cancelling) with his recorded voice mixed in. Prints aggregate numbers only.
// node scripts/tessaya/talkover-eval.ts <dir>   (<dir>/her.s16 and <dir>/his/*.s16: 16 kHz mono s16le, kept local)
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { rng, room } from "../../packages/baton-voice/src/echoSim.ts";
import { createSileroScorer } from "../../packages/baton-voice/src/providers/onnx.ts";
import { createSpeakerEmbedder } from "../../packages/baton-voice/src/providers/speakerOnnx.ts";
import { cosine, memberByVoice } from "../../packages/baton-voice/src/speaker.ts";
import {
  createRoomLevel,
  createTalkOver,
  voiceCheckDue,
  type TalkOverOptions,
} from "../../packages/baton-voice/src/talkOver.ts";

const RATE = 16_000;
const FRAME = 960; // the R1's 60 ms uplink frame

const read = (file: string): Float32Array => {
  const b = NodeFS.readFileSync(file);
  const i = new Int16Array(b.buffer, b.byteOffset, b.length >> 1);
  return Float32Array.from(i, (v) => v / 32768);
};
const rms = (x: Float32Array, from = 0, to = x.length) => {
  let s = 0;
  let n = 0;
  for (let i = from; i < to; i += 1) {
    s += x[i]! * x[i]!;
    n += 1;
  }
  return Math.sqrt(s / Math.max(1, n));
};
/** RMS over the 20 ms blocks that are not near-silent: the level of speech, not of its pauses. */
const activeRms = (x: Float32Array) => {
  const blocks: number[] = [];
  for (let i = 0; i + 320 <= x.length; i += 320) blocks.push(rms(x, i, i + 320));
  const peak = blocks.reduce((m, b) => Math.max(m, b), 0);
  const live = blocks.filter((b) => b > peak * 0.05);
  return Math.sqrt(live.reduce((s, b) => s + b * b, 0) / Math.max(1, live.length));
};
const convolve = (x: Float32Array, ir: Float32Array) => {
  const out = new Float32Array(x.length);
  const taps: number[] = [];
  for (let k = 0; k < ir.length; k += 1) if (Math.abs(ir[k]!) > 1e-4) taps.push(k);
  for (const k of taps) {
    const g = ir[k]!;
    for (let i = k; i < x.length; i += 1) out[i] = out[i]! + g * x[i - k]!;
  }
  return out;
};

interface Room {
  readonly latencyMs: number;
  readonly rt60Ms: number;
  /** Small-speaker overdrive (tanh). */
  readonly drive: number;
}
const ROOMS: ReadonlyArray<Room> = [
  { latencyMs: 40, rt60Ms: 250, drive: 1.5 },
  { latencyMs: 90, rt60Ms: 400, drive: 2.5 },
  { latencyMs: 130, rt60Ms: 180, drive: 1.0 },
  { latencyMs: 60, rt60Ms: 500, drive: 3.0 },
];
// What is left of her at the mic after the R1's own echo cancelling: -77 dBFS at 0.3.93's AEC delay 384 (about 40 dB
// cut), -60 at 0.3.92's 512. ECHO_DBFS=-60 for the harder case.
const ECHO_DBFS = Number(process.env["ECHO_DBFS"] ?? -77);

/** Her playback as the R1's mic hears it after its own echo cancelling. */
const echoOf = (her: Float32Array, r: Room, seed: number) => {
  const x = new Float32Array(her.length);
  // Small speaker: little below ~300 Hz, soft clipping when loud.
  let lp = 0;
  const peak = her.reduce((m, v) => Math.max(m, Math.abs(v)), 1e-3);
  for (let i = 0; i < her.length; i += 1) {
    lp += 0.11 * (her[i]! - lp);
    const hp = her[i]! - lp;
    x[i] = Math.tanh((r.drive * hp) / peak) / Math.tanh(r.drive);
  }
  const wet = convolve(x, room(r.latencyMs, r.rt60Ms, seed));
  // The level after the device's echo cancelling: ECHO_DBFS is what is left of her at the mic.
  const gain = 10 ** (ECHO_DBFS / 20) / activeRms(wet);
  for (let i = 0; i < wet.length; i += 1) wet[i] = wet[i]! * gain;
  return wet;
};

const run = (
  her: Float32Array,
  echo: Float32Array,
  events: ReadonlyArray<{ at: number; pcm: Float32Array }>,
  seed: number,
  opts: TalkOverOptions,
) => {
  const mic = Float32Array.from(echo);
  const rand = rng(seed);
  for (let i = 0; i < mic.length; i += 1) mic[i] = mic[i]! + (rand() - 0.5) * 2 * 10 ** (-81 / 20);
  for (const e of events)
    for (let i = 0; i < e.pcm.length && e.at + i < mic.length; i += 1)
      mic[e.at + i] = mic[e.at + i]! + e.pcm[i]!;
  const det = createTalkOver(opts);
  const onsets: number[] = [];
  let was = false;
  const toI16 = (f: Float32Array, from: number) =>
    Int16Array.from(f.subarray(from, from + FRAME), (v) =>
      Math.max(-32768, Math.min(32767, Math.round(v * 32768))),
    );
  let hopAt = 512;
  for (let at = 0; at + FRAME <= mic.length; at += FRAME) {
    // The header gives the reference's position; the device latency (the room's delay) is left to find.
    det.reference(toI16(her, at), at);
    for (const v of det.process(toI16(mic, at), at)) {
      if (v.speech && !was) onsets.push(hopAt);
      was = v.speech;
      hopAt += 256;
    }
  }
  return onsets;
};

/** The R1's device latency on its onboard speaker (firmware lane, 14 Nov): her sample under the speaker is rx - q - L. */
const R1_LATENCY = 1972;

/**
 * Real R1 captures (0.3.92 uplink records: 16-byte header, 1920 bytes of mic) of her playing `herself.pcm`, alone and
 * with his voice mixed in at `atDbfs` across the stretch she plays. The reference comes from each frame's header.
 */
const captures = async (
  files: ReadonlyArray<string>,
  refFile: string,
  his: ReadonlyArray<Float32Array>,
  opts: TalkOverOptions,
) => {
  const silero = process.env["SILERO"];
  // PROFILE=<dir of 16 kHz s16le clips>: a household profile (their mean CAM++ vector) for the voice check.
  const member = await (async () => {
    const dir = process.env["PROFILE"];
    if (dir === undefined) return null;
    const embedder = await createSpeakerEmbedder(process.env["CAMPLUS"]!, "campplus", 2);
    const vectors: Float32Array[] = [];
    for (const f of NodeFS.readdirSync(dir).sort().slice(0, 12)) {
      const b = NodeFS.readFileSync(NodePath.join(dir, f));
      const v = await embedder.embed(
        new Int16Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length)),
      );
      if (v !== null) vectors.push(v);
    }
    const centroid = new Float32Array(vectors[0]!.length);
    for (const v of vectors)
      for (let i = 0; i < v.length; i += 1) centroid[i] = centroid[i]! + v[i]! / vectors.length;
    return async (pcm: Int16Array) => {
      const v = await embedder.embed(pcm);
      return v === null ? Number.NEGATIVE_INFINITY : cosine(v, centroid);
    };
  })();
  const herI = (() => {
    const b = NodeFS.readFileSync(refFile);
    return new Int16Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
  })();
  const rows: Array<Record<string, unknown>> = [];
  for (const file of files) {
    const b = NodeFS.readFileSync(file);
    const n = Math.floor(b.length / 1936);
    const frames = Array.from({ length: n }, (_, k) => {
      const head = new DataView(b.buffer, b.byteOffset + k * 1936, 16);
      const pcm = new Int16Array(
        b.buffer.slice(b.byteOffset + k * 1936 + 16, b.byteOffset + (k + 1) * 1936),
      );
      return {
        seq: head.getUint32(0, true),
        rx: head.getUint32(4, true),
        q: head.getUint32(8, true),
        pcm,
      };
    });
    const playing = frames.filter((f) => f.rx > 0 && f.rx - f.q > 0);
    const first = playing[0]?.seq ?? 0;
    const last = playing.at(-1)?.seq ?? 0;
    /** One warm pass of her alone (the loop keeps a detector per R1), then the run with his voice placed; cut onsets. */
    const runCap = async (
      placed: ReadonlyArray<{ readonly at: number; readonly pcm: Float32Array }>,
    ) => {
      const det = createTalkOver(opts);
      // SILERO=<model>: the loop's whole gate (Silero on the latest window, the room's level) on top of the detector.
      const vad = silero === undefined ? null : await createSileroScorer(silero);
      const level = createRoomLevel(
        TALK_MIN_DBFS,
        ...(process.env["OVER_ROOM_DB"] === undefined ? [] : [Number(process.env["OVER_ROOM_DB"])]),
      );
      let prob = 1;
      const cuts: number[] = [];
      const pauses: Array<{ at: number; outcome: "member" | "other"; ms: number }> = [];
      let hold: {
        at: number;
        seq: number;
        fromSeq: number;
        checked: number;
        quietSince: number | null;
      } | null = null;
      let recentFrames: Array<{ seq: number; pcm: Int16Array }> = [];
      let lastCut = -Infinity;
      for (const pass of [0, 1])
        for (const f of frames) {
          const from = (f.rx - f.q) / 2 - R1_LATENCY + 512;
          const ref = new Int16Array(960);
          for (let i = 0; i < 960; i += 1) {
            const j = from + i;
            if (f.rx > 0 && j >= 0 && j < f.rx / 2 && j < herI.length) ref[i] = herI[j]!;
          }
          const mic = Int16Array.from(f.pcm);
          if (pass === 1)
            for (const p of placed)
              for (let i = 0; i < 960; i += 1) {
                const j = f.seq * 960 + i - p.at;
                if (j >= 0 && j < p.pcm.length)
                  mic[i] = Math.max(
                    -32768,
                    Math.min(32767, mic[i]! + Math.round(p.pcm[j]! * 32768)),
                  );
              }
          det.reference(ref, f.seq * 960);
          const voiced = det.process(mic, f.seq * 960).some((v) => v.ready && v.speech);
          let heard = voiced;
          if (vad !== null && pass === 1) {
            level.push(mic, hold === null);
            for (let w = 0; w + 512 <= 960; w += 512)
              prob = await vad.score(mic.subarray(w, w + 512));
            heard = heard && prob >= 0.35 && level.rises();
          }
          if (pass === 1) recentFrames = [...recentFrames, { seq: f.seq, pcm: mic }].slice(-60);
          // The loop's soft pause (roomVoice `followHold`): whose voice, checked as it comes in.
          if (pass === 1 && hold !== null && member !== null) {
            const h = hold;
            h.quietSince = voiced ? null : (h.quietSince ?? f.seq);
            const quiet = h.quietSince !== null && f.seq - h.quietSince >= 10;
            const got = recentFrames.filter((r) => r.seq >= h.fromSeq);
            const seconds = (got.length * 960) / RATE;
            if (voiceCheckDue(seconds, h.checked, quiet)) {
              h.checked = seconds;
              const clip = new Int16Array(got.length * 960);
              got.forEach((r, i) => clip.set(r.pcm, i * 960));
              const best = await member(clip);
              if (process.env["CHECKS"] !== undefined)
                NodeFS.appendFileSync(
                  process.env["CHECKS"],
                  `${JSON.stringify({ him: placed.some((p) => h.at >= p.at && h.at <= p.at + RATE), at: h.at, seconds, best, quiet })}\n`,
                );
              const v = memberByVoice(
                best,
                quiet || seconds >= 2.5 ? Math.max(seconds, 2) : seconds,
              );
              // CHECKS: every checkpoint is logged, so the hold runs to its end whatever it would have decided.
              const final = quiet || seconds >= 2.5;
              if (process.env["CHECKS"] !== undefined ? final : v !== "unsure") {
                pauses.push({ at: h.at, outcome: v, ms: ((f.seq - h.seq) * 960 * 1000) / RATE });
                hold = null;
              }
            }
            continue;
          }
          // The loop's onset grace (400 ms of her playing) and one cut a second at most.
          const at = f.seq * 960 + 960;
          if (pass === 1 && heard && f.seq >= first + 7 && f.seq <= last && at - lastCut >= RATE) {
            cuts.push(at);
            lastCut = at;
            if (member !== null)
              hold = { at, seq: f.seq, fromSeq: f.seq - 5, checked: 0, quietSince: null };
          }
        }
      return { cuts, pauses };
    };
    const herSeconds = ((last - first + 1) * 960) / RATE;
    const alone = await runCap([]);
    const perHour = (n: number) => Math.round((n / herSeconds) * 36000) / 10;
    const gaps = alone.pauses
      .filter((p) => p.outcome === "other")
      .map((p) => p.ms)
      .sort((a, b) => a - b);
    const result: Record<string, unknown> = {
      file: NodePath.basename(file),
      herSeconds: Math.round(herSeconds * 10) / 10,
      ...(member === null
        ? { falseStops: alone.cuts.length, falseStopsPerHour: perHour(alone.cuts.length) }
        : {
            pausesPerHour: perHour(alone.cuts.length),
            falseStopsPerHour: perHour(alone.pauses.filter((p) => p.outcome === "member").length),
            resumeGapMs: {
              p50: Math.round(gaps[gaps.length >> 1] ?? NaN),
              p90: Math.round(gaps[Math.floor(gaps.length * 0.9)] ?? NaN),
            },
          }),
    };
    for (const dbfs of [-60, -50, -41]) {
      const scaled = (k: number) => {
        const clip = his[k % his.length]!;
        const g = 10 ** (dbfs / 20) / activeRms(clip);
        return Float32Array.from(clip, (v) => v * g);
      };
      // A long capture takes his clips every 7 s in one run; a short one, one clip per run at two places.
      const runs: Array<Array<{ at: number; pcm: Float32Array; k: number }>> = [];
      if (last - first > 600) {
        const one: Array<{ at: number; pcm: Float32Array; k: number }> = [];
        for (let k = 0, seq = first + 12; seq + 40 < last; k += 1, seq += 117)
          one.push({ at: seq * 960, pcm: scaled(k), k });
        runs.push(one);
      } else
        for (let k = 0; k < Math.min(his.length, 40); k += 1)
          for (const offset of [12, 20])
            runs.push([{ at: (first + offset) * 960, pcm: scaled(k), k }]);
      let hit = 0;
      let total = 0;
      // Paused for him, then not taken for a household voice: the voice check's misses, not the detector's.
      let judgedOther = 0;
      const lat: number[] = [];
      for (const placed of runs) {
        const { cuts, pauses } = await runCap(placed);
        for (const p of placed) {
          total += 1;
          // With the voice check, he stops her only when the pause it began ends with "member".
          const c = cuts.find(
            (t) =>
              t >= p.at &&
              t <= p.at + RATE &&
              (member === null || pauses.some((q) => q.at === t && q.outcome === "member")),
          );
          if (c === undefined && cuts.some((t) => t >= p.at && t <= p.at + RATE)) judgedOther += 1;
          if (c !== undefined) {
            hit += 1;
            lat.push(((c - p.at) / RATE) * 1000);
          } else if (process.env["MISSES"] === "1") {
            // Which clip and how much of it is voiced: what the misses share (levels only, never words).
            const live: number[] = [];
            for (let i = 0; i + 480 <= p.pcm.length; i += 480)
              live.push(20 * Math.log10(rms(p.pcm, i, i + 480) + 1e-9));
            console.log(
              JSON.stringify({
                miss: p.k,
                dbfs,
                at: p.at / 960 - first,
                first300: live.slice(0, 10).map((v) => Math.round(v)),
                voiced: live.filter((v) => v > dbfs - 10).length,
              }),
            );
          }
        }
      }
      lat.sort((x, y) => x - y);
      result[`${dbfs}dBFS`] = {
        detection: Math.round((hit / total) * 1000) / 1000,
        n: total,
        ...(member === null ? {} : { pausedNotMember: judgedOther }),
        p50ms: Math.round(lat[lat.length >> 1] ?? NaN),
        p90ms: Math.round(lat[Math.floor(lat.length * 0.9)] ?? NaN),
      };
    }
    rows.push(result);
  }
  for (const r of rows) console.log(JSON.stringify(r));
};

/** The loop's whole gate (roomVoice `heardOver`): the detector, Silero on the latest window, and a level floor. */
const TALK_MIN_DBFS = -55;
const gateEval = async (dir: string, silero: string, opts: TalkOverOptions) => {
  const her = read(NodePath.join(dir, "her.s16")).subarray(0, RATE * 180);
  const his = NodeFS.readdirSync(NodePath.join(dir, "his"))
    .sort()
    .map((f) => read(NodePath.join(dir, "his", f)));
  const rand = rng(77);
  const shaped = (seconds: number, fn: (t: number, i: number) => number) =>
    Float32Array.from({ length: Math.round(seconds * RATE) }, (_, i) => fn(i / RATE, i));
  const cough = () => {
    let lp = 0;
    return shaped(0.3, (t) => {
      lp += 0.35 * ((rand() - 0.5) * 2 - lp);
      return lp * Math.min(1, t / 0.01) * Math.exp(-t / 0.09);
    });
  };
  const music = () =>
    shaped(4, (t) => {
      const chord = [220, 277, 330, 247, 311, 370][Math.floor(t * 2) % 6]!;
      return [1, 1.26, 1.5].reduce(
        (a, r, k) => a + Math.sin(2 * Math.PI * chord * r * t) / (k + 1),
        0,
      );
    });
  const tv = (k: number) =>
    her.slice(
      (RATE * (90 + k * 4)) % (her.length - RATE * 4),
      ((RATE * (90 + k * 4)) % (her.length - RATE * 4)) + RATE * 4,
    );
  const kinds: ReadonlyArray<{
    name: string;
    make: (k: number) => Float32Array;
    dbfs: number;
    rt60: number;
  }> = [
    { name: "him -41", make: (k) => his[k % his.length]!, dbfs: -41, rt60: 250 },
    { name: "him -50", make: (k) => his[(k + 50) % his.length]!, dbfs: -50, rt60: 250 },
    { name: "cough -40", make: cough, dbfs: -40, rt60: 250 },
    { name: "cough -30", make: cough, dbfs: -30, rt60: 250 },
    { name: "tv -60", make: tv, dbfs: -60, rt60: 600 },
    { name: "tv -50", make: tv, dbfs: -50, rt60: 600 },
    { name: "music -50", make: music, dbfs: -50, rt60: 600 },
  ];
  const stats = new Map<string, { n: number; stops: number; lat: number[] }>();
  let aloneStops = 0;
  let aloneSeconds = 0;
  // A TV already on through the whole reply (dBFS at the mic), with him talking over both every 7 s.
  const backgrounds = [-55, -50];
  const tvStats = new Map<number, { stops: number; seconds: number; n: number; hit: number }>();
  for (let ri = 0; ri < ROOMS.length; ri += 1) {
    const r = ROOMS[ri]!;
    const echo = echoOf(her, r, 7 + ri);
    for (const scene of [null, "events", ...backgrounds] as const) {
      const withEvents = scene !== null;
      const mic = Float32Array.from(echo, (v) => v + (rand() - 0.5) * 2 * 10 ** (-81 / 20));
      if (typeof scene === "number") {
        const show = convolve(her.slice(RATE * 20).subarray(0, mic.length), room(0, 600, 999));
        const tvGain = 10 ** (scene / 20) / activeRms(show);
        for (let i = 0; i < show.length; i += 1) mic[i] = mic[i]! + show[i]! * tvGain;
      }
      const events: Array<{ at: number; kind: string }> = [];
      if (withEvents)
        for (let k = 0, at = 4 * RATE; at + 5 * RATE < mic.length; k += 1, at += 7 * RATE) {
          const kind = typeof scene === "number" ? kinds[0]! : kinds[(k + ri) % kinds.length]!;
          const wet = convolve(kind.make(k), room(0, kind.rt60, 300 + k));
          const g = 10 ** (kind.dbfs / 20) / activeRms(wet);
          for (let i = 0; i < wet.length && at + i < mic.length; i += 1)
            mic[at + i] = mic[at + i]! + wet[i]! * g;
          events.push({ at, kind: kind.name });
        }
      const det = createTalkOver(opts);
      const vad = await createSileroScorer(silero);
      const toI16 = (f: Float32Array, from: number, n = FRAME) =>
        Int16Array.from(f.subarray(from, from + n), (v) =>
          Math.max(-32768, Math.min(32767, Math.round(v * 32768))),
        );
      let prob = 0;
      let lastCut = -Infinity;
      const level = createRoomLevel(
        TALK_MIN_DBFS,
        ...(process.env["OVER_ROOM_DB"] === undefined ? [] : [Number(process.env["OVER_ROOM_DB"])]),
      );
      const cuts: number[] = [];
      for (let at = 0; at + FRAME <= mic.length; at += FRAME) {
        det.reference(toI16(her, at), at);
        const frame = toI16(mic, at);
        level.push(frame);
        const heard = det.process(frame, at).some((v) => v.ready && v.speech);
        for (let w = at; w + 512 <= at + FRAME; w += 512)
          prob = await vad.score(toI16(mic, w, 512));
        if (!heard || prob < 0.35 || at - lastCut < RATE) continue;
        if (!level.rises()) continue;
        lastCut = at;
        cuts.push(at + FRAME);
      }
      if (typeof scene === "number") {
        const st = tvStats.get(scene) ?? { stops: 0, seconds: 0, n: 0, hit: 0 };
        st.seconds += mic.length / RATE;
        for (const c of cuts)
          if (!events.some((e) => c >= e.at && c <= e.at + 1.5 * RATE)) st.stops += 1;
        for (const e of events) {
          st.n += 1;
          if (cuts.some((c) => c >= e.at && c <= e.at + 1.5 * RATE)) st.hit += 1;
        }
        tvStats.set(scene, st);
        continue;
      }
      if (!withEvents) {
        aloneStops += cuts.length;
        aloneSeconds += mic.length / RATE;
        continue;
      }
      for (const e of events) {
        const st = stats.get(e.kind) ?? { n: 0, stops: 0, lat: [] };
        st.n += 1;
        const c = cuts.find((t) => t >= e.at && t <= e.at + 1.5 * RATE);
        if (c !== undefined) {
          st.stops += 1;
          st.lat.push(((c - e.at) / RATE) * 1000);
        }
        stats.set(e.kind, st);
      }
    }
  }
  console.log(
    JSON.stringify({
      herMinutes: Math.round(aloneSeconds / 6) / 10,
      falseStopsPerHourAlone: Math.round((aloneStops / aloneSeconds) * 36000) / 10,
    }),
  );
  for (const [db, st] of tvStats)
    console.log(
      JSON.stringify({
        tvOnThroughout: db,
        falseStopsPerHour: Math.round((st.stops / st.seconds) * 36000) / 10,
        himAtMinus41Detected: Math.round((st.hit / st.n) * 1000) / 1000,
      }),
    );
  for (const [kind, st] of stats) {
    st.lat.sort((a, b) => a - b);
    console.log(
      JSON.stringify({
        kind,
        events: st.n,
        stopped: Math.round((st.stops / st.n) * 1000) / 1000,
        p50ms: Math.round(st.lat[st.lat.length >> 1] ?? NaN),
        p90ms: Math.round(st.lat[Math.floor(st.lat.length * 0.9)] ?? NaN),
      }),
    );
  }
};

const main = async () => {
  if (process.argv[2] === "--gate") {
    await gateEval(process.argv[3]!, process.argv[4]!, JSON.parse(process.env["OPTS"] ?? "{}"));
    return;
  }
  if (process.argv[2] === "--captures") {
    const [, , , refFile, hisDir, ...files] = process.argv;
    // HALF=0 or 1: every other clip, so a setting tuned on one half is confirmed on the other.
    const half = process.env["HALF"];
    const his = NodeFS.readdirSync(hisDir!)
      .sort()
      .filter((_, i) => half === undefined || i % 2 === Number(half))
      .map((f) => read(NodePath.join(hisDir!, f)));
    await captures(files, refFile!, his, JSON.parse(process.env["OPTS"] ?? "{}"));
    return;
  }
  const dir = process.argv[2];
  if (dir === undefined) throw new Error("usage: talkover-eval.ts <dir>");
  const opts: TalkOverOptions = JSON.parse(process.argv[3] ?? "{}");
  const her = read(NodePath.join(dir, "her.s16"));
  const his = NodeFS.readdirSync(NodePath.join(dir, "his"))
    .sort()
    .map((f) => read(NodePath.join(dir, "his", f)));
  // His voice at the R1's mic (dBFS): about -41 when he talks to her across the room, -60 a quiet aside.
  const levels = [-60, -50, -41];
  let falseStops = 0;
  const seconds = (her.length / RATE) * ROOMS.length;
  const hits: Record<string, number> = {};
  const totals: Record<string, number> = {};
  const latencies: number[] = [];
  const perRoom: number[] = [];
  ROOMS.forEach((r, ri) => {
    const cache = NodePath.join(dir, `echo-room${ri}${ECHO_DBFS}.f32`);
    const echo = NodeFS.existsSync(cache)
      ? new Float32Array(NodeFS.readFileSync(cache).buffer.slice(0))
      : echoOf(her, r, 7 + ri);
    if (!NodeFS.existsSync(cache)) NodeFS.writeFileSync(cache, Buffer.from(echo.buffer));
    const alone = run(her, echo, [], 3 + ri, opts).length;
    perRoom.push(Math.round((alone / (her.length / RATE)) * 3600));
    falseStops += alone;
    if (process.env.ONLY_FALSE === "1") return;
    for (const db of levels) {
      const events = [];
      for (
        let k = 0, at = 4 * RATE;
        at + 3 * RATE < her.length;
        k += 1, at += Math.round(6.5 * RATE)
      ) {
        const clip = his[(k + ri * 37) % his.length]!;
        // He is across the room: the same room's reverberation, none of the speaker's distortion.
        const wet = convolve(clip, room(0, r.rt60Ms, 100 + k));
        const g = 10 ** (db / 20) / activeRms(wet);
        events.push({ at, pcm: Float32Array.from(wet, (v) => v * g) });
      }
      const onsets = run(her, echo, events, 3 + ri, opts);
      for (const e of events) {
        totals[db] = (totals[db] ?? 0) + 1;
        const hit = onsets.find((o) => o >= e.at && o <= e.at + RATE);
        if (hit !== undefined) {
          hits[db] = (hits[db] ?? 0) + 1;
          if (db === -41) latencies.push(((hit - e.at) / RATE) * 1000);
        }
      }
    }
  });
  latencies.sort((a, b) => a - b);
  const q = (p: number) => Math.round(latencies[Math.floor(p * (latencies.length - 1))] ?? NaN);
  console.log(
    JSON.stringify({
      herMinutes: Math.round(seconds / 6) / 10,
      falseStopsPerHourByRoom: perRoom,
      falseStopsPerHour: Math.round((falseStops / seconds) * 3600 * 10) / 10,
      detection: Object.fromEntries(
        levels.map((d) => [
          `${d}dBFS`,
          Math.round(((hits[d] ?? 0) / (totals[d] ?? 1)) * 1000) / 1000,
        ]),
      ),
      latencyMsAtMinus41: { p50: q(0.5), p90: q(0.9) },
    }),
  );
};
await main();
