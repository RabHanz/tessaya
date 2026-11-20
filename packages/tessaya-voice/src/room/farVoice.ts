/**
 * His voice from across the room, made from his own verified turns: quieter, the high end dulled, a room's tail and a
 * noise floor. Always his voice, so a guest in his session can never shape it. 20 Nov: his far-degraded held-out clips
 * were accepted 43% -> 71% at 0.5 with it, and 395 other speakers' clips degraded the same way never.
 * @module baton-voice/room/farVoice
 */
import { enrol } from "../speaker.ts";

const RATE = 16_000;

export interface FarVariant {
  readonly gainDb: number;
  readonly cutHz: number;
  readonly rt60Ms: number;
  readonly floorDb: number;
}

/** What the far centroid is made from, each of his clips through each. */
export const FAR_VARIANTS: ReadonlyArray<FarVariant> = [
  { gainDb: -8, cutHz: 2500, rt60Ms: 350, floorDb: -58 },
  { gainDb: -10, cutHz: 1800, rt60Ms: 500, floorDb: -55 },
];
/** His clips this long or more make it; his newest this many. */
export const FAR_MIN_SAMPLES = 1.5 * RATE;
export const FAR_CLIPS = 20;

/** One clip as from across the room. `seed` makes the same clip degrade the same way every time. */
export const farFrom = (pcm: Int16Array, v: FarVariant, seed = 7): Int16Array => {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  const g = 10 ** (v.gainDb / 20);
  const a = Math.exp((-2 * Math.PI * v.cutHz) / RATE);
  const n = Math.round((v.rt60Ms / 1000) * RATE);
  const ir = Float32Array.from({ length: n }, (_, i) => rnd() * Math.exp((-6.9 * i) / n) * 0.08);
  const x = Float32Array.from(pcm, (sample) => sample * g);
  let y = 0;
  for (let i = 0; i < x.length; i += 1) x[i] = y = (1 - a) * x[i]! + a * y;
  const floor = 32768 * 10 ** (v.floorDb / 20);
  return Int16Array.from(x, (sample, i) => {
    let acc = sample;
    // Every 16th tap of the tail, scaled to keep its energy: a room, not a precise one.
    for (let k = 16; k < n && k <= i; k += 16) acc += x[i - k]! * ir[k]! * 4;
    return Math.max(-32768, Math.min(32767, Math.round(acc + rnd() * floor)));
  });
};

/** The far centroid from his clips, or null with too few (enrol's own minimum). */
export const farCentroid = async (
  clips: ReadonlyArray<Int16Array>,
  embed: (pcm: Int16Array) => Promise<Float32Array | null>,
): Promise<Float32Array | null> => {
  const vectors: Array<Float32Array> = [];
  for (const clip of clips.filter((c) => c.length >= FAR_MIN_SAMPLES).slice(-FAR_CLIPS))
    for (const v of FAR_VARIANTS) {
      const vector = await embed(farFrom(clip, v));
      if (vector !== null) vectors.push(vector);
    }
  return enrol(vectors)?.centroid ?? null;
};
