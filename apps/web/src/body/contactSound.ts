/**
 * Contact sounds, made as they happen (adopt map: tessaya-ops/research/body-contact-sound-adopt-2026-11-20.md): a clap
 * is noise through one resonance from flat (~984 Hz) to cupped (~500 Hz, louder; Peltola et al. 2007), a hand on her a
 * damped thump. Harder is louder and brighter, every hit is tuned afresh, heard from the camera; silent until used.
 */
import type * as THREE from "three";

let ctx: AudioContext | null = null;
let noise: AudioBuffer | null = null;
/** Where a sound goes: the live audio now, or (an offline render, a check) another context at `when` seconds. */
export interface SoundOut {
  readonly ctx: BaseAudioContext;
  readonly when: number;
}
const noiseOf = (c: BaseAudioContext) => {
  if (noise === null || noise.sampleRate !== c.sampleRate) {
    noise = c.createBuffer(1, c.sampleRate, c.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  return noise;
};
let sleep: ReturnType<typeof setTimeout> | null = null;

const gauss = (mean: number, sd: number) =>
  mean + sd * Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());

const ready = (): AudioContext | null => {
  if (typeof AudioContext === "undefined") return null;
  ctx ??= new AudioContext();
  if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);
  if (sleep !== null) clearTimeout(sleep);
  sleep = setTimeout(() => void ctx?.suspend().catch(() => undefined), 2000);
  // an autoplay policy that keeps it asleep (no gesture yet): the contact is silent rather than queued
  return ctx.state === "closed" ? null : ctx;
};

/** One noise burst, `ms` long, through `chain`, placed at `at` as heard from `ear`, `gain` loud. */
const burst = (
  c: BaseAudioContext,
  when: number,
  at: THREE.Vector3,
  ear: THREE.Camera,
  gain: number,
  attackMs: number,
  decayMs: number,
  chain: (input: AudioNode) => AudioNode,
) => {
  const t = when;
  const src = c.createBufferSource();
  src.buffer = noiseOf(c);
  const env = c.createGain();
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(gain, t + attackMs / 1000);
  env.gain.setTargetAtTime(0, t + attackMs / 1000, decayMs / 1000 / 3);
  const pan = c.createPanner();
  pan.panningModel = "equalpower";
  pan.distanceModel = "inverse";
  pan.refDistance = 1;
  // the listener is the camera: the contact relative to it
  const local = ear.worldToLocal(at.clone());
  pan.positionX.value = local.x;
  pan.positionY.value = local.y;
  pan.positionZ.value = local.z;
  src.connect(env);
  chain(env).connect(pan).connect(c.destination);
  src.start(t, Math.random() * 0.8, (attackMs + decayMs * 3) / 1000);
};

/**
 * Palms meeting at `speed` (m/s), `cup` 0 (flat) to 1 (cupped). A flat clap is mostly the bright burst itself; a
 * cupped one mostly its low resonance, about 9.5 dB louder there.
 */
export const clapSound = (
  at: THREE.Vector3,
  ear: THREE.Camera,
  speed: number,
  cup: number,
  out?: SoundOut,
) => {
  const c = out?.ctx ?? ready();
  if (c === null || speed < 0.05) return;
  const when = out?.when ?? c.currentTime + 0.005;
  const k = Math.max(0, Math.min(1, speed / 3));
  const u = Math.max(0, Math.min(1, cup));
  const f = Math.max(250, gauss(984 + (500 - 984) * u, 396 + (178 - 396) * u));
  const bw = Math.max(40, gauss(137 + (91 - 137) * u, 36 + (27 - 36) * u));
  const g = (11.3 + (33.8 - 11.3) * u) / 33.8;
  burst(c, when, at, ear, 0.04 + 0.7 * k ** 1.6, 1, 25 - 17 * k, (input) => {
    const out = c.createGain();
    const bright = c.createBiquadFilter();
    bright.type = "lowpass";
    bright.frequency.value = 2000 + 8000 * k;
    const dry = c.createGain();
    dry.gain.value = 1 - 0.8 * u;
    input.connect(bright).connect(dry).connect(out);
    const res = c.createBiquadFilter();
    res.type = "bandpass";
    res.frequency.value = f;
    res.Q.value = f / bw;
    const wet = c.createGain();
    wet.gain.value = 3 * g * (0.3 + 0.7 * u);
    input.connect(res).connect(wet).connect(out);
    return out;
  });
};

/** A hand landing on a body (skin or clothes): a dull, damped thump, `press` 0..1 how firmly. */
export const touchSound = (at: THREE.Vector3, ear: THREE.Camera, press: number, out?: SoundOut) => {
  const c = out?.ctx ?? ready();
  if (c === null || press < 0.05) return;
  const when = out?.when ?? c.currentTime + 0.005;
  const k = Math.max(0, Math.min(1, press));
  burst(c, when, at, ear, 0.02 + 0.25 * k ** 1.5, 3, 45 - 15 * k, (input) => {
    const low = c.createBiquadFilter();
    low.type = "lowpass";
    low.frequency.value = gauss(700 + 900 * k, 120);
    const body = c.createBiquadFilter();
    body.type = "peaking";
    body.frequency.value = gauss(220, 30);
    body.gain.value = 9;
    input.connect(low).connect(body);
    return body;
  });
};
