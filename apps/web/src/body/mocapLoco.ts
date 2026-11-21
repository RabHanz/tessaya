/**
 * Walking and turning from motion capture (100STYLE, assets/CREDITS.md), baked onto a model's own bones when it loads.
 * Each frame splits into where she stands (the root: a position on the floor and a heading) and her body over it, so
 * the body plays the capture and the root carries her across the floor: she travels instead of walking in place, and a
 * turn's heading comes only from her feet (each foot's heading, averaged), so it turns as her steps and pivots do.
 */
import type { VRM, VRMHumanBoneName } from "@pixiv/three-vrm";
import { createVRMAnimationClip } from "@pixiv/three-vrm-animation";
import { POSE_BONES, type Euler, type PoseBone } from "@t3tools/tessaya-shared/bodyMotion";
import * as THREE from "three";

export interface LocoFrame {
  readonly bones: Partial<Record<PoseBone, Euler>>;
  /** The hips over the root, in her model's own axes with the root turned the way she faces at rest, metres. */
  readonly hips: readonly [number, number, number];
  /** The root from the clip's first frame, in those axes then: x, z (m), and how far it has turned (rad). */
  readonly root: readonly [number, number, number];
  /** Whether each foot (left, right) is on the floor and still: a step's stance or a pivot. */
  readonly plant: readonly [boolean, boolean];
}
export interface LocoClip {
  readonly fps: number;
  readonly frames: ReadonlyArray<LocoFrame>;
  /** How far the root turns over the clip (rad) and travels (m). */
  readonly turn: number;
  readonly ahead: number;
  /** The way she faces at rest, in her model's axes (rad from +z toward +x). */
  readonly restYaw: number;
  /** A walk starts here: one foot down right under her hips, so the first step does not lurch her body forward. */
  readonly start: number;
}

const yawOf = (v: THREE.Vector3) => Math.atan2(v.x, v.z);
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/**
 * Bakes a walk loop (`loop`: the root goes straight from the first frame's hips to the last's) or a turn (the root is
 * between the feet, heading their way) onto `target`. `flip` writes VRM 1.0 axes for a mirrored model.
 */
export const bakeLoco = (
  target: VRM,
  anim: Parameters<typeof createVRMAnimationClip>[0],
  flip: boolean,
  loop: boolean,
  /** The hips' place at rest (the model's own, before any clip moved them). */
  restHips: THREE.Vector3,
): LocoClip | null => {
  const node = (b: string) => target.humanoid.getNormalizedBoneNode(b as VRMHumanBoneName);
  const hips = node("hips");
  const legs = [node("leftUpperLeg"), node("rightUpperLeg")];
  const feet = [node("leftFoot"), node("rightFoot")];
  const toes = [node("leftToes"), node("rightToes")];
  if (!hips || !legs[0] || !legs[1] || !feet[0] || !feet[1]) return null;
  const scene = target.scene;
  const local = (o: THREE.Object3D, into: THREE.Vector3) =>
    scene.worldToLocal(o.getWorldPosition(into));
  // she faces left × up at rest (left is +x in her own frame)
  scene.updateMatrixWorld(true);
  const across = local(legs[0], new THREE.Vector3()).sub(local(legs[1], new THREE.Vector3()));
  const restYaw = yawOf(across.clone().cross(new THREE.Vector3(0, 1, 0)));
  hips.position.copy(restHips);
  // where her feet stand at rest: a capture is grounded to it (another actor's legs reach the floor differently)
  scene.updateMatrixWorld(true);
  const restSole = Math.min(...feet.map((x) => local(x!, new THREE.Vector3()).y));
  const mixer = new THREE.AnimationMixer(scene);
  const clip = createVRMAnimationClip(anim, target);
  mixer.clipAction(clip).play();
  const fps = 60;
  const n = Math.max(2, Math.round(clip.duration * fps));
  const raw: Array<{
    bones: Record<string, THREE.Quaternion>;
    hips: THREE.Vector3;
    feet: THREE.Vector3[];
    heading: number;
  }> = [];
  for (let i = 0; i < n; i++) {
    mixer.setTime(Math.min(clip.duration, i / fps));
    scene.updateMatrixWorld(true);
    const bones: Record<string, THREE.Quaternion> = {};
    for (const b of POSE_BONES) {
      const q = node(b)?.quaternion;
      if (q) bones[b] = q.clone();
    }
    const f = feet.map((x) => local(x!, new THREE.Vector3()));
    // each foot's heading, heel to toes; a model without toes uses the legs' line
    const [hl, hr] = [0, 1].map((k) => {
      const t = toes[k];
      return t ? yawOf(local(t, new THREE.Vector3()).sub(f[k]!)) : null;
    });
    const heading =
      hl != null && hr != null
        ? Math.atan2(Math.sin(hl) + Math.sin(hr), Math.cos(hl) + Math.cos(hr))
        : yawOf(
            local(legs[0], new THREE.Vector3())
              .sub(local(legs[1], new THREE.Vector3()))
              .cross(new THREE.Vector3(0, 1, 0)),
          );
    raw.push({ bones, hips: hips.position.clone(), feet: f, heading });
  }
  mixer.stopAllAction();
  mixer.uncacheRoot(scene);
  for (const b of POSE_BONES) node(b)?.quaternion.identity();
  hips.position.copy(restHips);

  // the root: a walk's goes straight along its travel; a turn's stands between the feet, heading the way they point
  const first = raw[0]!;
  const last = raw[n - 1]!;
  const rootAt = (i: number) => {
    const r = raw[i]!;
    // a walk's root is her hips over the floor, heading along the stride: a stance foot stays exactly where it landed
    if (loop)
      return { p: r.hips.clone().setY(0), yaw: yawOf(last.hips.clone().sub(first.hips).setY(0)) };
    return { p: r.feet[0]!.clone().add(r.feet[1]!).multiplyScalar(0.5).setY(0), yaw: r.heading };
  };
  const r0 = rootAt(0);
  const floor = Math.min(...raw.flatMap((r) => r.feet.map((f) => f.y)));
  const up = new THREE.Vector3(0, 1, 0);
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  let unwrapped = 0;
  let prevYaw = r0.yaw;
  const frames: LocoFrame[] = raw.map((r, i) => {
    const root = rootAt(i);
    unwrapped += wrap(root.yaw - prevYaw);
    prevYaw = root.yaw;
    // her body as if the root faced the way she faces at rest
    const undo = q.setFromAxisAngle(up, -(root.yaw - restYaw)).clone();
    const bones: Partial<Record<PoseBone, Euler>> = {};
    for (const [b, rot] of Object.entries(r.bones)) {
      const x = b === "hips" ? rot.clone().premultiply(undo) : rot;
      e.setFromQuaternion(x);
      bones[b as PoseBone] = [flip ? -e.x : e.x, e.y, flip ? -e.z : e.z] as unknown as Euler;
    }
    const h = r.hips.clone().sub(root.p).applyQuaternion(undo);
    h.y += restSole - floor;
    // the root's move in her frame at the clip's start
    const d = root.p
      .clone()
      .sub(r0.p)
      .applyAxisAngle(up, -(r0.yaw - restYaw));
    const step = (k: number) => {
      const a = raw[Math.max(0, i - 1)]!.feet[k]!;
      const b = raw[Math.min(n - 1, i + 1)]!.feet[k]!;
      return Math.hypot(b.x - a.x, b.z - a.z) * (fps / 2);
    };
    // on the floor (within 4 cm of its lowest) and moving under 20 cm/s: standing on it, or pivoting on it
    const plant = [0, 1].map((k) => r.feet[k]!.y < floor + 0.04 && step(k) < 0.2) as [
      boolean,
      boolean,
    ];
    return {
      bones,
      hips: [h.x, h.y, h.z],
      root: [d.x, d.z, unwrapped] as const,
      plant,
    };
  });
  const end = frames[n - 1]!.root;
  const along = Math.hypot(end[0], end[1]);
  // a walk goes as far as her feet carry her: where a foot she stands on drifts in the capture (its retargeted legs are
  // not quite the capture's), the body is carried back by that much (vrmBody's stance foot), so a stride is shorter
  let drift = 0;
  if (loop && along > 0)
    for (let i = 0; i + 1 < n; i++) {
      const down = [0, 1].filter((k) => frames[i]!.plant[k] && frames[i + 1]!.plant[k]);
      if (down.length === 0) continue;
      for (const k of down) {
        const d = raw[i + 1]!.feet[k]!.clone().sub(raw[i]!.feet[k]!);
        drift +=
          (d.x * (last.hips.x - first.hips.x) + d.z * (last.hips.z - first.hips.z)) /
          along /
          down.length;
      }
    }
  let start = 0;
  if (loop && along > 0) {
    let best = Infinity;
    for (let i = 0; i < n; i++) {
      const down = [0, 1].filter((k) => frames[i]!.plant[k]);
      if (down.length !== 1) continue;
      const f = raw[i]!.feet[down[0]!]!;
      const off = Math.abs(
        ((raw[i]!.hips.x - f.x) * (last.hips.x - first.hips.x) +
          (raw[i]!.hips.z - f.z) * (last.hips.z - first.hips.z)) /
          along,
      );
      if (off < best) [best, start] = [off, i];
    }
  }
  return { fps, frames, turn: end[2], ahead: along - drift, restYaw, start };
};
