/**
 * A body scene (M-065): a versioned, content-neutral timeline of moves (bodyControl) that any body plays on its own
 * clock and any rig resolves. Decoding teaches: each error names where it is and how to fix it. A dry run plays every
 * beat through a rig and reports what it had to correct. Older formats migrate: version 0 is the standalone owner
 * viewer's beat list (pose in its axes, expression, morphs, gaze, duration).
 */
import type { BodyCue } from "./bodyCues.ts";
import { decodeBodyMove, isPrivateMove, moveCues, type BodyMove } from "./bodyControl.ts";
import { preparePose, type Rig, type RigIssue, type V3 } from "./bodyRig.ts";

export const SCENE_VERSION = 1;
const MAX_BEATS = 64;
const MAX_MS = 600_000;

export interface SceneBeat {
  readonly atMs: number;
  readonly label?: string;
  readonly move: BodyMove;
}
export interface BodyScene {
  readonly version: typeof SCENE_VERSION;
  readonly id: string;
  readonly title: string;
  readonly loop: boolean;
  readonly beats: ReadonlyArray<SceneBeat>;
}
export interface SceneError {
  /** Where, as a path into the scene ("beats[2].move"). */
  readonly at: string;
  readonly message: string;
  readonly fix: string;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Version 0 is the standalone viewer's beats: `[{name, pose, expression, morphs, gaze: [x, y], duration}]`, one after
 * another, poses in that viewer's axes. Speech and captions are dropped (a scene's lines come from her voice path).
 */
export const migrateScene = (raw: unknown): { scene: unknown; notes: ReadonlyArray<string> } => {
  if (!Array.isArray(raw)) return { scene: raw, notes: [] };
  const notes = new Set<string>();
  let at = 0;
  const beats = raw.map((b, i) => {
    const r = isObj(b) ? b : {};
    const move: Record<string, unknown> = {};
    if (isObj(r["pose"]))
      move["bones"] = Object.fromEntries(
        Object.entries(r["pose"]).flatMap(([bone, e]) =>
          Array.isArray(e) && e.length === 3
            ? [[bone, fromViewerAxes(bone, e as unknown as V3)]]
            : [],
        ),
      );
    if (isObj(r["expression"]))
      move["face"] = { weights: r["expression"], ms: r["duration"] ?? 2000 };
    if (isObj(r["morphs"])) move["morphs"] = r["morphs"];
    if (Array.isArray(r["gaze"]) && r["gaze"].length === 2)
      move["look"] = {
        x: Number(r["gaze"][0]) / 0.4,
        y: Number(r["gaze"][1]) / 0.3,
        ms: r["duration"] ?? 2000,
      };
    for (const k of ["speak", "caption", "captionJp"])
      if (r[k] !== undefined) notes.add(`${k} dropped`);
    const beat = {
      atMs: at,
      label: typeof r["name"] === "string" ? r["name"] : `beat ${i + 1}`,
      move,
    };
    at += typeof r["duration"] === "number" ? r["duration"] : 2000;
    return beat;
  });
  return {
    scene: { version: SCENE_VERSION, id: "migrated", title: "Migrated scene", beats },
    notes: [...notes],
  };
};

/**
 * The standalone owner viewer's axes (VRM 0.x normalized as three-vrm shows it, plus its right-arm Z flip) in the
 * body's: X and Z both turn the other way, except where that viewer already turned them (X on shins, feet and toes;
 * Z on the left arm).
 */
export const fromViewerAxes = (bone: string, [x, y, z]: V3): V3 => [
  /LowerLeg|Foot|Toes/.test(bone) ? x : -x,
  y,
  /^left(Shoulder|UpperArm|LowerArm|Hand)$/.test(bone) ? z : -z,
];

/** A scene off the wire or out of a pack, migrated, bounded and checked; every error says how to fix it. */
export const decodeScene = (
  raw: unknown,
):
  | { readonly ok: true; readonly scene: BodyScene; readonly notes: ReadonlyArray<string> }
  | {
      readonly ok: false;
      readonly errors: ReadonlyArray<SceneError>;
    } => {
  const { scene, notes } = migrateScene(raw);
  const errors: SceneError[] = [];
  const err = (at: string, message: string, fix: string) => errors.push({ at, message, fix });
  if (!isObj(scene))
    return {
      ok: false,
      errors: [
        {
          at: "",
          message: "a scene is an object",
          fix: '{"version": 1, "id": "greeting", "title": "...", "beats": [...]}',
        },
      ],
    };
  if (scene["version"] !== SCENE_VERSION)
    err(
      "version",
      `version ${String(scene["version"])} is not known`,
      `set "version": ${SCENE_VERSION}`,
    );
  const id =
    typeof scene["id"] === "string" && /^[a-z][\w-]{0,39}$/.test(scene["id"]) ? scene["id"] : null;
  if (id === null)
    err(
      "id",
      "id is missing or not a short name",
      'use lowercase letters, digits, - or _, e.g. "greeting"',
    );
  const beatsRaw = Array.isArray(scene["beats"]) ? scene["beats"] : null;
  if (beatsRaw === null || beatsRaw.length === 0)
    err("beats", "a scene needs beats", 'add "beats": [{"atMs": 0, "move": {"act": "wave"}}]');
  else if (beatsRaw.length > MAX_BEATS)
    err("beats", `${beatsRaw.length} beats is more than ${MAX_BEATS}`, "split it into scenes");
  const beats: SceneBeat[] = [];
  let last = -1;
  for (const [i, b] of (beatsRaw ?? []).slice(0, MAX_BEATS).entries()) {
    const at = `beats[${i}]`;
    if (!isObj(b)) {
      err(at, "a beat is an object", '{"atMs": 1000, "move": {...}}');
      continue;
    }
    const atMs = b["atMs"];
    if (typeof atMs !== "number" || !Number.isFinite(atMs) || atMs < 0 || atMs > MAX_MS) {
      err(
        `${at}.atMs`,
        "atMs must be a time from the scene's start, 0 to 600000 ms",
        "give each beat its start in ms",
      );
      continue;
    }
    if (atMs <= last)
      err(
        `${at}.atMs`,
        `starts at ${atMs} ms, not after the beat before (${last} ms)`,
        "order beats by time; two beats at once belong in one move",
      );
    last = atMs;
    const move = decodeBodyMove(b["move"]);
    if (!move.ok) {
      err(`${at}.move`, move.error, "see tessaya_body_state for the vocabulary, bones and limits");
      continue;
    }
    if (move.move.then !== undefined)
      err(
        `${at}.move.then`,
        "a beat's move has no steps of its own",
        "make each step its own beat",
      );
    beats.push({
      atMs,
      move: move.move,
      ...(typeof b["label"] === "string" ? { label: b["label"].slice(0, 80) } : {}),
    });
  }
  if (errors.length > 0 || id === null) return { ok: false, errors };
  return {
    ok: true,
    scene: {
      version: SCENE_VERSION,
      id,
      title: typeof scene["title"] === "string" ? scene["title"].slice(0, 120) : id,
      loop: scene["loop"] === true,
      beats,
    },
    notes,
  };
};

/** Whether any beat belongs to a private moment (the same gate as a single move). */
export const isPrivateScene = (s: BodyScene): boolean => s.beats.some((b) => isPrivateMove(b.move));

/** The cues a scene becomes: its first beat now (when it starts at 0), the rest as one timed sequence. */
export const sceneCues = (s: BodyScene): BodyCue[] => {
  const steps = s.beats.map((b, i) => ({ atMs: b.atMs, cues: moveCues(b.move, `${s.id}-${i}`) }));
  const now = steps[0]?.atMs === 0 ? steps.shift()!.cues : [];
  return steps.length === 0 ? now : [...now, { kind: "seq", steps }];
};

/** Plays each beat's direct bones through a rig without drawing: what it would correct, beat by beat. */
export const dryRun = (
  s: BodyScene,
  rig: Rig,
): ReadonlyArray<{
  readonly at: string;
  readonly label: string;
  readonly corrected: ReadonlyArray<RigIssue>;
}> =>
  s.beats.flatMap((b, i) => {
    const frames =
      b.move.keys?.map((k) => k.bones) ?? (b.move.bones === undefined ? [] : [b.move.bones]);
    const corrected = frames.flatMap((f) => preparePose(rig, f as Record<string, V3>).issues);
    return corrected.length === 0
      ? []
      : [{ at: `beats[${i}]`, label: b.label ?? `beat ${i + 1}`, corrected }];
  });

/** Everyday scenes every body has (content-neutral): a starting point to copy, and what the tool plays by name. */
export const CORE_SCENES: Readonly<Record<string, unknown>> = {
  greeting: {
    version: 1,
    id: "greeting",
    title: "Greeting",
    beats: [
      {
        atMs: 0,
        label: "notices him",
        move: { look: { x: 0, y: 0.1, ms: 1200 }, mood: { name: "happy", intensity: 0.5 } },
      },
      { atMs: 500, label: "waves", move: { act: "wave" } },
      {
        atMs: 2200,
        label: "a small nod",
        move: { gesture: "nodSoft", mood: { name: "delighted", intensity: 0.6 } },
      },
      { atMs: 3200, label: "settles", move: { release: true } },
    ],
  },
  sitAndTalk: {
    version: 1,
    id: "sit-and-talk",
    title: "Sitting down to talk",
    beats: [
      { atMs: 0, label: "sits", move: { act: "sit", mood: { name: "calm", intensity: 0.4 } } },
      {
        atMs: 2500,
        label: "leans in to listen",
        move: { gesture: "leanIn", look: { x: 0, y: 0.15, ms: 2500 } },
      },
      {
        atMs: 5200,
        label: "thinks",
        move: { gesture: "think", mood: { name: "thinking", intensity: 0.5 } },
      },
      {
        atMs: 7400,
        label: "answers",
        move: { gesture: "beatR", mood: { name: "happy", intensity: 0.4 } },
      },
    ],
  },
  dance: {
    version: 1,
    id: "dance",
    title: "A little dance",
    beats: [
      {
        atMs: 0,
        label: "starts",
        move: { act: "dance", mood: { name: "playful", intensity: 0.7 } },
      },
      { atMs: 4000, label: "a hop", move: { gesture: "hop" } },
      { atMs: 6000, label: "giggles", move: { gesture: "giggleOnce" } },
      {
        atMs: 8000,
        label: "stops",
        move: { act: "stand", mood: { name: "happy", intensity: 0.5 } },
      },
    ],
  },
  stretch: {
    version: 1,
    id: "stretch",
    title: "A morning stretch",
    beats: [
      {
        atMs: 0,
        label: "reaches up",
        move: {
          keys: [
            { atMs: 0, bones: { leftUpperArm: [0, 0, -1.2], rightUpperArm: [0, 0, 1.2] } },
            {
              atMs: 1200,
              bones: {
                leftUpperArm: [0, 0, 1.3],
                rightUpperArm: [0, 0, -1.3],
                spine: [-0.1, 0, 0],
              },
            },
          ],
          ms: 600,
        },
      },
      {
        atMs: 2400,
        label: "yawns",
        move: { gesture: "yawn", mood: { name: "sleepy", intensity: 0.4 } },
      },
      {
        atMs: 4200,
        label: "lets go",
        move: { release: true, mood: { name: "relieved", intensity: 0.5 } },
      },
    ],
  },
};
