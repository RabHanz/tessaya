/**
 * What a body performance compiles to (M-070, M-089): the cues the body would play for an agent's body tool calls, by
 * the same decoders and composer the server uses, with its channels, rig corrections, joints past human speed and a
 * timeline in words. The direction eval and the viewer's "Agent drives her" both grade with it. Pure.
 */
import { decodeBodyMove, moveCues } from "./bodyControl.ts";
import type { BodyCue } from "./bodyCues.ts";
import { ACTS, POSTURES, type Euler, type PoseBone, type PostureName } from "./bodyMotion.ts";
import { handPlacesIn, JOINT_SPEED, performCues } from "./bodyPlanner.ts";
import { dot, preparePose, qAngle, fk, qFromEuler, REFERENCE_RIG, v3, type V3 } from "./bodyRig.ts";
import { palmsIn } from "./bodySkills.ts";
import { CORE_SCENES, decodeScene, sceneCues } from "./bodyScene.ts";

const strip = (t: string) => t.replace(/^mcp__(baton|tessaya)__/, "");

/**
 * A performance composed as the body composes it: over the posture the cues before it chose (standing when none),
 * so the grade sees the frames, faces and looks the body would play.
 */
export const expand = (cues: ReadonlyArray<BodyCue>, was: PostureName = "stand"): BodyCue[] => {
  let pose = was;
  return cues.flatMap((c): BodyCue[] => {
    if (c.kind === "pose") pose = c.pose === "auto" ? "stand" : c.pose;
    if (c.kind === "act") {
      const a = ACTS[c.act];
      if ("posture" in a) pose = a.posture === "auto" ? "stand" : a.posture;
    }
    if (c.kind === "seq")
      return [{ ...c, steps: c.steps.map((s) => ({ ...s, cues: expand(s.cues, pose) })) }];
    if (c.kind !== "perform") return [c];
    const p: { bones: Partial<Record<PoseBone, Euler>>; grounded?: boolean } = POSTURES[pose];
    const own = {
      ...(c.bones ? { bones: c.bones } : {}),
      ...(c.keys ? { keys: c.keys } : {}),
      look: c.keep?.includes("look") === true,
      face: c.keep?.includes("face") === true,
    };
    return performCues(c.perform, p.bones, p.grounded === true, c.id, own).cues;
  });
};

/** Every body call's cues, in order; a call that does not decode is reported, not dropped. */
export const performanceOf = (
  calls: ReadonlyArray<string>,
  inputs: ReadonlyArray<unknown>,
): { readonly cues: BodyCue[]; readonly errors: string[]; readonly moved: boolean } => {
  const cues: BodyCue[] = [];
  const errors: string[] = [];
  calls.forEach((call, i) => {
    const tool = strip(call);
    if (tool === "tessaya_body_move") {
      const d = decodeBodyMove(inputs[i]);
      if (d.ok) cues.push(...moveCues(d.move, `m${i}`));
      else errors.push(d.error);
    } else if (tool === "tessaya_body_scene") {
      const raw = inputs[i] as { scene?: unknown; dryRun?: boolean } | undefined;
      if (raw?.scene === undefined || raw.dryRun === true) return;
      const d = decodeScene(typeof raw.scene === "string" ? CORE_SCENES[raw.scene] : raw.scene);
      if (d.ok) cues.push(...sceneCues(d.scene));
      else errors.push(d.errors.map((e) => e.message).join("; "));
    }
  });
  return { cues: expand(cues), errors, moved: cues.length > 0 };
};

export type Channel = "body" | "face" | "gaze" | "timing";
export const CHANNELS: ReadonlyArray<Channel> = ["body", "face", "gaze", "timing"];

/** Which parts of a performance a person would see: a body that moves, a face, where she looks, and beats over time. */
export const channelsOf = (cues: ReadonlyArray<BodyCue>): Set<Channel> => {
  const out = new Set<Channel>();
  const walk = (list: ReadonlyArray<BodyCue>) => {
    for (const c of list) {
      if (c.kind === "act" || c.kind === "pose" || c.kind === "gesture" || c.kind === "hand")
        out.add("body");
      if (c.kind === "clip") {
        out.add("body");
        if (c.frames.length >= 20) out.add("timing");
      }
      if (c.kind === "mood" || c.kind === "face" || c.kind === "morphs") out.add("face");
      if (c.kind === "gaze") out.add("gaze");
      if (c.kind === "seq") {
        out.add("timing");
        walk(c.steps.flatMap((s) => s.cues));
      }
    }
  };
  walk(cues);
  return out;
};

const clips = (cues: ReadonlyArray<BodyCue>): Array<Extract<BodyCue, { kind: "clip" }>> =>
  cues.flatMap((c) =>
    c.kind === "clip" ? [c] : c.kind === "seq" ? clips(c.steps.flatMap((s) => s.cues)) : [],
  );

/**
 * Physical validity: what the rig corrects (more than 0.1 rad) across every frame, and each bone's peak speed against
 * its human ceiling (JOINT_SPEED), from frame to frame at the clip's rate.
 */
export const validityOf = (
  cues: ReadonlyArray<BodyCue>,
): { readonly corrections: number; readonly overSpeed: ReadonlyArray<string> } => {
  let corrections = 0;
  const overSpeed = new Set<string>();
  for (const clip of clips(cues)) {
    let prev: Record<string, ReturnType<typeof qFromEuler>> | null = null;
    for (const frame of clip.frames) {
      corrections += preparePose(REFERENCE_RIG, frame as Record<string, V3>).issues.filter(
        (i) => i.by > 0.1,
      ).length;
      const now: Record<string, ReturnType<typeof qFromEuler>> = {};
      for (const [b, e] of Object.entries(frame)) now[b] = qFromEuler(e as V3);
      if (prev !== null)
        for (const [b, q] of Object.entries(now))
          if (prev[b] !== undefined && qAngle(prev[b], q) * clip.fps > JOINT_SPEED(b))
            overSpeed.add(b);
      prev = now;
    }
  }
  return { corrections, overSpeed: [...overSpeed] };
};

const at = (f: Partial<Record<PoseBone, Euler>>, b: PoseBone, k: 0 | 1 | 2) => f[b]?.[k] ?? 0;
/** A pose in the words a person watching would use (VRM 1.0 axes: trunk and head bend forward on +x; left arm down at z -1.2). */
export const poseWords = (f: Partial<Record<PoseBone, Euler>>): string => {
  const w: string[] = [];
  const trunk = at(f, "spine", 0) + at(f, "chest", 0) + at(f, "upperChest", 0);
  if (trunk > 0.12) w.push("trunk bent forward");
  if (trunk < -0.08) w.push("chest lifted");
  const head = at(f, "head", 0) + at(f, "neck", 0);
  if (head > 0.15) w.push("head down");
  if (head < -0.1) w.push("chin up");
  if (Math.abs(at(f, "head", 1) + at(f, "neck", 1)) > 0.2) w.push("head turned");
  if (Math.abs(at(f, "head", 2)) > 0.12) w.push("head tilted");
  // arms by where the hand is, not by angles (a solved arm's Euler angles can wrap)
  const p = worldOf(f);
  for (const side of ["left", "right"] as const) {
    const hand = p[`${side}Hand`];
    const elbow = p[`${side}LowerArm`];
    const shoulder = p[`${side}UpperArm`];
    if (hand === undefined || elbow === undefined || shoulder === undefined) continue;
    if (hand[1] > p["head"]![1] + 0.22) w.push(`${side} arm up overhead`);
    else if (hand[1] > shoulder[1] - 0.12) w.push(`${side} arm raised`);
    if (hand[2] > 0.25) w.push(`${side} arm forward`);
    const a = v3.unit(v3.sub(elbow, shoulder));
    const b = v3.unit(v3.sub(hand, elbow));
    if (a[0] * b[0] + a[1] * b[1] + a[2] * b[2] < 0.5) w.push(`${side} elbow bent`);
  }
  if (at(f, "leftShoulder", 2) > 0.08 && at(f, "rightShoulder", 2) < -0.08) w.push("shoulders up");
  const thigh = Math.min(at(f, "leftUpperLeg", 0), at(f, "rightUpperLeg", 0));
  if (thigh < -1.2) w.push("seated");
  else if (thigh < -0.35 && Math.max(at(f, "leftLowerLeg", 0), at(f, "rightLowerLeg", 0)) > 0.5)
    w.push("knees bent low");
  if (Math.abs(at(f, "hips", 2)) > 1) w.push("lying down");
  const hands = handPlacesIn(f);
  const where = (place: string, both: boolean) =>
    ({
      together: "together in front of her",
      forward: "reaching forward",
      up: "up high",
      out: "out to the side",
    })[place] ?? `at her ${place}${both && (place === "ear" || place === "hip") ? "s" : ""}`;
  const two = twoHandWords(f);
  if (two !== null) w.push(two);
  else if (hands.left !== undefined && hands.left === hands.right)
    w.push(`both hands ${where(hands.left, true)}`);
  else
    for (const side of ["left", "right"] as const)
      if (hands[side] !== undefined) w.push(`${side} hand ${where(hands[side], false)}`);
  return w.length === 0 ? "standing neutral" : w.join(", ");
};

const fingersOf = (f: Partial<Record<PoseBone, Euler>>, side: "left" | "right") =>
  (f as Record<string, Euler | undefined>)[`${side}Fingers`]?.[0] ?? 0;
/** Both hands acting together, as a viewer sees them: palms pressed, fingers laced, a wrist held. */
const twoHandWords = (f: Partial<Record<PoseBone, Euler>>): string | null => {
  const p = palmsIn(f);
  const gap = dot(v3.sub(p.right.palm, p.left.palm), p.left.normal);
  const facing = -dot(p.left.normal, p.right.normal);
  const curled = fingersOf(f, "left") > 0.6 && fingersOf(f, "right") > 0.6;
  if (Math.abs(gap) < 0.03 && facing > 0.4 && curled) return "fingers interlaced in front of her";
  if (Math.abs(gap) < 0.015 && facing > 0.9)
    return p.left.fingers[1] > 0.6
      ? "palms pressed together, fingers up"
      : "palms pressed together in front of her";
  const wrist = worldOf(f)["rightHand"];
  if (
    wrist !== undefined &&
    fingersOf(f, "left") > 0.6 &&
    Math.hypot(...v3.sub(p.left.palm, wrist)) < 0.16
  )
    return "her left hand holding her right wrist";
  return null;
};

/** Movement that repeats through a clip, as a viewer would name it: how often a part turns back on itself. */
const rhythmWords = (
  frames: ReadonlyArray<Partial<Record<PoseBone, Euler>>>,
  fps: number,
): string[] => {
  const turns = (series: number[], min: number) => {
    let n = 0;
    let dir = 0;
    let from = series[0] ?? 0;
    for (const x of series) {
      const d = Math.sign(x - from);
      if (Math.abs(x - from) < min) continue;
      if (dir !== 0 && d !== dir) n += 1;
      dir = d;
      from = x;
    }
    return n;
  };
  const series = (b: PoseBone, k: 0 | 1 | 2) => frames.map((f) => at(f, b, k));
  const s = (frames.length / fps).toFixed(1);
  const out: string[] = [];
  const knees = turns(series("leftLowerLeg", 0), 0.1);
  if (knees >= 3) out.push(`bounces ${Math.ceil(knees / 2)} times`);
  if (turns(series("hips", 2), 0.03) >= 3) out.push("shifts her weight from foot to foot");
  const gap = frames.map((f) => {
    const p = worldOf(f);
    return Math.hypot(...v3.sub(p["leftHand"]!, p["rightHand"]!));
  });
  const arms = turns(gap, 0.05);
  const palms = frames.map((f) => palmsIn(f));
  const meet = palms.map((p) => dot(v3.sub(p.right.palm, p.left.palm), p.left.normal));
  const facing = palms.every(
    (p, i) => meet[i]! > 0.05 || -dot(p.left.normal, p.right.normal) > 0.9,
  );
  const claps = meet.filter((g, i) => g < 0.01 && (meet[i - 1] ?? 1) >= 0.01).length;
  const clapping = arms >= 4 && facing && claps >= 2;
  // palms held together while they slide along each other, or turn over each other
  const together = meet.map((g) => Math.abs(g) < 0.02);
  const slide = palms.map((p) => dot(v3.sub(p.left.palm, p.right.palm), p.left.fingers));
  const rubs = turns(
    slide.filter((_, i) => together[i]),
    0.02,
  );
  const roll = palms.map((p) => p.left.normal[1]);
  const wrings = turns(
    roll.filter((_, i) => together[i]),
    0.15,
  );
  // a rubbing or clapping hand turns its wrist every beat, which is not a tremble; a real one is under a degree
  if (rubs < 4 && !clapping && turns(series("leftHand", 2), 0.003) >= 8)
    out.push("trembles in her hands");
  if (clapping) out.push(`claps ${claps} times, palm to palm, ${clapPlace(frames, palms, meet)}`);
  else if (rubs >= 4) out.push(`rubs her hands together ${Math.ceil(rubs / 2)} times`);
  else if (arms >= 4) out.push(`beats her hands ${Math.ceil(arms / 2)} times`);
  if (rubs < 4 && wrings >= 2) out.push(`wrings her hands ${Math.ceil(wrings / 2)} times`);
  if (turns(series("chest", 0), 0.02) >= 2) out.push("breathes visibly");
  return out.length === 0 ? [] : [`through ${s} s she ${out.join(", ")}`];
};

/** Where the palms meet, in a viewer's words: where they are against her upper chest when they touch. */
const clapPlace = (
  frames: ReadonlyArray<Partial<Record<PoseBone, Euler>>>,
  palms: ReadonlyArray<ReturnType<typeof palmsIn>>,
  meet: ReadonlyArray<number>,
): string => {
  const at = frames.flatMap((f, i) =>
    meet[i]! < 0.01
      ? [
          v3.sub(
            v3.scale(v3.add(palms[i]!.left.palm, palms[i]!.right.palm), 0.5),
            worldOf(f)["upperChest"]!,
          ),
        ]
      : [],
  );
  const m = at.reduce<V3>((a, b) => v3.add(a, v3.scale(b, 1 / at.length)), [0, 0, 0]);
  return m[1] > 0.2
    ? "above her head"
    : m[2] < -0.05
      ? "behind her back"
      : m[0] > 0.1
        ? "out to her left"
        : m[0] < -0.1
          ? "out to her right"
          : "in front of her chest";
};

/** How far a frame is from standing with arms down: the clip's most expressive moment is its peak. */
const worldOf = (f: Partial<Record<PoseBone, Euler>>) =>
  fk(REFERENCE_RIG, Object.fromEntries(Object.entries(f).map(([b, e]) => [b, qFromEuler(e)]))).pos;
const STANDING = worldOf(POSTURES.stand.bones);
/** How far her hands and head are from where they rest standing. */
const reach = (f: Partial<Record<PoseBone, Euler>>) => {
  const p = worldOf(f);
  return ["leftHand", "rightHand", "head"].reduce(
    (sum, b) => sum + Math.hypot(...v3.sub(p[b] ?? STANDING[b]!, STANDING[b]!)),
    0,
  );
};

/** What the body would play, beat by beat, in words a judge can picture. */
export const describe = (cues: ReadonlyArray<BodyCue>, from = 0): string[] =>
  cues.flatMap((c): string[] => {
    const t = `${from} ms`;
    switch (c.kind) {
      case "act":
        return [`${t}: ${c.act}`];
      case "pose":
        return [`${t}: holds a ${c.pose} posture`];
      case "gesture":
        return [`${t}: gesture ${c.gesture}`];
      case "mood":
        return [`${t}: mood ${c.mood} (${c.intensity.toFixed(1)})`];
      case "face":
        return [
          `${t}: face ${Object.entries(c.weights)
            .filter(([, v]) => (v ?? 0) > 0.05)
            .map(([k, v]) => `${k} ${(v ?? 0).toFixed(1)}`)
            .join(", ")} for ${c.ms} ms`,
        ];
      case "gaze":
        return [
          `${t}: looks ${c.y > 0.15 ? "up" : c.y < -0.15 ? "down" : ""}${Math.abs(c.x) > 0.15 ? ` to her ${c.x > 0 ? "left" : "right"}` : ""}${Math.abs(c.x) <= 0.15 && Math.abs(c.y) <= 0.15 ? "at him" : ""} for ${c.ms} ms`,
        ];
      case "hand":
        return [`${t}: a hand ${c.motion}s her ${c.part}`];
      case "morphs":
        return [`${t}: shape keys ${Object.keys(c.weights).join(", ")}`];
      case "clip": {
        if (c.frames.length === 1) return [`${t}: moves to: ${poseWords(c.frames[0]!)}`];
        // the held apex: the middle of the longest stretch near the furthest reach, not a passing overshoot
        const r = c.frames.map(reach);
        const top = 0.85 * Math.max(...r);
        let best = [0, 0];
        for (let i = 0, from = -1; i <= r.length; i += 1)
          if (i < r.length && r[i]! >= top) from = from < 0 ? i : from;
          else if (from >= 0) {
            if (i - from > best[1]! - best[0]!) best = [from, i];
            from = -1;
          }
        const peak = c.frames[Math.floor((best[0]! + best[1]!) / 2)] ?? c.frames[0]!;
        const s = (c.frames.length / c.fps).toFixed(1);
        return [
          `${t}: a ${s} s motion${c.loop ? " (looping)" : ""}: starts ${poseWords(c.frames[0]!)}; peaks ${poseWords(peak)}; ends ${poseWords(c.frames.at(-1)!)}`,
          ...rhythmWords(c.frames, c.fps).map((r) => `${t}: ${r}`),
        ];
      }
      case "seq":
        return c.steps.flatMap((s) => describe(s.cues, from + s.atMs));
      default:
        return [];
    }
  });

export interface DirectionSample {
  readonly calls: ReadonlyArray<string>;
  readonly inputs: ReadonlyArray<unknown>;
  readonly reply: string;
  /** The judge's 1..5 for how well a viewer would recognise the direction, when judged. */
  readonly score?: number;
}

export interface Graded {
  readonly moved: boolean;
  readonly channels: ReadonlyArray<Channel>;
  readonly corrections: number;
  readonly overSpeed: ReadonlyArray<string>;
  readonly errors: ReadonlyArray<string>;
  readonly lines: ReadonlyArray<string>;
}
export const grade = (s: Pick<DirectionSample, "calls" | "inputs">): Graded => {
  const p = performanceOf(s.calls, s.inputs);
  const v = validityOf(p.cues);
  return {
    moved: p.moved,
    channels: CHANNELS.filter((c) => channelsOf(p.cues).has(c)),
    corrections: v.corrections,
    overSpeed: v.overSpeed,
    errors: p.errors,
    lines: describe(p.cues),
  };
};

/** A full performance: she moved, with body, face, gaze and timing, within human speed, and a viewer would know it (4+ of 5). */
export const samplePasses = (g: Graded, score: number | undefined): boolean =>
  g.moved && g.channels.length === CHANNELS.length && g.overSpeed.length === 0 && (score ?? 0) >= 4;
