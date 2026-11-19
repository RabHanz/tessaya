/**
 * The clips of an owner-extensions file (his own JSON, private layer README), read into the body's axes so they play
 * through the rig and the planner like every other motion: joint limits, IK and the checker, not raw angles. The same
 * axis rules as the private layer's loader (companion/src/extensions.ts axesOf and fromViewer), which should sync this
 * module rather than keep its own copy.
 */
import { fromViewerAxes } from "./bodyScene.ts";
import type { Euler, PoseBone } from "./bodyMotion.ts";
import { POSE_BONES } from "./bodyMotion.ts";

/**
 * "vrm1" is the body's own axes (VRM 1.0 normalized: arms down are left Z < 0, right Z > 0). "viewer" is the
 * standalone owner viewer's (VRM 0.x as three-vrm shows it, with its right-arm Z flip: both arms down are Z < 0).
 */
export type ClipAxes = "vrm1" | "viewer";

/** Both upper arms well off zero with the same sign is the viewer's; opposite signs the body's own. */
export const axesEvidence = (raw: unknown): { readonly same: number; readonly opposite: number } => {
  const r = (raw ?? {}) as Record<string, unknown>;
  let same = 0;
  let opposite = 0;
  for (const c of Array.isArray(r["clips"]) ? r["clips"] : []) {
    const frames = (c as Record<string, unknown> | null)?.["frames"];
    for (const f of Array.isArray(frames) ? frames : []) {
      const fr = (f ?? {}) as Record<string, unknown>;
      const l = (fr["leftUpperArm"] as unknown[] | undefined)?.[2];
      const rr = (fr["rightUpperArm"] as unknown[] | undefined)?.[2];
      if (typeof l !== "number" || typeof rr !== "number" || Math.abs(l) < 0.3 || Math.abs(rr) < 0.3)
        continue;
      if (Math.sign(l) === Math.sign(rr)) same++;
      else opposite++;
    }
  }
  return { same, opposite };
};
/** A file may say its `"axes"`; otherwise its arms decide, and a file with no arm evidence follows `fallback`. */
export const axesOf = (raw: unknown, fallback: ClipAxes = "vrm1"): ClipAxes => {
  const said = ((raw ?? {}) as Record<string, unknown>)["axes"];
  if (said === "vrm1" || said === "viewer") return said;
  const e = axesEvidence(raw);
  return e.same + e.opposite === 0 ? fallback : e.same > e.opposite ? "viewer" : "vrm1";
};

const MAX_FRAMES = 3600;
const BONES: ReadonlySet<string> = new Set(POSE_BONES);
export interface OwnerClip {
  readonly id: string;
  readonly fps: number;
  readonly loop: boolean;
  readonly frames: ReadonlyArray<Partial<Record<PoseBone, Euler>>>;
  /** The axes it was written in (and read from). */
  readonly axes: ClipAxes;
}
export interface OwnerClipSkip {
  readonly entry: string;
  readonly why: string;
}

/** Every clip in one parsed owner-extensions file, in the body's axes; a bad one is skipped with why, never fatal. */
export const readOwnerClips = (
  raw: unknown,
  fallback: ClipAxes = "viewer",
): { readonly clips: ReadonlyArray<OwnerClip>; readonly skipped: ReadonlyArray<OwnerClipSkip> } => {
  const axes = axesOf(raw, fallback);
  const r = (raw ?? {}) as Record<string, unknown>;
  const clips: OwnerClip[] = [];
  const skipped: OwnerClipSkip[] = [];
  for (const [i, c] of (Array.isArray(r["clips"]) ? r["clips"] : []).entries()) {
    const o = (c ?? {}) as Record<string, unknown>;
    const entry = typeof o["id"] === "string" ? o["id"] : `clips[${i}]`;
    const raws = o["frames"];
    if (!Array.isArray(raws) || raws.length === 0 || raws.length > MAX_FRAMES) {
      skipped.push({ entry, why: `frames must be 1 to ${MAX_FRAMES}` });
      continue;
    }
    const frames: Array<Partial<Record<PoseBone, Euler>>> = [];
    let why: string | null = null;
    for (const f of raws) {
      const out: Partial<Record<PoseBone, Euler>> = {};
      for (const [bone, e] of Object.entries((f ?? {}) as Record<string, unknown>)) {
        if (!BONES.has(bone)) continue;
        if (
          !Array.isArray(e) ||
          e.length !== 3 ||
          !e.every((v) => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= Math.PI)
        ) {
          why = `${bone} needs [x, y, z] radians within ±π`;
          break;
        }
        const v = e as unknown as Euler;
        out[bone as PoseBone] = (axes === "viewer" ? fromViewerAxes(bone, v) : v) as Euler;
      }
      if (why !== null) break;
      frames.push(out);
    }
    if (why !== null) {
      skipped.push({ entry, why });
      continue;
    }
    const fps = typeof o["fps"] === "number" && o["fps"] >= 1 && o["fps"] <= 60 ? o["fps"] : 30;
    clips.push({ id: entry, fps, loop: o["loop"] === true, frames, axes });
  }
  return { clips, skipped };
};
