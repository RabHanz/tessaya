// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeEvents from "node:events";

import { describe, expect, it, vi } from "vite-plus/test";

const fake = vi.hoisted(() => ({ cursor: { x: 0, y: 0 }, windows: [] as Array<unknown> }));

vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  const area = { x: 0, y: 0, width: 1920, height: 1040 };
  const display = { id: 1, workArea: area, bounds: area };
  class BrowserWindow extends EventEmitter {
    static getAllWindows = () => fake.windows;
    bounds = { x: 0, y: 0, width: 0, height: 0 };
    focusable = false;
    focused = false;
    skipTaskbar = false;
    shown = false;
    calls: string[] = [];
    webContents = {
      executeJavaScript: (code: string) => {
        this.calls.push(code);
        return Promise.resolve(undefined);
      },
    };
    constructor(options: { width?: number; height?: number }) {
      super();
      this.bounds = { ...this.bounds, width: options.width ?? 0, height: options.height ?? 0 };
      fake.windows.push(this);
    }
    getBounds = () => this.bounds;
    setBounds = (b: typeof this.bounds) => void (this.bounds = { ...this.bounds, ...b });
    isDestroyed = () => false;
    isVisible = () => this.shown;
    isFocusable = () => this.focusable;
    setFocusable = (on: boolean) => void (this.focusable = on);
    isFocused = () => this.focused;
    focus = () => void (this.focused = this.focusable);
    blur = () => {
      if (!this.focused) return;
      this.focused = false;
      this.emit("blur");
    };
    setSkipTaskbar = (on: boolean) => void (this.skipTaskbar = on);
    showInactive = () => void (this.shown = true);
    hide = () => void (this.shown = false);
    destroy = () => undefined;
    setIgnoreMouseEvents = () => undefined;
    setAlwaysOnTop = () => undefined;
    setVisibleOnAllWorkspaces = () => undefined;
  }
  return {
    BrowserWindow,
    ipcMain: new EventEmitter(),
    app: new EventEmitter(),
    Menu: { buildFromTemplate: () => ({ popup: () => undefined }) },
    screen: {
      getCursorScreenPoint: () => fake.cursor,
      getDisplayNearestPoint: () => display,
      getDisplayMatching: () => display,
    },
  };
});
vi.mock("./loadDocument.ts", () => ({ loadDocument: () => Promise.resolve(true) }));
vi.mock("../captureProtection.ts", () => ({ protectFromCapture: () => undefined }));
vi.mock("../lastAppWindow.ts", () => ({ markCompanionWindow: () => undefined }));
vi.mock("./voicePlayer.ts", () => ({ onAudioServiceGone: () => undefined }));

import * as Electron from "electron";
import { createVoicePill } from "./voicePill.ts";

/** Fake timers, a fresh state folder and the IPC listeners; all undone when the test ends, pass or fail. */
const setup = () => {
  vi.useFakeTimers();
  fake.windows.length = 0;
  fake.cursor = { x: 0, y: 0 };
  (Electron.ipcMain as unknown as NodeEvents.EventEmitter).removeAllListeners();
  const stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pill-"));
  const escapes: Array<() => void> = [];
  const dismissed = vi.fn();
  const moves: boolean[] = [];
  const focusedBack: number[] = [];
  const make = () =>
    createVoicePill({
      cueGain: () => 0,
      rest: () => false,
      edge: () => "bottom",
      stateDir,
      holdEscape: (press) => {
        escapes.push(press);
        return () => void escapes.splice(escapes.indexOf(press), 1);
      },
      onDismiss: dismissed,
      onMoving: (on) => moves.push(on),
      foreground: async () => 42,
      focusWindow: (window) => void focusedBack.push(window),
    });
  return {
    stateDir,
    escapes,
    dismissed,
    moves,
    focusedBack,
    make,
    [Symbol.dispose]: () => {
      vi.useRealTimers();
      NodeFS.rmSync(stateDir, { recursive: true, force: true });
    },
  };
};

// The pill is the first window; a drag adds the snap markers after it.
const page = () => fake.windows[0] as Electron.BrowserWindow;
const send = (channel: string, ...args: unknown[]) =>
  (Electron.ipcMain as unknown as NodeEvents.EventEmitter).emit(
    channel,
    { sender: page().webContents },
    ...args,
  );

describe("the pill is locked until Move pill is on", () => {
  it("takes a click as a click and never starts a drag while locked", async () => {
    using t = setup();
    const { dismissed, make } = t;
    const pill = make();
    pill.warm();
    await vi.advanceTimersByTimeAsync(0);
    const before = page().getBounds();
    send("baton-pill:drag", true);
    fake.cursor = { x: 300, y: 200 };
    send("baton-pill:drag", false, "up");
    expect(page().getBounds()).toEqual(before);
    send("baton-pill:click", 0, 0, 50);
    expect(dismissed).toHaveBeenCalledTimes(1);
    pill.dispose();
  });

  it("moves the whole pill while on, ignores clicks, and leaves by Esc or the check mark", async () => {
    using t = setup();
    const { escapes, dismissed, moves, focusedBack, make } = t;
    const pill = make();
    pill.setMoving(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(pill.moving()).toBe(true);
    expect(page().isFocused()).toBe(true);
    expect((page() as unknown as { skipTaskbar: boolean }).skipTaskbar).toBe(true);
    send("baton-pill:click", 0, 0, 50);
    expect(dismissed).not.toHaveBeenCalled();
    // A new place in Settings while moving: it goes there and stays movable.
    pill.setEdge("top");
    expect(pill.moving()).toBe(true);
    expect(page().isVisible()).toBe(true);
    escapes.at(-1)!();
    await vi.advanceTimersByTimeAsync(0);
    expect(pill.moving()).toBe(false);
    expect(page().isFocusable()).toBe(false);
    expect(focusedBack).toEqual([42]);
    pill.setMoving(true);
    await vi.advanceTimersByTimeAsync(0);
    send("baton-pill:moving", false);
    await vi.advanceTimersByTimeAsync(0);
    expect(pill.moving()).toBe(false);
    expect(focusedBack).toEqual([42, 42]);
    expect(escapes).toHaveLength(0);
    expect(moves).toEqual([true, false, true, false]);
    pill.dispose();
  });

  it("locks when he clicks into another app, and leaves the focus where he put it", async () => {
    using t = setup();
    const { escapes, focusedBack, make } = t;
    const pill = make();
    pill.setMoving(true);
    await vi.advanceTimersByTimeAsync(0);
    page().blur();
    await vi.advanceTimersByTimeAsync(0);
    expect(pill.moving()).toBe(false);
    expect(escapes).toHaveLength(0);
    expect(focusedBack).toEqual([]);
    pill.dispose();
  });

  it("keeps where it was dragged, across a restart", async () => {
    using t = setup();
    const { stateDir, make } = t;
    const pill = make();
    pill.setMoving(true);
    await vi.advanceTimersByTimeAsync(0);
    const from = page().getBounds();
    send("baton-pill:drag", true);
    fake.cursor = { x: -700, y: -400 };
    send("baton-pill:beat");
    await vi.advanceTimersByTimeAsync(40);
    send("baton-pill:drag", false, "up");
    const moved = page().getBounds();
    expect(moved).not.toEqual(from);
    pill.setMoving(false);
    pill.dispose();
    expect(
      JSON.parse(NodeFS.readFileSync(NodePath.join(stateDir, "baton-pill.json"), "utf8")),
    ).toHaveProperty("1");
    const again = make();
    expect(again.placed()).toBe(true);
    expect(again.anchor()).toMatchObject({ x: moved.x, y: moved.y });
    again.dispose();
  });
});
