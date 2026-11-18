// @effect-diagnostics globalTimers:off globalDate:off globalRandom:off nodeBuiltinImport:off
/**
 * The desktop mascot: one character in a see-through window her own size, on top of everything. She stands on the top
 * edge of the window he is in or on a screen's floor above the taskbar (mascotDock.ts), takes the mouse only over her
 * body, and reacts to Tessaya's turn and jobs with one cue per change (tessaya-shared/companion). At rest nothing draws.
 */
import * as Electron from "electron";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import {
  cueFor,
  momentOf,
  restFaceOf,
  rigGestureOf,
  rigMoodOf,
  wanders,
  type CompanionMoment,
  type CompanionMotion,
  type MascotAct,
} from "@t3tools/tessaya-shared/companion";
import type { TurnPhase } from "@t3tools/tessaya-shared/voiceTurn";
import type { Persona } from "@t3tools/tessaya-shared/osPack";

import { protectFromCapture } from "../captureProtection.ts";
import { markCompanionWindow } from "../lastAppWindow.ts";
import {
  FOOT_SHARE,
  bodyRect,
  dropAt,
  SQUISH_MS,
  isPoke,
  isStill,
  stroke,
  type Strokes,
  edgesFor,
  followFocus,
  landing,
  pathBetween,
  standAt,
  wanderTo,
  type DisplayArea,
  type Edge,
  type Rect,
} from "./mascotDock.ts";
import { MASCOT_SCRIPT } from "./mascotPage.ts";
import type { VoiceShape } from "../voice/voiceSpeaker.ts";
import {
  DEFAULT_PROFILE,
  flightProfile,
  type PhysicsProfile,
  STEP_S,
  resting,
  screenOf,
  stepFlight,
  bumpOf,
  type Standing,
  throwVelocity,
  type Flight,
} from "./mascotPhysics.ts";

export type MascotSize = "small" | "medium" | "large";
export const MASCOT_SIZES: Readonly<Record<MascotSize, number>> = {
  small: 120,
  medium: 150,
  large: 190,
};
export const parseMascotSize = (value: unknown): MascotSize =>
  value === "small" || value === "large" ? value : "medium";

/** The Character Studio's characters (bodies.js), by id, with the names his drafts use. */
export const MASCOT_CHARACTERS = {
  selvedge: "Selvedge",
  felt: "Felt",
  tweed: "Tweed",
  spool: "Spool",
  purl: "Purl",
  pebble: "Pebble",
  thread: "Thread",
  loom: "Loom",
  drop: "Drop",
  shuttle: "Shuttle",
  swatch: "Swatch",
  thimble: "Thimble",
  mark: "Mark",
} as const;
export type MascotCharacter = keyof typeof MASCOT_CHARACTERS | "persona";
export const parseMascotCharacter = (value: unknown): MascotCharacter =>
  typeof value === "string" && Object.hasOwn(MASCOT_CHARACTERS, value)
    ? (value as MascotCharacter)
    : "persona";
/** Arms with drawn hands (his pick, 13 Nov), or the hands floating beside her. */
export type MascotHands = "arms" | "float";
export const parseMascotHands = (value: unknown): MascotHands =>
  value === "float" ? "float" : "arms";

/** How loud her body's sounds and her bed are (Settings → Desktop companion); Off plays nothing. */
export type MascotSound = "off" | "soft" | "normal" | "full";
export const parseMascotSound = (value: unknown): MascotSound =>
  value === "off" || value === "soft" || value === "full" ? value : "normal";
/** Each level's gain over sounds.js's own; her bed as it plays is about -25 LUFS at Normal, -27.5 Soft, -22.5 Full. */
export const SOUND_GAIN: Readonly<Record<MascotSound, number>> = {
  off: 0,
  soft: 0.75,
  normal: 1,
  full: 1.33,
};
export const SOUND_LEVELS: ReadonlyArray<{ readonly value: MascotSound; readonly label: string }> =
  [
    { value: "off", label: "Off" },
    { value: "soft", label: "Soft" },
    { value: "normal", label: "Normal" },
    { value: "full", label: "Full" },
  ];

/** Where a throw may take her: only the screen she is thrown on, or every screen as one desktop in its real layout. */
export type MascotScreens = "one" | "span";
export const parseMascotScreens = (value: unknown): MascotScreens =>
  value === "one" ? "one" : "span";

/**
 * The body a persona wears, from her persona record (SPINE-UNIFY §10, P3): `persona` names the studio's preset
 * (bodies.js TCS.PERSONAS, "custom" for one the studio has no preset for), and the record's character and traits win.
 */
export interface PersonaBody {
  readonly persona: string;
  readonly character?: string;
  readonly traits?: Readonly<Record<string, number>>;
}

const STUDIO_PRESETS = new Set(["tessaya", "freya", "alfred", "sebastian"]);

/** His chosen persona (its name or id, any case) in the roster, as the body the mascot and the pill draw. */
export const bodyOf = (personas: ReadonlyArray<Persona>, chosen: string): PersonaBody => {
  const key = chosen.toLowerCase();
  const p = personas.find((x) => x.id === key || x.name.toLowerCase() === key);
  const preset = STUDIO_PRESETS.has(key) ? key : "custom";
  return {
    persona: preset,
    ...(p?.character === undefined ? {} : { character: p.character }),
    ...(p?.traits === undefined ? {} : { traits: p.traits }),
  };
};

/** The mascot's persona choices: every persona in his pack, custom ones included. */
export const mascotChoices = (personas: ReadonlyArray<Persona>) =>
  personas.map((p) => ({ value: p.name.toLowerCase(), label: p.name }));

/** Who else is on his desktop: "none", "all", or personas by lower-case name or id, comma-separated (Settings → Cast). */
export const parseMascotCrew = (value: unknown): string =>
  value === "all" ||
  (typeof value === "string" && /^[a-z][a-z0-9 -]{0,40}(,[a-z][a-z0-9 -]{0,40}){0,11}$/.test(value))
    ? value
    : "none";

export const parseMascotPersona = (value: unknown): string =>
  typeof value === "string" && /^[a-z][a-z0-9 -]{0,40}$/i.test(value)
    ? value.toLowerCase()
    : "tessaya";

const ACT_CLIPS: Partial<Record<MascotAct, string>> = { hop: "hop", wave: "wave", nod: "nodSmall" };

/** What he does to her body that her persona may answer (tessaya-shared LINE_EVENTS). */
export type MascotMoment =
  | "moment.poked"
  | "moment.squished"
  | "moment.thrown"
  | "moment.petted"
  | "moment.screen"
  | "moment.met"
  | "moment.idle"
  | "moment.bumped";
/** One answer at a time, and none sooner than this after the last: a flurry of pokes gets one line. */
const MOMENT_GAP_MS = 6_000;
/** Her body's half-width and height inside her window, as shares of its size (the rig's body at rest). */
const BODY_HALF = 0.26;
const BODY_TALL = 0.47;
/** Two at rest closer than this many of her widths meet; a pair greets again only after this long apart. */
const MEET_SIZES = 1.3;
const MET_AGAIN_MS = 5 * 60_000;

/**
 * The other characters on his desktop (one window each), so they can stand on each other's heads, bump apart and
 * greet. Each member is one mascot; the set is shared by every mascot the desktop made.
 */
export interface CrowdMember {
  readonly id: string;
  /** Her head as an edge another can stand on, while she rests; null otherwise. */
  readonly head: () => Edge | null;
  /** Where she stands (her feet), while she rests on an edge. */
  readonly feet: () => { readonly x: number; readonly y: number; readonly display: number } | null;
  /** The one under her moved: she falls from where she is. */
  readonly fall: () => void;
  /** Another greets her from this side (-1 left, 1 right); landed on her when `under`. */
  readonly greet: (side: number, under: boolean) => void;
  /** Has her look toward a side and do one of her acts (a hand-off between personas). */
  readonly gesture: (act: MascotAct, side: number) => void;
  /** Her body while she stands still, for another flying into her; null otherwise. */
  readonly standing: () => Standing | null;
  /** Another flew into her: she is knocked along at this speed (px/s, its sign the way). */
  readonly knock: (vx: number) => void;
}
export type Crowd = Set<CrowdMember>;

/** A throw at least this fast is one she remarks on. */
const THROWN_SPEED = 1_500;

/** The brain's answer as the page shows it: words, a face and a gesture; anything else is dropped. */
export const sayOf = (raw: unknown): { text: string; mood?: string; gesture?: string } | null => {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const value = (typeof r["value"] === "object" && r["value"] !== null ? r["value"] : r) as Record<
    string,
    unknown
  >;
  const word = (k: string) =>
    typeof value[k] === "string" && /^[A-Za-z]{1,20}$/.test(value[k] as string)
      ? (value[k] as string)
      : undefined;
  const text = typeof value["text"] === "string" ? value["text"].slice(0, 120) : "";
  // the brain's names (tessaya-contracts expression.ts) as the rig's
  const moodWord = word("mood");
  const gestureWord = word("gesture");
  const mood = moodWord === undefined ? undefined : rigMoodOf(moodWord);
  const gesture = gestureWord === undefined ? undefined : rigGestureOf(gestureWord);
  if (text === "" && mood === undefined && gesture === undefined) return null;
  return {
    text,
    ...(mood === undefined ? {} : { mood }),
    ...(gesture === undefined ? {} : { gesture }),
  };
};

export interface MascotOptions {
  readonly on: boolean;
  readonly motion: CompanionMotion;
  readonly persona: PersonaBody;
  readonly size: MascotSize;
  readonly reduced: boolean;
  readonly screens: MascotScreens;
  /** Her body: the persona's own character, or one he picked from the Studio's. */
  readonly character: MascotCharacter;
  readonly hands: MascotHands;
  /** Her body's sounds as he pokes, drags and drops her, and the bed under her presence (one per desktop: hers). */
  readonly sounds: MascotSound;
  readonly bed: MascotSound;
}

export interface DesktopMascot {
  readonly setOptions: (options: MascotOptions) => void;
  /** The pill's phase: her moment follows it, except dictation. */
  readonly turn: (phase: TurnPhase) => void;
  /** Her own voice's level while she speaks, for the mouth. */
  readonly level: (value: number, shape?: VoiceShape) => void;
  /** The sentence her voice is playing now: her gestures land on its words by meaning. */
  readonly line: (text: string, bubble?: boolean) => void;
  /** Her window on screen (DIP) while she shows, so the pill opens clear of her. */
  readonly bounds: () => Rect | null;
  /** Her mood from the spine (TessayaMood, CS6) and how strongly, which she wears at rest. */
  readonly mood: (label: string, intensity: number) => void;
  /** A face for a moment of her speech (a laugh), which her rig lets go of by itself; false when she is not showing. */
  readonly expression: (face: string) => boolean;
  /** A job finished, failed or started waiting for him. */
  readonly react: (moment: CompanionMoment) => void;
  /** The window he is in (DIP, null when unknown) and whether it fills its screen. */
  readonly foreground: (window: Rect | null, fullscreen: boolean) => void;
  /** Quiet hours, Do not disturb or a snooze of all of Tessaya: asleep, and still. */
  readonly asleep: (on: boolean) => void;
  /** Something the brain or an agent has her do (the device registry's `mascot.do`); false when she cannot now. */
  readonly act: (what: MascotAct) => boolean;
  /**
   * An owner-only persona layer's body for her while its session is open on this desktop (PersonaLayers.ts): its page,
   * out of capture, drawn over her in place, and her own rig hidden underneath; null puts her back. Content-free here.
   */
  readonly layerBody: (
    page: { readonly url: string; readonly session: Electron.Session } | null,
  ) => void;
  /** A cue for the layer's body (her speech and mood as they happen); nothing while none is shown. */
  readonly layerCue: (cue: unknown) => void;
  readonly dispose: () => void;
}

interface Saved {
  readonly x?: number;
  readonly snoozeUntil?: number;
  readonly hiddenUntil?: number;
  /** He put her somewhere himself: she stays there instead of following his windows. */
  readonly placed?: boolean;
}

const HIT_NEAR_MS = 80;
const HIT_FAR_MS = 400;
const NEAR_PX = 60;
const FRAME_MS = 16;
const DRAG_MS = 16;
/** A landing or a wall at least this fast is felt as an impact (a squash by its speed). */
const IMPACT_SPEED = 300;
const SNOOZE_MS = 60 * 60_000;
/** A wander is considered once a minute, and taken about one time in six: every few minutes, never on a beat. */
const WANDER_CHECK_MS = 60_000;
const WANDER_CHANCE = 1 / 6;
/** He is at the computer, but not typing this second. */
const WANDER_IDLE_S: readonly [number, number] = [3, 120];
const BED_AWAY_S = 120;
/** Away this long (no keys or mouse), her blinks and idle acts wait for him, as a still window's indicators do. */
const HOLD_AWAY_S = 60;
/** A wander that also brings a remark of hers to herself: about one every 25 minutes he works quietly. */
const REMARK_CHANCE = 1 / 4;

const nextMorning = (now: number): number => {
  const at = new Date(now);
  at.setHours(6, 0, 0, 0);
  if (at.getTime() <= now) at.setDate(at.getDate() + 1);
  return at.getTime();
};

const readSaved = (file: string): Saved => {
  try {
    const value = JSON.parse(NodeFS.readFileSync(file, "utf8")) as Record<string, unknown>;
    const num = (key: string) =>
      typeof value[key] === "number" ? (value[key] as number) : undefined;
    return {
      ...(num("x") === undefined ? {} : { x: num("x")! }),
      ...(num("snoozeUntil") === undefined ? {} : { snoozeUntil: num("snoozeUntil")! }),
      ...(num("hiddenUntil") === undefined ? {} : { hiddenUntil: num("hiddenUntil")! }),
      ...(value["placed"] === true ? { placed: true } : {}),
    };
  } catch {
    return {};
  }
};

const displays = (): ReadonlyArray<DisplayArea> =>
  Electron.screen
    .getAllDisplays()
    .map((d) => ({ id: d.id, bounds: d.bounds, workArea: d.workArea, scaleFactor: d.scaleFactor }));

export const createDesktopMascot = (input: {
  /** Her characters' folder (COMPANION_DIR): the stage page and the studio's scripts. */
  readonly companionDir: string;
  readonly stateDir: string;
  readonly openSettings: () => void;
  /** Opens his private chat window, or null when there is none to open. */
  readonly privateChat?: () => (() => void) | null;
  /** Her place file's name beside the others' (one per character on his desktop); unset is the first. */
  readonly key?: string;
  readonly crowd?: Crowd;
  /** Her place in the line-up, so characters first shown together do not stand in one spot. */
  readonly slot?: number;
  readonly onNote?: (kind: string, detail: Record<string, unknown>) => void;
  /**
   * What he did to her body, for the brain to word in her persona (the voice door's `express`). The physics never waits
   * on it; a failure leaves her own reaction alone.
   */
  readonly express?: (event: MascotMoment) => Promise<unknown>;
  /** Her answer's words aloud, in her voice (the caller keeps quiet hours and Do not disturb). */
  readonly speak?: (text: string) => void;
}): DesktopMascot => {
  const file = NodePath.join(
    input.stateDir,
    input.key === undefined ? "baton-mascot.json" : `baton-mascot-${input.key}.json`,
  );
  let saved = readSaved(file);
  const save = (next: Saved) => {
    saved = { ...saved, ...next };
    try {
      NodeFS.writeFileSync(file, JSON.stringify(saved));
    } catch {
      // Only her place is lost.
    }
  };

  let options: MascotOptions = {
    on: false,
    motion: "calm",
    persona: { persona: "tessaya" },
    size: "medium",
    reduced: false,
    screens: "span",
    character: "persona",
    hands: "arms",
    sounds: "normal",
    bed: "off",
  };
  let win: Electron.BrowserWindow | null = null;
  let ready: Promise<void> = Promise.resolve();
  let fg: Rect | null = null;
  let fullscreen = false;
  let sleeping = false;
  let away = false;
  let held = false;
  let phase: TurnPhase = "idle";
  let edge: Edge | null = null;
  // A place saved on a screen no longer there (or off every work area) starts her afresh.
  let x =
    saved.x !== undefined &&
    displays().some((d) => saved.x! >= d.workArea.x && saved.x! <= d.workArea.x + d.workArea.width)
      ? saved.x
      : -1;
  let dragging: {
    readonly timer: ReturnType<typeof setInterval>;
    readonly samples: Array<{ readonly x: number; readonly y: number; readonly t: number }>;
    readonly pressedAt: number;
    squished: boolean;
  } | null = null;
  let moving: ReturnType<typeof setInterval> | null = null;
  let hitTimer: ReturnType<typeof setTimeout> | null = null;
  let takingMouse = false;
  let wakeTimer: ReturnType<typeof setTimeout> | null = null;

  const size = () => MASCOT_SIZES[options.size];
  // Every move sets her size too: setPosition alone lets Windows grow her across screens of different scale.
  const box = (at: { readonly x: number; readonly y: number }) => ({
    x: Math.round(at.x),
    y: Math.round(at.y),
    width: size(),
    height: size(),
  });
  const snoozed = () => (saved.snoozeUntil ?? 0) > Date.now();
  const hidden = () => (saved.hiddenUntil ?? 0) > Date.now();
  const wanted = () => options.on && !hidden() && !fullscreen;
  const others = () => [...(input.crowd ?? [])].filter((m) => m !== self);
  /** The heads of the others at rest: edges she can land and stand on. */
  const heads = () => others().flatMap((m) => m.head() ?? []);
  // Heads are for landing on in flight only: placing her (his window, the taskbar, a menu pick) never picks one.
  const edges = () => edgesFor({ displays: displays(), window: fg, size: size() });
  /** Whoever stands on her head falls when she moves. */
  let leaving = false;
  const shrugOff = () => {
    const mine = self.head();
    if (mine === null) return;
    leaving = true;
    for (const m of others()) {
      const f = m.feet();
      if (f !== null && Math.abs(f.y - mine.y) < 2 && f.x >= mine.x1 - 4 && f.x <= mine.x2 + 4)
        m.fall();
    }
    leaving = false;
  };
  const met = new Map<string, number>();
  /** At rest: a head she landed on is told, and a neighbour close by is greeted (both, once in a while). */
  const meet = () => {
    const here = self.feet();
    if (here === null) return;
    const now = Date.now();
    for (const m of others()) {
      const there = m.feet();
      const head = m.head();
      const under =
        head !== null && Math.abs(head.y - here.y) < 2 && here.x >= head.x1 && here.x <= head.x2;
      const near =
        there !== null &&
        there.display === here.display &&
        Math.abs(there.y - here.y) < 4 &&
        Math.abs(there.x - here.x) < size() * MEET_SIZES;
      const fresh = now - (met.get(m.id) ?? 0) >= MET_AGAIN_MS;
      if (!under && !(near && fresh)) continue;
      const side = (there?.x ?? here.x) < here.x ? -1 : 1;
      m.greet(-side, under);
      if (!fresh) continue;
      met.set(m.id, now);
      call(`window.mascot.look(${side * 0.9},0)`);
      call(`window.mascot.react("hello",0)`);
      moment("moment.met");
    }
  };

  let veil: Electron.BrowserWindow | null = null;
  const placeVeil = () => {
    if (veil === null || veil.isDestroyed() || win === null || win.isDestroyed()) return;
    veil.setBounds(win.getBounds());
  };
  const dropVeil = () => {
    if (veil !== null && !veil.isDestroyed()) veil.destroy();
    veil = null;
    call(`document.body.style.opacity = ""`);
  };

  const call = (code: string) => {
    const target = win;
    void ready.then(() => {
      if (target !== null && !target.isDestroyed())
        void target.webContents.executeJavaScript(code).catch(() => undefined);
    });
  };
  /** Her mood from the spine (CS6), worn whenever she is at rest; null is her plain rest. */
  let restMood: ReturnType<typeof restFaceOf> = null;
  const cue = (moment: CompanionMoment) => {
    const shown = sleeping ? "asleep" : snoozed() && moment === "rest" ? "asleep" : moment;
    const next = cueFor(shown, options.motion);
    if (next === null) return;
    // Plain rest puts a mood's prop away.
    const worn = shown === "rest" ? { ...next, ...(restMood ?? { prop: null }) } : next;
    call(`window.mascot.cue(${JSON.stringify(worn)})`);
  };

  const stopMoving = () => {
    if (moving !== null) clearInterval(moving);
    moving = null;
  };
  /** Walks or falls her window along a path, a frame at a time, then stops; nothing moves between. */
  const glide = (
    to: { readonly x: number; readonly y: number },
    frames: number,
    done?: () => void,
  ) => {
    const target = win;
    if (target === null || target.isDestroyed()) return;
    stopMoving();
    // Frames are counted at 30 a second; she moves at 60, so the same move takes the same time, twice as smoothly.
    const steps = pathBetween(target.getBounds(), to, Math.max(1, frames) * 2);
    let i = 0;
    let from = target.getBounds();
    moving = setInterval(() => {
      const step = steps[i++];
      if (step === undefined || target.isDestroyed()) {
        stopMoving();
        call(`window.mascot.motion(0,0)`);
        done?.();
        return;
      }
      // she leans and stretches with the move, as in a throw
      const s = 1000 / FRAME_MS;
      call(
        `window.mascot.motion(${Math.round((step.x - from.x) * s)},${Math.round((step.y - from.y) * s)})`,
      );
      from = { ...from, ...step };
      target.setBounds(box(step));
    }, FRAME_MS);
  };
  const standOn = (next: Edge, at: number, frames = 0) => {
    edge = next;
    x = at;
    const spot = standAt(next, at, size(), snoozed() && next.kind === "floor");
    save({ x: at });
    if (frames === 0) win?.setBounds(box(spot));
    else glide(spot, frames);
  };
  /** Back to where she belongs: the window he is in, else the floor under where she was. */
  const settle = () => {
    const all = edges();
    const home = snoozed()
      ? landing(
          all.filter((e) => e.kind === "floor"),
          x,
          Infinity,
        )
      : (all.find((e) => e.kind === "window") ?? landing(all, x, 0));
    const at =
      x >= home.x1 && x <= home.x2
        ? x
        : Math.max(home.x1 + size() / 2, home.x2 - size() * (1 + 1.2 * (input.slot ?? 0)));
    standOn(home, at);
  };

  const stopHitTest = () => {
    if (hitTimer !== null) clearTimeout(hitTimer);
    hitTimer = null;
  };
  /** Something happened to her body: her character reacts in its own way and returns to her mood by itself (rig.react). */
  const react = (kind: "pickup" | "land" | "wall" | "poke" | "pet" | "bump", speed = 0) =>
    call(`window.mascot.react(${JSON.stringify(kind)},${Math.round(speed)})`);
  /** Her eyes follow the cursor while it is near; sent only when the look changes. */
  let looking = "";
  const lookAt = (gx: number | null, gy = 0) => {
    const next = gx === null ? "null" : `${gx.toFixed(2)},${gy.toFixed(2)}`;
    if (next === looking) return;
    looking = next;
    call(`window.mascot.look(${next})`);
  };
  let strokes: Strokes = { points: [] };
  let pettedAt = 0;

  /** The window takes the mouse exactly while the cursor is over her body, decided here; the rest clicks through. */
  const hitTest = () => {
    hitTimer = null;
    const target = win;
    if (target === null || target.isDestroyed() || !target.isVisible()) return;
    const cursor = Electron.screen.getCursorScreenPoint();
    const b = target.getBounds();
    const body = bodyRect(b.width);
    const dx = cursor.x - b.x - body.x;
    const dy = cursor.y - b.y - body.y;
    const over = dragging !== null || (dx >= 0 && dy >= 0 && dx < body.width && dy < body.height);
    const near =
      over ||
      (dx > -NEAR_PX && dy > -NEAR_PX && dx < body.width + NEAR_PX && dy < body.height + NEAR_PX);
    if (over && dragging === null && !sleeping) {
      const now = Date.now();
      const next = stroke(strokes, cursor.x, now, body.width);
      strokes = next.state;
      if (next.petted && now - pettedAt > 3000) {
        pettedAt = now;
        react("pet");
        moment("moment.petted");
      }
    } else if (strokes.points.length > 0) strokes = { points: [] };
    // within reach she watches the cursor; past it she looks ahead again
    if (near && dragging === null && !sleeping) {
      const round = (v: number) => Math.round(Math.max(-1, Math.min(1, v)) * 10) / 10;
      lookAt(
        round((dx - body.width / 2) / (body.width * 1.5)),
        round((dy - body.height / 2) / (body.height * 2)),
      );
    } else lookAt(null);
    if (over !== takingMouse) {
      takingMouse = over;
      target.setIgnoreMouseEvents(!over, { forward: true });
    }
    hitTimer = setTimeout(hitTest, near ? HIT_NEAR_MS : HIT_FAR_MS);
    hitTimer.unref();
  };

  const build = () => {
    if (win !== null && !win.isDestroyed()) return win;
    const created = new Electron.BrowserWindow({
      width: size(),
      height: size(),
      frame: false,
      transparent: true,
      resizable: false,
      focusable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        // her body's sounds play without a click on her first
        autoplayPolicy: "no-user-gesture-required",
        preload: NodePath.join(__dirname, "mascotPreload.cjs"),
      },
    });
    created.setAlwaysOnTop(true, "floating");
    created.setIgnoreMouseEvents(true, { forward: true });
    takingMouse = false;
    markCompanionWindow(created);
    protectFromCapture(created, () => {
      takingMouse = false;
      created.setIgnoreMouseEvents(true, { forward: true });
    });
    created.on("closed", () => {
      if (win === created) win = null;
      stopHitTest();
      stopMoving();
    });
    // The layer's body goes wherever she goes.
    created.on("move", () => placeVeil());
    created.on("resize", () => placeVeil());
    win = created;
    const stage = NodeURL.pathToFileURL(NodePath.join(input.companionDir, "stage.html")).href;
    ready = created
      .loadURL(stage)
      .then(() => created.webContents.executeJavaScript(MASCOT_SCRIPT))
      .then(() => undefined)
      .catch((cause: unknown) => input.onNote?.("mascot_load_failed", { cause: String(cause) }));
    return created;
  };

  /** Her character's flight (heavier falls harder, plush bounces more), read from her page once she is drawn. */
  let profile: PhysicsProfile = DEFAULT_PROFILE;
  const init = () => {
    call(
      `window.mascot.init(${JSON.stringify({ persona: options.character === "persona" ? options.persona : { ...options.persona, character: options.character }, quiet: options.motion === "important", calm: options.motion === "calm", reduced: options.reduced, hands: options.hands })})`,
    );
    call(`window.mascot.hold(${held})`);
    const target = win;
    void ready.then(async () => {
      if (target === null || target.isDestroyed()) return;
      profile = flightProfile(
        await target.webContents.executeJavaScript("window.mascot.physics()").catch(() => null),
      );
    });
  };

  /** His sound levels, and whether the bed steps back: she shows, and he is talking to her or dictating (the mic). */
  const audio = () =>
    call(
      `window.mascot.audio(${JSON.stringify({ physics: SOUND_GAIN[options.sounds], bed: away ? 0 : SOUND_GAIN[options.bed], shown: wanted(), listening: phase === "listening" || phase === "dictating" })})`,
    );

  /** Shows, hides or builds her window to match his settings, a snooze or hide, and a full-screen app. */
  const apply = () => {
    if (!wanted()) {
      if (win !== null && !win.isDestroyed()) {
        audio();
        if (options.on) win.hide();
        else win.destroy();
      }
      stopHitTest();
      return;
    }
    const target = build();
    init();
    audio();
    if (edge === null || !target.isVisible()) settle();
    if (!target.isVisible()) target.showInactive();
    cue(momentOf(phase) ?? "rest");
    if (hitTimer === null) hitTest();
  };

  /** Snooze and hide end on their own: one timer for whichever ends first. */
  const scheduleWake = () => {
    if (wakeTimer !== null) clearTimeout(wakeTimer);
    const until = Math.max(saved.snoozeUntil ?? 0, saved.hiddenUntil ?? 0) - Date.now();
    if (until <= 0) return;
    wakeTimer = setTimeout(() => {
      wakeTimer = null;
      apply();
    }, until + 50);
    wakeTimer.unref();
  };

  /** Her menu's places, also hers to be sent to; false when there is no such place now. */
  const goTo = (where: "window" | "taskbar" | "otherScreen"): boolean => {
    const all = edges();
    const here = edge?.display;
    const to =
      where === "window"
        ? all.find((e) => e.kind === "window")
        : where === "taskbar"
          ? landing(
              all.filter((e) => e.kind === "floor"),
              x,
              Infinity,
            )
          : all.find((e) => e.kind === "floor" && e.display !== here);
    if (to === undefined) return false;
    save({ placed: where !== "window" });
    standOn(to, where === "otherScreen" ? (to.x1 + to.x2) / 2 : x, 12);
    return true;
  };

  const menu = () => {
    const many = Electron.screen.getAllDisplays().length > 1;
    const chat = input.privateChat?.() ?? null;
    const items: Electron.MenuItemConstructorOptions[] = [
      ...(chat === null
        ? []
        : [{ label: "Private chat", click: chat }, { type: "separator" as const }]),
      snoozed()
        ? { label: "End the snooze", click: () => (save({ snoozeUntil: 0 }), apply()) }
        : {
            label: "Snooze for an hour",
            click: () => {
              save({ snoozeUntil: Date.now() + SNOOZE_MS });
              call(`window.mascot.play("yawn")`);
              scheduleWake();
              apply();
            },
          },
      {
        label: "Hide until tomorrow",
        click: () => {
          save({ hiddenUntil: nextMorning(Date.now()) });
          scheduleWake();
          apply();
        },
      },
      { type: "separator" },
      ...(edges().some((e) => e.kind === "window")
        ? [
            {
              label: "Sit on the window you're in",
              click: () => void goTo("window"),
            },
          ]
        : []),
      {
        label: "Sit on the taskbar",
        click: () => void goTo("taskbar"),
      },
      ...(many
        ? [
            {
              label: "Move to the other screen",
              click: () => void goTo("otherScreen"),
            },
          ]
        : []),
      { type: "separator" },
      { label: "Desktop companion settings…", click: () => input.openSettings() },
    ];
    Electron.Menu.buildFromTemplate(items).popup(win === null ? {} : { window: win });
  };

  /** The screen she was on when he picked her up, so a carry to another one is a moment. */
  let pickedFrom: number | undefined;
  let lastMoment = 0;
  let asking = false;
  /** His act on her goes to the spine; her answer, when it comes, plays over whatever she does then. */
  const moment = (event: MascotMoment) => {
    const now = Date.now();
    if (input.express === undefined || asking || now - lastMoment < MOMENT_GAP_MS) return;
    lastMoment = now;
    asking = true;
    void input
      .express(event)
      .then((answer) => {
        const said = sayOf(answer);
        if (said === null) return;
        call(`window.mascot.say(${JSON.stringify(said)})`);
        if (said.text !== "") input.speak?.(said.text);
      })
      .catch(() => undefined)
      .finally(() => {
        asking = false;
      });
  };

  /** Thrown or let go: she flies under the physics until she rests on an edge, then nothing runs. */
  const fling = (start: Flight, byHand = false) => {
    stopMoving();
    const thrown = Math.hypot(start.vx, start.vy) > THROWN_SPEED;
    const every = displays();
    const from = screenOf(every, start.x, start.y - size() / 4);
    const screens = options.screens === "one" && from !== undefined ? [from] : every;
    shrugOff();
    const all = [...edgesFor({ displays: screens, window: fg, size: size() }), ...heads()];
    const standing = others().flatMap((m) => {
      const body = m.standing();
      return body === null ? [] : [{ m, body }];
    });
    let flight = start;
    let owed = 0;
    let last = Date.now();
    moving = setInterval(() => {
      const target = win;
      if (target === null || target.isDestroyed()) return stopMoving();
      const now = Date.now();
      owed = Math.min(owed + (now - last) / 1000, 0.1);
      last = now;
      while (owed >= STEP_S && !resting(flight)) {
        owed -= STEP_S;
        const next = stepFlight({
          flight,
          edges: all,
          displays: screens,
          half: size() / 4,
          profile,
        });
        flight = next.flight;
        // every landing and wall is felt: a squash by its speed that springs back
        for (const event of next.events)
          if (event.speed > IMPACT_SPEED) react(event.kind, event.speed);
        const bump = bumpOf({
          flight,
          half: size() * BODY_HALF,
          tall: size() * BODY_TALL,
          bounce: profile.bounce,
          others: standing.map((s) => s.body),
        });
        if (bump !== null) {
          const [hit] = standing.splice(bump.index, 1);
          flight = bump.flight;
          if (Math.abs(bump.push) > IMPACT_SPEED) react("bump", Math.abs(bump.push));
          hit!.m.knock(bump.push);
        }
      }
      if (!resting(flight) || flight.on === null) {
        target.setBounds(box({ x: flight.x - size() / 2, y: flight.y - size() * FOOT_SHARE }));
        call(
          `window.mascot.motion(${Math.round(flight.vx)},${Math.round(flight.on === null ? flight.vy : 0)})`,
        );
        return;
      }
      stopMoving();
      call(`window.mascot.motion(0,0)`);
      edge = flight.on;
      x = flight.x;
      save({ x, placed: edge.kind === "floor" });
      target.setBounds(box(standAt(edge, x, size())));
      cue(momentOf(phase) ?? "rest");
      meet();
      if (byHand && pickedFrom !== undefined && edge.display !== pickedFrom)
        moment("moment.screen");
      else if (byHand && thrown) moment("moment.thrown");
    }, DRAG_MS);
  };

  const drop = () => {
    const target = win;
    if (dragging === null || target === null || target.isDestroyed()) return;
    clearInterval(dragging.timer);
    const { samples, pressedAt, squished } = dragging;
    dragging = null;
    if (squished) {
      // let go of a squish: she springs back up where she is
      call(`window.mascot.release()`);
      react("poke");
      if (edge !== null) target.setBounds(box(standAt(edge, x, size())));
      moment("moment.squished");
      return;
    }
    if (isPoke(samples, pressedAt, Date.now())) {
      // a poke: a little squash and a giggle where she stands
      call(`window.mascot.motion(0,0)`);
      react("poke");
      if (edge !== null) target.setBounds(box(standAt(edge, x, size())));
      moment("moment.poked");
      return;
    }
    if (options.motion !== "important" && !options.reduced) {
      const b = target.getBounds();
      return fling(
        {
          x: b.x + size() / 2,
          y: b.y + size() * FOOT_SHARE,
          ...throwVelocity(samples),
          on: null,
        },
        true,
      );
    }
    const drop = dropAt(edges(), target.getBounds(), size());
    edge = drop.edge;
    x = drop.x;
    save({ x: drop.x, placed: drop.edge.kind === "floor" });
    // Picked up she squished; landing, a little bounce.
    glide(drop.spot, 10, () => {
      call(`window.mascot.play("hop")`);
      cue(momentOf(phase) ?? "rest");
      if (pickedFrom !== undefined && drop.edge.display !== pickedFrom) moment("moment.screen");
    });
  };

  const mine = (event: Electron.IpcMainEvent) => win !== null && event.sender === win.webContents;
  const onPress = (event: Electron.IpcMainEvent) => {
    const target = win;
    if (!mine(event) || target === null || dragging !== null) return;
    stopMoving();
    shrugOff();
    pickedFrom = edge?.display;
    const cursor = Electron.screen.getCursorScreenPoint();
    const b = target.getBounds();
    // a brief reaction in her own way: her face, never her mood's colour
    react("pickup");
    const samples: Array<{ readonly x: number; readonly y: number; readonly t: number }> = [];
    const pressedAt = Date.now();
    const first = { x: cursor.x, y: cursor.y };
    const timer = setInterval(() => {
      if (target.isDestroyed()) return clearInterval(timer);
      const at = Electron.screen.getCursorScreenPoint();
      samples.push({ x: at.x, y: at.y, t: Date.now() });
      if (samples.length > 12) samples.shift();
      const held = dragging;
      if (held !== null) {
        const still = isStill([first, at]);
        if (!held.squished && still && Date.now() - pressedAt > SQUISH_MS) {
          held.squished = true;
          call(`window.mascot.press(-0.8)`);
        } else if (held.squished && !still) {
          held.squished = false;
          call(`window.mascot.release()`);
        }
        if (held.squished) return;
      }
      // carried, she stretches along his hand's speed
      const carried = throwVelocity(samples);
      call(`window.mascot.motion(${Math.round(carried.vx)},${Math.round(carried.vy)})`);
      target.setBounds(box({ x: at.x - (cursor.x - b.x), y: at.y - (cursor.y - b.y) }));
    }, DRAG_MS);
    dragging = { timer, samples, pressedAt, squished: false };
  };
  const onRelease = (event: Electron.IpcMainEvent) => {
    if (mine(event)) drop();
  };
  const onMenu = (event: Electron.IpcMainEvent) => {
    if (mine(event)) menu();
  };
  Electron.ipcMain.on("baton-mascot:press", onPress);
  Electron.ipcMain.on("baton-mascot:release", onRelease);
  Electron.ipcMain.on("baton-mascot:menu", onMenu);

  const onDisplays = () => {
    if (win !== null && !win.isDestroyed() && win.isVisible()) settle();
  };
  Electron.screen.on("display-added", onDisplays);
  Electron.screen.on("display-removed", onDisplays);
  Electron.screen.on("display-metrics-changed", onDisplays);

  /**
   * One of her own funny moments (bodies.js `funny`), or the one named. The rig acts; the window does what the act
   * needs of the world: a sneeze's hop, hanging off the end of his window, peeking in from the side of her screen.
   */
  const funny = (name?: string) => {
    const target = win;
    const on = edge;
    if (target === null || target.isDestroyed() || on === null) return;
    if (dragging !== null || moving !== null) return;
    const at = x;
    const can = { hang: on.kind === "window", peek: on.kind === "floor" };
    void ready.then(async () => {
      const r = (await target.webContents
        .executeJavaScript(
          `window.mascot.humour(${JSON.stringify(name ?? null)},${JSON.stringify(can)})`,
        )
        .catch(() => null)) as {
        readonly name?: string;
        readonly kick?: { readonly at: number; readonly vy: number };
        readonly hold?: number;
      } | null;
      if (r === null || target.isDestroyed()) return;
      const s = size();
      const later = (ms: number, f: () => void) =>
        setTimeout(() => {
          if (!target.isDestroyed() && dragging === null) f();
        }, ms).unref();
      const kick = r.kick;
      if (kick !== undefined)
        later(kick.at, () => {
          if (moving === null)
            fling({ x: at, y: on.y, vx: (Math.random() - 0.5) * 160, vy: kick.vy, on: null });
        });
      if (r.name === "hang" && can.hang) {
        const side = at > (on.x1 + on.x2) / 2 ? 1 : -1;
        const end = side > 0 ? on.x2 : on.x1;
        const feet = { x: end + side * s * BODY_HALF * 0.35, y: on.y + s * BODY_TALL };
        glide({ x: feet.x - s / 2, y: feet.y - s * FOOT_SHARE }, 6);
        later(r.hold ?? 2600, () => {
          if (Math.random() < 0.5) {
            call(`window.mascot.play("hop")`);
            standOn(on, end - side * s * BODY_HALF, 8);
          } else fling({ ...feet, vx: 0, vy: 0, on: null });
        });
      }
      if (r.name === "peek" && can.peek) {
        const w = screenOf(displays(), at, on.y - 1)?.workArea;
        if (w === undefined) return;
        const side = at > w.x + w.width / 2 ? 1 : -1;
        const rim = side > 0 ? w.x + w.width : w.x;
        glide(standAt({ ...on, x1: -1e6, x2: 1e6 }, rim + side * s * BODY_HALF * 0.45, s), 10);
        call(`window.mascot.look(${-side * 0.9},0)`);
        later(2400, () => {
          call(`window.mascot.look(null)`);
          call(`window.mascot.play("hop")`);
          standOn(on, rim - side * s * BODY_HALF * 1.2, 10);
        });
      }
    });
  };

  /**
   * Lively only: now and then a short walk, one of her funny moments or her character's own act, as her personality
   * leans (mascotPage idleChoice), while he is around and not typing this second.
   */
  /** Her bed plays to him, not an empty room: away this long (no keys or mouse), it fades out until he is back.
   * Her blinks and idle acts hold sooner (HOLD_AWAY_S). */
  const awayCheck = setInterval(() => {
    if (win === null || !win.isVisible()) return;
    const idle = Electron.powerMonitor.getSystemIdleTime();
    if (idle >= HOLD_AWAY_S !== held) {
      held = !held;
      call(`window.mascot.hold(${held})`);
    }
    if (options.bed === "off") return;
    const now = idle > BED_AWAY_S;
    if (now === away) return;
    away = now;
    audio();
  }, 15_000);
  awayCheck.unref();
  const wander = setInterval(() => {
    if (!wanders(options.motion) || win === null || !win.isVisible() || edge === null) return;
    if (dragging !== null || moving !== null || phase !== "idle" || sleeping || snoozed()) return;
    const idle = Electron.powerMonitor.getSystemIdleTime();
    if (idle < WANDER_IDLE_S[0] || idle > WANDER_IDLE_S[1] || Math.random() > WANDER_CHANCE) return;
    const target = win;
    void ready
      .then(() => target.webContents.executeJavaScript("window.mascot.idleChoice()"))
      .then((choice: unknown) => {
        if (choice === "funny") funny();
        else if (choice === "signature") call(`window.mascot.signature()`);
        else walk();
        if (Math.random() < REMARK_CHANCE) moment("moment.idle");
      })
      .catch(() => undefined);
  }, WANDER_CHECK_MS);
  wander.unref();
  /** A short walk along her edge in her own gait. */
  const walk = () => {
    if (edge === null || moving !== null || dragging !== null) return;
    const to = wanderTo(edge, x, Math.random());
    if (to === null) return;
    // a walk in her own gait (hops, a waddle, a glide) for the length of the glide
    call(`window.mascot.walk(1600,${to > x ? 1 : -1})`);
    x = to;
    save({ x: to });
    glide(standAt(edge, to, size()), 48);
  };

  scheduleWake();

  /** Her window's middle, where her feet are. */
  const middle = () => {
    const b = win?.getBounds();
    return b === undefined ? x : b.x + size() / 2;
  };
  const still = () =>
    edge !== null &&
    moving === null &&
    dragging === null &&
    !leaving &&
    win !== null &&
    win.isVisible();
  const self: CrowdMember = {
    id: input.key ?? "first",
    head: () => {
      if (!still() || edge === null) return null;
      const s = size();
      const cx = middle();
      return {
        kind: "window",
        x1: cx - s * BODY_HALF,
        x2: cx + s * BODY_HALF,
        y: edge.y - s * BODY_TALL,
        display: edge.display,
      };
    },
    feet: () =>
      still() && edge !== null ? { x: middle(), y: edge.y, display: edge.display } : null,
    fall: () => {
      const target = win;
      if (dragging !== null || target === null || target.isDestroyed()) return;
      const b = target.getBounds();
      fling({ x: b.x + size() / 2, y: b.y + size() * FOOT_SHARE, vx: 0, vy: 0, on: null });
    },
    standing: () =>
      still() && edge !== null
        ? { x: middle(), y: edge.y, half: size() * BODY_HALF, tall: size() * BODY_TALL }
        : null,
    knock: (vx) => {
      const target = win;
      if (dragging !== null || target === null || target.isDestroyed()) return;
      call(`window.mascot.look(${vx > 0 ? -0.9 : 0.9},0)`);
      if (Math.abs(vx) > IMPACT_SPEED) react("bump", Math.abs(vx));
      const b = target.getBounds();
      fling({
        x: b.x + size() / 2,
        y: b.y + size() * FOOT_SHARE,
        vx,
        vy: -Math.abs(vx) / 4,
        on: null,
      });
      if (Math.abs(vx) > IMPACT_SPEED) moment("moment.bumped");
    },
    greet: (side, under) => {
      call(`window.mascot.look(${side * 0.9},0)`);
      call(`window.mascot.react(${JSON.stringify(under ? "under" : "hello")},${under ? 700 : 0})`);
    },
    gesture: (act, side) => {
      call(`window.mascot.look(${side * 0.9},0)`);
      const clip = ACT_CLIPS[act];
      if (clip !== undefined) call(`window.mascot.play(${JSON.stringify(clip)})`);
    },
  };
  input.crowd?.add(self);

  return {
    setOptions: (next) => {
      const rebuild = next.size !== options.size || next.motion !== options.motion;
      // Turning her on in Settings is his way back from "Hide until tomorrow" and a snooze.
      if (next.on && !options.on && (hidden() || snoozed()))
        save({ hiddenUntil: 0, snoozeUntil: 0 });
      options = next;
      if (rebuild && win !== null && !win.isDestroyed()) win.destroy();
      apply();
    },
    turn: (next) => {
      const was = phase;
      phase = next;
      if (win === null || !win.isVisible()) return;
      if (
        (next === "listening" || next === "dictating") !==
        (was === "listening" || was === "dictating")
      )
        audio();
      if (next === "speaking" && was !== "speaking") call("window.mascot.speak(true)");
      if (next !== "speaking" && was === "speaking") call("window.mascot.speak(false)");
      const moment = momentOf(next);
      if (moment !== null && moment !== momentOf(was)) cue(moment);
    },
    level: (value, shape) => {
      if (phase === "speaking" && win !== null && !win.isDestroyed() && win.isVisible())
        win.webContents.send("baton-mascot:level", value, shape);
    },
    line: (text, bubble) => {
      if (win === null || !win.isVisible()) return;
      call(`window.mascot.line(${JSON.stringify(text)})`);
      if (bubble === true)
        call(`window.mascot.say(${JSON.stringify({ text: text.slice(0, 120) })})`);
    },
    bounds: () => (win !== null && !win.isDestroyed() && win.isVisible() ? win.getBounds() : null),
    mood: (label, intensity) => {
      const next = restFaceOf(label, intensity);
      if (JSON.stringify(next) === JSON.stringify(restMood)) return;
      restMood = next;
      if (
        win !== null &&
        win.isVisible() &&
        phase === "idle" &&
        moving === null &&
        dragging === null
      )
        cue("rest");
    },
    expression: (face) => {
      if (win === null || !win.isVisible()) return false;
      call(`window.mascot.say(${JSON.stringify({ mood: face })})`);
      return true;
    },
    react: (moment) => {
      if (win !== null && win.isVisible()) cue(moment);
    },
    foreground: (window, full) => {
      const wasFull = fullscreen;
      fullscreen = full;
      const moved = JSON.stringify(window) !== JSON.stringify(fg);
      fg = window;
      if (wasFull !== full) return apply();
      if (!moved || edge === null || dragging !== null || moving !== null) return;
      if (win === null || !win.isVisible()) return;
      if (snoozed()) return;
      const next = followFocus({
        current: edge,
        x,
        edges: edges(),
        placed: saved.placed === true,
        still: options.motion === "important",
      });
      if (next.how === "stay") return;
      if (next.how === "hop") call(`window.mascot.play("hop")`);
      standOn(next.edge, next.x, next.how === "ride" ? 8 : 14);
    },
    act: (what) => {
      if (win === null || !win.isVisible() || dragging !== null) return false;
      if (what === "window" || what === "taskbar" || what === "otherScreen") return goTo(what);
      const clip = ACT_CLIPS[what];
      if (clip !== undefined) call(`window.mascot.play(${JSON.stringify(clip)})`);
      else if (what === "signature") call(`window.mascot.signature()`);
      else funny(what === "funny" ? undefined : what);
      return true;
    },
    layerBody: (page) => {
      if (page === null) return dropVeil();
      if (veil !== null && !veil.isDestroyed()) return;
      const shown = new Electron.BrowserWindow({
        ...(win !== null && !win.isDestroyed()
          ? win.getBounds()
          : { width: size(), height: size() }),
        frame: false,
        transparent: true,
        resizable: false,
        focusable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        hasShadow: false,
        show: false,
        webPreferences: { session: page.session, contextIsolation: true, sandbox: true },
      });
      // Always out of capture, whatever the capture setting says for her public self.
      shown.setContentProtection(true);
      shown.setAlwaysOnTop(true, "floating");
      markCompanionWindow(shown);
      shown.on("closed", () => {
        if (veil === shown) dropVeil();
      });
      veil = shown;
      void shown
        .loadURL(page.url)
        .then(() => {
          if (veil !== shown) return;
          placeVeil();
          shown.showInactive();
          call(`document.body.style.opacity = "0"`);
        })
        .catch(() => dropVeil());
    },
    layerCue: (c) => {
      const target = veil;
      if (target === null || target.isDestroyed()) return;
      void target.webContents
        .executeJavaScript(`window.tessayaBodyCue?.(${JSON.stringify(c)})`)
        .catch(() => undefined);
    },
    asleep: (on) => {
      if (on === sleeping) return;
      sleeping = on;
      cue(on ? "asleep" : "rest");
    },
    dispose: () => {
      input.crowd?.delete(self);
      clearInterval(wander);
      clearInterval(awayCheck);
      if (wakeTimer !== null) clearTimeout(wakeTimer);
      Electron.ipcMain.removeListener("baton-mascot:press", onPress);
      Electron.ipcMain.removeListener("baton-mascot:release", onRelease);
      Electron.ipcMain.removeListener("baton-mascot:menu", onMenu);
      Electron.screen.removeListener("display-added", onDisplays);
      Electron.screen.removeListener("display-removed", onDisplays);
      Electron.screen.removeListener("display-metrics-changed", onDisplays);
      dropVeil();
      if (win !== null && !win.isDestroyed()) win.destroy();
    },
  };
};
