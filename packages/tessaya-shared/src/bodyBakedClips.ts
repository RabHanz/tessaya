/**
 * Library moves as a physics-trained policy played them (M-079): rollouts that passed the physics checker, baked offline
 * by tessaya-ops physics-spike/export_baked.py into `bodyBakedClips.data.ts`. Loaded only when a body asks for one.
 */
import { BAKED_CLIPS } from "./bodyBakedClips.data.ts";
import type { Euler, PoseBone } from "./bodyMotion.ts";

const STEP = 1 / 500;

export interface BakedClip {
  readonly fps: number;
  readonly frames: ReadonlyArray<Partial<Record<PoseBone, Euler>>>;
  /** How long it plays. */
  readonly ms: number;
}

/** One clip's bytes: the first frame as Int16 steps, then each frame's change as Int8 steps (bones × 3 per frame). */
export const decodeBaked = (
  bones: ReadonlyArray<string>,
  bytes: Uint8Array,
): BakedClip["frames"] => {
  const k = bones.length * 3;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = 1 + (bytes.byteLength - 2 * k) / k;
  if (!Number.isInteger(n) || n < 1) throw new Error("baked clip: bytes do not fit its bones");
  const at = Array.from({ length: k }, (_, i) => view.getInt16(2 * i, true));
  const frames: Array<Partial<Record<PoseBone, Euler>>> = [];
  for (let t = 0; t < n; t++) {
    if (t > 0) for (let i = 0; i < k; i++) at[i]! += view.getInt8(2 * k + (t - 1) * k + i);
    const f: Partial<Record<PoseBone, Euler>> = {};
    bones.forEach((b, j) => {
      f[b as PoseBone] = [
        at[3 * j]! * STEP,
        at[3 * j + 1]! * STEP,
        at[3 * j + 2]! * STEP,
      ] as unknown as Euler;
    });
    frames.push(f);
  }
  return frames;
};

const cache = new Map<string, BakedClip>();
/** The physics-trained version of a library entry, or undefined when it has none (the renderer plays it as before). */
export const bakedClip = (entry: string): BakedClip | undefined => {
  const hit = cache.get(entry);
  if (hit !== undefined) return hit;
  const raw = BAKED_CLIPS[entry];
  if (raw === undefined) return undefined;
  const frames = decodeBaked(
    raw.bones,
    Uint8Array.from(atob(raw.q), (ch) => ch.charCodeAt(0)),
  );
  const clip = { fps: raw.fps, frames, ms: (frames.length / raw.fps) * 1000 };
  cache.set(entry, clip);
  return clip;
};
