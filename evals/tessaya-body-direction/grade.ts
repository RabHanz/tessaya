/**
 * Grading a direction's performance (M-070): what the body would actually play, compiled from the tool call the
 * assistant made, by the same decoders and compilers the server uses. Pure, so run.test.ts covers it in CI.
 */
import { decodeBodyMove, moveCues } from "../../packages/tessaya-shared/src/bodyControl.ts";
import type { BodyCue } from "../../packages/tessaya-shared/src/bodyCues.ts";
import {
  ACTS,
  POSTURES,
  type Euler,
  type PoseBone,
  type PostureName,
} from "../../packages/tessaya-shared/src/bodyMotion.ts";
import {
  handPlacesIn,
  JOINT_SPEED,
  performCues,
} from "../../packages/tessaya-shared/src/bodyPlanner.ts";
import {
  preparePose,
  qAngle,
  fk,
  qFromEuler,
  REFERENCE_RIG,
  v3,
  type V3,
} from "../../packages/tessaya-shared/src/bodyRig.ts";
import {
  CORE_SCENES,
  decodeScene,
  sceneCues,
} from "../../packages/tessaya-shared/src/bodyScene.ts";

export interface Direction {
  readonly id: string;
  readonly said: string;
  readonly category: string;
  readonly difficulty: number;
  /** Seen directions may appear as examples in model-facing text; unseen ones never do. */
  readonly split: "seen" | "unseen";
  readonly source: string;
  readonly rubric: string;
}

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
  if (hands.left !== undefined && hands.left === hands.right)
    w.push(`both hands ${where(hands.left, true)}`);
  else
    for (const side of ["left", "right"] as const)
      if (hands[side] !== undefined) w.push(`${side} hand ${where(hands[side], false)}`);
  return w.length === 0 ? "standing neutral" : w.join(", ");
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
  if (turns(series("leftHand", 2), 0.03) >= 8) out.push("trembles in her hands");
  const gap = frames.map((f) => {
    const p = worldOf(f);
    return Math.hypot(...v3.sub(p["leftHand"]!, p["rightHand"]!));
  });
  const arms = turns(gap, 0.05);
  if (arms >= 4) out.push(`beats her hands ${Math.ceil(arms / 2)} times`);
  if (turns(series("chest", 0), 0.02) >= 2) out.push("breathes visibly");
  return out.length === 0 ? [] : [`through ${s} s she ${out.join(", ")}`];
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

export const JUDGE_SYSTEM = `You judge a digital character's body performance. A person gave her a direction, the way a director talks to an actor. You get the direction, what to look for, and a timeline of exactly what her body, face and eyes will do (nothing else is shown: words she says are not seen). Score from 1 to 5 how clearly a viewer watching only her body would recognise the direction: 1 nothing fits or nothing moves, 3 the right idea but thin or generic, 5 unmistakable and well timed. Reply with only a JSON object: {"score": 1 to 5, "why": "<at most 20 words>"}.`;

export const judgePrompt = (d: Direction, g: Graded): string =>
  [
    `Direction: "${d.said}"`,
    `What a viewer would expect: ${d.rubric}`,
    `Her performance timeline:\n${g.lines.length === 0 ? "(her body does nothing)" : g.lines.map((l) => `- ${l}`).join("\n")}`,
  ].join("\n\n");

export const scoreOf = (answer: string): number => {
  const m = /"score"\s*:\s*([1-5])/.exec(answer);
  return m === null ? 0 : Number(m[1]);
};
