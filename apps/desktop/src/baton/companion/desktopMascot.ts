// @effect-diagnostics globalTimers:off globalDate:off globalRandom:off nodeBuiltinImport:off
/**
 * The desktop mascot: one character in a see-through window her own size, on top of everything. She stands on the top
 * edge of the window he is in or on a screen's floor above the taskbar (mascotDock.ts), takes the mouse only over her
 * body, and reacts to Tessaya's turn and jobs with one cue per change (baton-shared/companion). At rest nothing draws.
 */
import * as Electron from "electron";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import {
  cueFor,
  momentOf,
  wanders,
  type CompanionMoment,
  type CompanionMotion,
} from "@t3tools/baton-shared/companion";
import type { TurnPhase } from "@t3tools/baton-shared/voiceTurn";

import { protectFromCapture } from "../captureProtection.ts";
import { markCompanionWindow } from "../lastAppWindow.ts";
import {
  FOOT_SHARE,
  bodyRect,
  edgesFor,
  followWindow,
  landing,
  pathBetween,
  standAt,
  wanderTo,
  type DisplayArea,
  type Edge,
  type Rect,
} from "./mascotDock.ts";
import { MASCOT_SCRIPT } from "./mascotPage.ts";

export type MascotSize = "small" | "medium" | "large";
export const MASCOT_SIZES: Readonly<Record<MascotSize, number>> = {
  small: 120,
  medium: 150,
  large: 190,
};
export const parseMascotSize = (value: unknown): MascotSize =>
  value === "small" || value === "large" ? value : "medium";

/** The studio's personas (bodies.js TCS.PERSONAS); each wears its own character. */
export const MASCOT_PERSONAS = ["tessaya", "freya", "alfred", "sebastian"] as const;
export type MascotPersona = (typeof MASCOT_PERSONAS)[number];
export const MASCOT_PERSONA_LABEL: Readonly<Record<MascotPersona, string>> = {
  tessaya: "Tessaya",
  freya: "Freya",
  alfred: "Alfred",
  sebastian: "Sebastian",
};
export const parseMascotPersona = (value: unknown): MascotPersona =>
  MASCOT_PERSONAS.includes(value as MascotPersona) ? (value as MascotPersona) : "tessaya";

export interface MascotOptions {
  readonly on: boolean;
  readonly motion: CompanionMotion;
  readonly persona: MascotPersona;
  readonly size: MascotSize;
  readonly reduced: boolean;
}

export interface DesktopMascot {
  readonly setOptions: (options: MascotOptions) => void;
  /** The pill's phase: her moment follows it, except dictation. */
  readonly turn: (phase: TurnPhase) => void;
  /** Her own voice's level while she speaks, for the mouth. */
  readonly level: (value: number) => void;
  /** A job finished, failed or started waiting for him. */
  readonly react: (moment: CompanionMoment) => void;
  /** The window he is in (DIP, null when unknown) and whether it fills its screen. */
  readonly foreground: (window: Rect | null, fullscreen: boolean) => void;
  /** Quiet hours, Do not disturb or a snooze of all of Tessaya: asleep, and still. */
  readonly asleep: (on: boolean) => void;
  readonly dispose: () => void;
}

interface Saved {
  readonly x?: number;
  readonly snoozeUntil?: number;
  readonly hiddenUntil?: number;
}

const HIT_NEAR_MS = 80;
const HIT_FAR_MS = 400;
const NEAR_PX = 60;
const FRAME_MS = 33;
const DRAG_MS = 16;
const SNOOZE_MS = 60 * 60_000;
/** A wander is considered once a minute, and taken about one time in six: every few minutes, never on a beat. */
const WANDER_CHECK_MS = 60_000;
const WANDER_CHANCE = 1 / 6;
/** He is at the computer, but not typing this second. */
const WANDER_IDLE_S: readonly [number, number] = [3, 120];

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
    };
  } catch {
    return {};
  }
};

const displays = (): ReadonlyArray<DisplayArea> =>
  Electron.screen
    .getAllDisplays()
    .map((d) => ({ id: d.id, bounds: d.bounds, workArea: d.workArea }));

export const createDesktopMascot = (input: {
  /** Her characters' folder (COMPANION_DIR): the stage page and the studio's scripts. */
  readonly companionDir: string;
  readonly stateDir: string;
  readonly openSettings: () => void;
  readonly onNote?: (kind: string, detail: Record<string, unknown>) => void;
}): DesktopMascot => {
  const file = NodePath.join(input.stateDir, "baton-mascot.json");
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
    persona: "tessaya",
    size: "medium",
    reduced: false,
  };
  let win: Electron.BrowserWindow | null = null;
  let ready: Promise<void> = Promise.resolve();
  let fg: Rect | null = null;
  let fullscreen = false;
  let sleeping = false;
  let phase: TurnPhase = "idle";
  let edge: Edge | null = null;
  let x = saved.x ?? -1;
  let dragging: { readonly timer: ReturnType<typeof setInterval> } | null = null;
  let moving: ReturnType<typeof setInterval> | null = null;
  let hitTimer: ReturnType<typeof setTimeout> | null = null;
  let takingMouse = false;
  let wakeTimer: ReturnType<typeof setTimeout> | null = null;

  const size = () => MASCOT_SIZES[options.size];
  const snoozed = () => (saved.snoozeUntil ?? 0) > Date.now();
  const hidden = () => (saved.hiddenUntil ?? 0) > Date.now();
  const wanted = () => options.on && !hidden() && !fullscreen;
  const edges = () => edgesFor({ displays: displays(), window: fg, size: size() });

  const call = (code: string) => {
    const target = win;
    void ready.then(() => {
      if (target !== null && !target.isDestroyed())
        void target.webContents.executeJavaScript(code).catch(() => undefined);
    });
  };
  const cue = (moment: CompanionMoment) => {
    const next = cueFor(
      sleeping ? "asleep" : snoozed() && moment === "rest" ? "asleep" : moment,
      options.motion,
    );
    if (next !== null) call(`window.mascot.cue(${JSON.stringify(next)})`);
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
    const steps = pathBetween(target.getBounds(), to, Math.max(1, frames));
    let i = 0;
    moving = setInterval(() => {
      const step = steps[i++];
      if (step === undefined || target.isDestroyed()) {
        stopMoving();
        done?.();
        return;
      }
      target.setPosition(step.x, step.y);
    }, FRAME_MS);
  };
  const standOn = (next: Edge, at: number, frames = 0) => {
    edge = next;
    x = at;
    const spot = standAt(next, at, size(), snoozed() && next.kind === "floor");
    save({ x: at });
    if (frames === 0) win?.setBounds({ ...spot, width: size(), height: size() });
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
    const at = x >= home.x1 && x <= home.x2 ? x : home.x2 - size();
    standOn(home, at);
  };

  const stopHitTest = () => {
    if (hitTimer !== null) clearTimeout(hitTimer);
    hitTimer = null;
  };
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
    win = created;
    const stage = NodeURL.pathToFileURL(NodePath.join(input.companionDir, "stage.html")).href;
    ready = created
      .loadURL(stage)
      .then(() => created.webContents.executeJavaScript(MASCOT_SCRIPT))
      .then(() => undefined)
      .catch((cause: unknown) => input.onNote?.("mascot_load_failed", { cause: String(cause) }));
    return created;
  };

  const init = () =>
    call(
      `window.mascot.init(${JSON.stringify({ persona: options.persona, quiet: options.motion !== "lively", reduced: options.reduced })})`,
    );

  /** Shows, hides or builds her window to match his settings, a snooze or hide, and a full-screen app. */
  const apply = () => {
    if (!wanted()) {
      if (win !== null && !win.isDestroyed()) {
        if (options.on) win.hide();
        else win.destroy();
      }
      stopHitTest();
      return;
    }
    const target = build();
    init();
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

  const menu = () => {
    const many = Electron.screen.getAllDisplays().length > 1;
    const here = edge === null ? undefined : edge.display;
    const items: Electron.MenuItemConstructorOptions[] = [
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
        ? [{ label: "Sit on the window you're in", click: () => standOn(edges()[0]!, x, 12) }]
        : []),
      {
        label: "Sit on the taskbar",
        click: () => {
          const floor = landing(
            edges().filter((e) => e.kind === "floor"),
            x,
            Infinity,
          );
          standOn(floor, x, 12);
        },
      },
      ...(many
        ? [
            {
              label: "Move to the other screen",
              click: () => {
                const other = edges().find((e) => e.kind === "floor" && e.display !== here);
                if (other !== undefined) standOn(other, (other.x1 + other.x2) / 2, 12);
              },
            },
          ]
        : []),
      { type: "separator" },
      { label: "Desktop companion settings…", click: () => input.openSettings() },
    ];
    Electron.Menu.buildFromTemplate(items).popup(win === null ? {} : { window: win });
  };

  const drop = () => {
    const target = win;
    if (dragging === null || target === null || target.isDestroyed()) return;
    clearInterval(dragging.timer);
    dragging = null;
    const b = target.getBounds();
    const cx = b.x + b.width / 2;
    const next = landing(edges(), cx, b.y + b.height * FOOT_SHARE);
    edge = next;
    x = cx;
    save({ x: cx });
    glide(standAt(next, cx, size()), 10, () => {
      call(`window.mascot.play("squish")`);
      cue(momentOf(phase) ?? "rest");
    });
  };

  const mine = (event: Electron.IpcMainEvent) => win !== null && event.sender === win.webContents;
  const onPress = (event: Electron.IpcMainEvent) => {
    const target = win;
    if (!mine(event) || target === null || dragging !== null) return;
    stopMoving();
    const cursor = Electron.screen.getCursorScreenPoint();
    const b = target.getBounds();
    call(`window.mascot.cue({expression:"surprised"})`);
    const timer = setInterval(() => {
      if (target.isDestroyed()) return clearInterval(timer);
      const at = Electron.screen.getCursorScreenPoint();
      target.setPosition(at.x - (cursor.x - b.x), at.y - (cursor.y - b.y));
    }, DRAG_MS);
    dragging = { timer };
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

  /** Lively only: now and then a short walk along her edge, while he is around and not typing this second. */
  const wander = setInterval(() => {
    if (!wanders(options.motion) || win === null || !win.isVisible() || edge === null) return;
    if (dragging !== null || moving !== null || phase !== "idle" || sleeping || snoozed()) return;
    const idle = Electron.powerMonitor.getSystemIdleTime();
    if (idle < WANDER_IDLE_S[0] || idle > WANDER_IDLE_S[1] || Math.random() > WANDER_CHANCE) return;
    const to = wanderTo(edge, x, Math.random());
    if (to === null) return;
    call(`window.mascot.play("hop")`);
    x = to;
    save({ x: to });
    glide(standAt(edge, to, size()), 48, () => call(`window.mascot.play("squish")`));
  }, WANDER_CHECK_MS);
  wander.unref();

  scheduleWake();

  return {
    setOptions: (next) => {
      const rebuild = next.size !== options.size || next.motion !== options.motion;
      options = next;
      if (rebuild && win !== null && !win.isDestroyed()) win.destroy();
      apply();
    },
    turn: (next) => {
      const was = phase;
      phase = next;
      if (win === null || !win.isVisible()) return;
      if (next === "speaking" && was !== "speaking") call("window.mascot.speak(true)");
      if (next !== "speaking" && was === "speaking") call("window.mascot.speak(false)");
      const moment = momentOf(next);
      if (moment !== null && moment !== momentOf(was)) cue(moment);
    },
    level: (value) => {
      if (phase === "speaking" && win !== null && !win.isDestroyed() && win.isVisible())
        win.webContents.send("baton-mascot:level", value);
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
      if (!moved || edge === null || dragging !== null || win === null || !win.isVisible()) return;
      const follow = followWindow(edge, x, edges());
      if (follow !== null) {
        if (follow.edge !== edge) standOn(follow.edge, follow.x, 8);
        return;
      }
      // Her window closed or another took its place: she drops to the edge below.
      const b = win.getBounds();
      standOn(landing(edges(), x, b.y + b.height * FOOT_SHARE + 1), x, 12);
    },
    asleep: (on) => {
      if (on === sleeping) return;
      sleeping = on;
      cue(on ? "asleep" : "rest");
    },
    dispose: () => {
      clearInterval(wander);
      if (wakeTimer !== null) clearTimeout(wakeTimer);
      Electron.ipcMain.removeListener("baton-mascot:press", onPress);
      Electron.ipcMain.removeListener("baton-mascot:release", onRelease);
      Electron.ipcMain.removeListener("baton-mascot:menu", onMenu);
      Electron.screen.removeListener("display-added", onDisplays);
      Electron.screen.removeListener("display-removed", onDisplays);
      Electron.screen.removeListener("display-metrics-changed", onDisplays);
      if (win !== null && !win.isDestroyed()) win.destroy();
    },
  };
};
