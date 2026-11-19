/**
 * Body scenes (M-065, M-074): versioned, content-neutral timelines of moves on one or more bodies, with branches on
 * touch, words, feeling or a story flag. Errors teach. One migrator reads the viewer's beat lists (v0), v1 and v2,
 * and sends a Stories-format story (lines, not moves) to where stories play.
 */
import type { BodyCue } from "./bodyCues.ts";
import { decodeBodyMove, isPrivateMove, moveCues, type BodyMove } from "./bodyControl.ts";
import {
  preparePose,
  qFromEuler,
  qSlerp,
  qToEuler,
  type Rig,
  type RigIssue,
  type V3,
} from "./bodyRig.ts";

export const SCENE_VERSION = 2;
/** The body a beat moves when it names none: her own. */
const SCENE_BODY = "her";
const MAX_BEATS = 64;
const MAX_MS = 600_000;
const MAX_BODIES = 4;
const MAX_BRANCHES = 16;
const NAME = /^[a-z][\w-]{0,39}$/;
/** Feelings a branch can wait on (affect.ts dimensions and the private feel gauges), each -1..1 or 0..1. */
const SCENE_FEELINGS = [
  "valence",
  "arousal",
  "dominance",
  "comfort",
  "intimacy",
  "pleasure",
] as const;

export interface SceneBeat {
  readonly atMs: number;
  readonly label?: string;
  /** Which of the scene's bodies moves (one of `bodies`); her own when absent. */
  readonly body?: string;
  readonly move: BodyMove;
}
/** What a branch waits for: a hand on a part, words he says, a feeling crossing a line, or a story's flag. */
export type SceneCondition =
  | { readonly touch: { readonly part?: string; readonly kind?: string } }
  | { readonly speech: { readonly says: ReadonlyArray<string> } }
  | {
      readonly affect: {
        readonly feeling: (typeof SCENE_FEELINGS)[number];
        readonly above?: number;
        readonly below?: number;
      };
    }
  | { readonly flag: string };
export interface SceneBranch {
  readonly id: string;
  readonly on: SceneCondition;
  /** Played from the moment it fires, on the scene's bodies, times from then. */
  readonly beats: ReadonlyArray<SceneBeat>;
  /** Fires at most once per playing (the default); false lets it fire each time. */
  readonly once: boolean;
  /** After its beats: carry on with the scene where it was, or end it. */
  readonly after: "continue" | "end";
}
export interface BodyScene {
  readonly version: typeof SCENE_VERSION;
  readonly id: string;
  readonly title: string;
  readonly loop: boolean;
  /** The bodies it moves, first is hers: ["her"] for one body, ["her", "guest"] for two. */
  readonly bodies: ReadonlyArray<string>;
  readonly beats: ReadonlyArray<SceneBeat>;
  readonly branches: ReadonlyArray<SceneBranch>;
  /** From a pack that is private as a whole (it plays only in a private moment). */
  readonly private?: boolean;
  readonly pack?: string;
}
/** What happened while a scene plays, for its branches to answer. */
export type SceneEvent =
  | { readonly touch: { readonly part: string; readonly kind: string } }
  | { readonly speech: string }
  | { readonly affect: Readonly<Partial<Record<(typeof SCENE_FEELINGS)[number], number>>> }
  | { readonly flag: string };
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
  if (isObj(raw) && raw["version"] === 1)
    return {
      scene: { ...raw, version: SCENE_VERSION },
      notes: ["version 1 read as version 2 (one body, no branches)"],
    };
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
/** A story in the private layer's Stories format: roles, flags and beats that are lines in the conversation. */
const isStory = (raw: unknown): boolean =>
  isObj(raw) &&
  Array.isArray(raw["beats"]) &&
  raw["beats"].some((b) => isObj(b) && isObj(b["message"])) &&
  !raw["beats"].some((b) => isObj(b) && isObj(b["move"]));

type Err = (at: string, message: string, fix: string) => void;

const decodeBeats = (
  raw: unknown,
  where: string,
  bodies: ReadonlyArray<string>,
  err: Err,
): SceneBeat[] => {
  const list = Array.isArray(raw) ? raw : null;
  if (list === null || list.length === 0) {
    err(
      where,
      "needs beats",
      `add "${where.split(".").pop()}": [{"atMs": 0, "move": {"act": "wave"}}]`,
    );
    return [];
  }
  if (list.length > MAX_BEATS)
    err(where, `${list.length} beats is more than ${MAX_BEATS}`, "split it into scenes");
  const beats: SceneBeat[] = [];
  for (const [i, b] of list.slice(0, MAX_BEATS).entries()) {
    const at = `${where}[${i}]`;
    if (!isObj(b)) {
      err(at, "a beat is an object", '{"atMs": 1000, "move": {...}}');
      continue;
    }
    const atMs = b["atMs"];
    if (typeof atMs !== "number" || !Number.isFinite(atMs) || atMs < 0 || atMs > MAX_MS) {
      err(
        `${at}.atMs`,
        "atMs must be a time from the start, 0 to 600000 ms",
        "give each beat its start in ms",
      );
      continue;
    }
    const body = b["body"] === undefined ? undefined : String(b["body"]);
    if (body !== undefined && !bodies.includes(body))
      err(
        `${at}.body`,
        `"${body}" is not one of this scene's bodies (${bodies.join(", ")})`,
        `name it in "bodies", or use one of ${bodies.join(", ")}`,
      );
    // two bodies may move at the same moment; one body's beats keep their order
    const mine = beats.filter((x) => (x.body ?? bodies[0]) === (body ?? bodies[0]));
    if (mine.length > 0 && atMs <= mine.at(-1)!.atMs)
      err(
        `${at}.atMs`,
        `starts at ${atMs} ms, not after this body's beat before (${mine.at(-1)!.atMs} ms)`,
        "order each body's beats by time; two moves at once belong in one move",
      );
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
      ...(body !== undefined && body !== bodies[0] ? { body } : {}),
    });
  }
  return beats;
};

const decodeCondition = (raw: unknown, at: string, err: Err): SceneCondition | null => {
  const r = isObj(raw) ? raw : {};
  const fix =
    '{"touch": {"part": "head"}}, {"speech": {"says": ["dance"]}}, {"affect": {"feeling": "arousal", "above": 0.6}} or {"flag": "lights-off"}';
  const keys = ["touch", "speech", "affect", "flag"].filter((k) => r[k] !== undefined);
  if (keys.length !== 1) {
    err(at, "a branch waits on exactly one thing", fix);
    return null;
  }
  if (isObj(r["touch"])) {
    const t = r["touch"];
    return {
      touch: {
        ...(typeof t["part"] === "string" ? { part: t["part"] } : {}),
        ...(typeof t["kind"] === "string" ? { kind: t["kind"] } : {}),
      },
    };
  }
  if (isObj(r["speech"])) {
    const says = Array.isArray(r["speech"]["says"])
      ? r["speech"]["says"]
          .filter((x): x is string => typeof x === "string" && x.trim() !== "")
          .map((x) => x.toLowerCase().trim())
      : [];
    if (says.length === 0)
      err(
        `${at}.speech.says`,
        "speech needs the words to listen for",
        '"says": ["dance", "show me"]',
      );
    return { speech: { says } };
  }
  if (isObj(r["affect"])) {
    const a = r["affect"];
    const feeling = (SCENE_FEELINGS as ReadonlyArray<unknown>).includes(a["feeling"])
      ? (a["feeling"] as (typeof SCENE_FEELINGS)[number])
      : null;
    const line = (v: unknown) => (typeof v === "number" && v >= -1 && v <= 1 ? v : undefined);
    const above = line(a["above"]);
    const below = line(a["below"]);
    if (feeling === null)
      err(
        `${at}.affect.feeling`,
        "not a feeling the body knows",
        `one of ${SCENE_FEELINGS.join(", ")}`,
      );
    if (above === undefined && below === undefined)
      err(
        `${at}.affect`,
        "affect needs a line to cross",
        '"above": 0.6 or "below": -0.3 (each -1..1)',
      );
    return feeling === null
      ? null
      : {
          affect: {
            feeling,
            ...(above === undefined ? {} : { above }),
            ...(below === undefined ? {} : { below }),
          },
        };
  }
  if (typeof r["flag"] === "string" && NAME.test(r["flag"])) return { flag: r["flag"] };
  err(at, "this condition isn't readable", fix);
  return null;
};

/** A scene off the wire or out of a pack, migrated, bounded and checked; every error says how to fix it. */
export const decodeScene = (
  raw: unknown,
):
  | { readonly ok: true; readonly scene: BodyScene; readonly notes: ReadonlyArray<string> }
  | {
      readonly ok: false;
      readonly errors: ReadonlyArray<SceneError>;
    } => {
  if (isStory(raw))
    return {
      ok: false,
      errors: [
        {
          at: "",
          message: "this is a story (its beats are lines in the conversation), not a body scene",
          fix: 'play it as a story: an owner pack\'s "scenes" section or Settings › Stories; give a body scene beats with "move"',
        },
      ],
    };
  const { scene, notes } = migrateScene(raw);
  const errors: SceneError[] = [];
  const err: Err = (at, message, fix) => void errors.push({ at, message, fix });
  if (!isObj(scene))
    return {
      ok: false,
      errors: [
        {
          at: "",
          message: "a scene is an object",
          fix: '{"version": 2, "id": "greeting", "title": "...", "beats": [...]}',
        },
      ],
    };
  if (scene["version"] !== SCENE_VERSION)
    err(
      "version",
      `version ${String(scene["version"])} is not known`,
      `set "version": ${SCENE_VERSION}`,
    );
  const id = typeof scene["id"] === "string" && NAME.test(scene["id"]) ? scene["id"] : null;
  if (id === null)
    err(
      "id",
      "id is missing or not a short name",
      'use lowercase letters, digits, - or _, e.g. "greeting"',
    );
  const bodiesRaw = scene["bodies"] === undefined ? [SCENE_BODY] : scene["bodies"];
  const bodies = Array.isArray(bodiesRaw)
    ? bodiesRaw.filter((b): b is string => typeof b === "string" && NAME.test(b))
    : [];
  if (
    !Array.isArray(bodiesRaw) ||
    bodies.length !== bodiesRaw.length ||
    bodies.length === 0 ||
    new Set(bodies).size !== bodies.length
  )
    err(
      "bodies",
      "bodies must be distinct short names",
      `e.g. "bodies": ["${SCENE_BODY}", "guest"]`,
    );
  if (bodies.length > MAX_BODIES)
    err("bodies", `${bodies.length} bodies is more than ${MAX_BODIES}`, "split it into scenes");
  const named = bodies.length > 0 ? bodies : [SCENE_BODY];
  const beats = decodeBeats(scene["beats"], "beats", named, err);
  const branchesRaw = scene["branches"] === undefined ? [] : scene["branches"];
  const branches: SceneBranch[] = [];
  if (!Array.isArray(branchesRaw))
    err(
      "branches",
      "branches is a list",
      '"branches": [{"id": "on-pat", "on": {...}, "beats": [...]}]',
    );
  else {
    if (branchesRaw.length > MAX_BRANCHES)
      err(
        "branches",
        `${branchesRaw.length} branches is more than ${MAX_BRANCHES}`,
        "split it into scenes",
      );
    for (const [i, b] of branchesRaw.slice(0, MAX_BRANCHES).entries()) {
      const at = `branches[${i}]`;
      if (!isObj(b)) {
        err(
          at,
          "a branch is an object",
          '{"id": "on-pat", "on": {"touch": {"part": "head"}}, "beats": [...]}',
        );
        continue;
      }
      const bid = typeof b["id"] === "string" && NAME.test(b["id"]) ? b["id"] : null;
      if (bid === null) err(`${at}.id`, "a branch needs a short id", '"id": "on-pat"');
      else if (branches.some((x) => x.id === bid))
        err(`${at}.id`, `id ${bid} is used twice`, "give each branch its own id");
      const on = decodeCondition(b["on"], `${at}.on`, err);
      const bb = decodeBeats(b["beats"], `${at}.beats`, named, err);
      const after =
        b["after"] === undefined || b["after"] === "continue"
          ? "continue"
          : b["after"] === "end"
            ? "end"
            : null;
      if (after === null) err(`${at}.after`, "after is continue or end", '"after": "end"');
      if (bid !== null && on !== null)
        branches.push({
          id: bid,
          on,
          beats: bb,
          once: b["once"] !== false,
          after: after ?? "continue",
        });
    }
  }
  if (errors.length > 0 || id === null) return { ok: false, errors };
  return {
    ok: true,
    scene: {
      version: SCENE_VERSION,
      id,
      title: typeof scene["title"] === "string" ? scene["title"].slice(0, 120) : id,
      loop: scene["loop"] === true,
      bodies: named,
      beats,
      branches,
      ...(scene["private"] === true ? { private: true } : {}),
      ...(typeof scene["pack"] === "string" ? { pack: scene["pack"].slice(0, 60) } : {}),
    },
    notes,
  };
};

/**
 * A pack of scenes: `{"version": 1, "pack": "name", "private": false, "scenes": [...]}`. Each scene is decoded on its
 * own; a bad one is reported with its place and fix and the rest still load. A private pack's scenes are private.
 */
export const decodeScenePack = (
  raw: unknown,
): { readonly scenes: ReadonlyArray<BodyScene>; readonly errors: ReadonlyArray<SceneError> } => {
  const r = isObj(raw) ? raw : {};
  const pack = typeof r["pack"] === "string" && NAME.test(r["pack"]) ? r["pack"] : null;
  const errors: SceneError[] = [];
  if (pack === null)
    errors.push({ at: "pack", message: "a pack needs a short name", fix: '"pack": "everyday"' });
  if (!Array.isArray(r["scenes"]))
    return {
      scenes: [],
      errors: [
        ...errors,
        {
          at: "scenes",
          message: "a pack has a list of scenes",
          fix: '"scenes": [{"version": 2, ...}]',
        },
      ],
    };
  const scenes: BodyScene[] = [];
  for (const [i, s] of r["scenes"].entries()) {
    const d = decodeScene(
      isObj(s)
        ? { ...s, ...(pack ? { pack } : {}), ...(r["private"] === true ? { private: true } : {}) }
        : s,
    );
    if (!d.ok)
      for (const e of d.errors) errors.push({ ...e, at: `scenes[${i}]${e.at ? "." + e.at : ""}` });
    else if (scenes.some((x) => x.id === d.scene.id))
      errors.push({
        at: `scenes[${i}].id`,
        message: `id ${d.scene.id} is used twice in the pack`,
        fix: "give each scene its own id",
      });
    else scenes.push(d.scene);
  }
  return { scenes, errors };
};

/** The branch that answers an event now, if any: the first whose condition holds and that may still fire. */
export const branchFor = (
  s: BodyScene,
  event: SceneEvent,
  fired: ReadonlySet<string> = new Set(),
): SceneBranch | null =>
  s.branches.find((b) => {
    if (b.once && fired.has(b.id)) return false;
    const on = b.on;
    if ("touch" in on && "touch" in event)
      return (
        (on.touch.part === undefined || on.touch.part === event.touch.part) &&
        (on.touch.kind === undefined || on.touch.kind === event.touch.kind)
      );
    if ("speech" in on && "speech" in event) {
      const said = ` ${event.speech.toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, " ")} `;
      return on.speech.says.some((w) => said.includes(` ${w} `));
    }
    if ("affect" in on && "affect" in event) {
      const v = event.affect[on.affect.feeling];
      return (
        v !== undefined &&
        (on.affect.above === undefined || v > on.affect.above) &&
        (on.affect.below === undefined || v < on.affect.below)
      );
    }
    if ("flag" in on && "flag" in event) return on.flag === event.flag;
    return false;
  }) ?? null;

/**
 * Where one body's bones are at a time in the scene, between the beats that pose them (direct bones and keyframes),
 * blended joint by joint along the shortest turn: what a scrubbed timeline shows. Beats without bones (an act, a
 * mood) are listed as the last one reached, for the caller to show.
 */
export const poseAt = (
  s: BodyScene,
  t: number,
  body: string = s.bodies[0] ?? SCENE_BODY,
): { readonly bones: Readonly<Record<string, V3>>; readonly beat: number } => {
  const mine = s.beats
    .map((b, i) => ({ b, i }))
    .filter(({ b }) => (b.body ?? s.bodies[0]) === body);
  const keys = mine.flatMap(({ b }) =>
    b.move.keys !== undefined
      ? b.move.keys.map((k) => ({ at: b.atMs + k.atMs, bones: k.bones as Record<string, V3> }))
      : b.move.bones !== undefined
        ? [{ at: b.atMs + (b.move.ms ?? 0), bones: b.move.bones as Record<string, V3> }]
        : [],
  );
  const beat = mine.filter(({ b }) => b.atMs <= t).at(-1)?.i ?? -1;
  const bones: Record<string, V3> = {};
  for (const bone of new Set(keys.flatMap((k) => Object.keys(k.bones)))) {
    const has = keys.filter((k) => k.bones[bone] !== undefined);
    const before = has.filter((k) => k.at <= t).at(-1);
    const after = has.find((k) => k.at > t);
    if (before === undefined) continue;
    if (after === undefined) {
      bones[bone] = before.bones[bone]!;
      continue;
    }
    const f = (t - before.at) / (after.at - before.at);
    bones[bone] = qToEuler(
      qSlerp(qFromEuler(before.bones[bone]!), qFromEuler(after.bones[bone]!), f),
    );
  }
  return { bones, beat };
};

/** Whether any beat belongs to a private moment (the same gate as a single move). */
export const isPrivateScene = (s: BodyScene): boolean =>
  s.private === true ||
  [...s.beats, ...s.branches.flatMap((b) => b.beats)].some((b) => isPrivateMove(b.move));

/** The cues a scene becomes: its first beat now (when it starts at 0), the rest as one timed sequence. */
export const sceneCues = (
  s: BodyScene,
  body: string = s.bodies[0] ?? SCENE_BODY,
  beats: ReadonlyArray<SceneBeat> = s.beats,
): BodyCue[] => {
  const steps = beats
    .map((b, i) => ({ b, i }))
    .filter(({ b }) => (b.body ?? s.bodies[0]) === body)
    .map(({ b, i }) => ({ atMs: b.atMs, cues: moveCues(b.move, `${s.id}-${i}`) }));
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
  [
    ...s.beats.map((b, i) => ({ b, at: `beats[${i}]` })),
    ...s.branches.flatMap((br, j) =>
      br.beats.map((b, i) => ({ b, at: `branches[${j}].beats[${i}]` })),
    ),
  ].flatMap(({ b, at }) => {
    const frames =
      b.move.keys?.map((k) => k.bones) ?? (b.move.bones === undefined ? [] : [b.move.bones]);
    const corrected = frames.flatMap((f) => preparePose(rig, f as Record<string, V3>).issues);
    return corrected.length === 0 ? [] : [{ at, label: b.label ?? at, corrected }];
  });

/** Everyday scenes every body has (content-neutral): a starting point to copy, and what the tool plays by name. */
export const CORE_SCENES: Readonly<Record<string, unknown>> = {
  greeting: {
    version: 2,
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
    version: 2,
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
    version: 2,
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
    version: 2,
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
