/**
 * The look the pill, its cards and prompts wear now (pillLook.ts), and who to tell when it changes. The app's theme
 * is read from an open T3 window's resolved colours, so built-in, Tessaya and custom themes all count; with none
 * open, the last one read for that half stands, else Tessaya's palette. Read when the pill or a card comes up, when
 * a T3 window loses the focus (he may have changed its theme), and when Windows or Settings flip light and dark.
 */
import * as Electron from "electron";

import type { Palette } from "../home/palette.ts";
import { isCompanionWindow } from "../lastAppWindow.ts";
import {
  PILL_ROLES,
  colorsFrom,
  resolveLook,
  t3Variable,
  PALETTE_COLORS,
  type PillColors,
  type PillDesign,
  type PillLook,
  type PillWave,
  type T3Theme,
} from "./pillLook.ts";

let settings: { design: PillDesign; wave: PillWave; palette: Palette } = {
  design: "tessaya",
  wave: "match",
  palette: "woad",
};
let t3: T3Theme | null = null;
const halves: { dark?: PillColors; light?: PillColors } = {};
const listeners = new Set<(look: PillLook) => void>();
let watching = false;

const compute = (): PillLook =>
  resolveLook({
    ...settings,
    systemDark: Electron.nativeTheme.shouldUseDarkColors,
    t3,
    t3Halves: halves,
  });
let current: PillLook | null = null;

export const pillLook = (): PillLook => (current ??= compute());

const emit = () => {
  const next = compute();
  if (JSON.stringify(next) === JSON.stringify(pillLook())) return;
  current = next;
  for (const listener of listeners) listener(next);
};

/** Tells `listener` of every change of look; returns the way to stop. */
export const onPillLook = (listener: (look: PillLook) => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const READ = `(()=>{const s=getComputedStyle(document.documentElement);return {dark:document.documentElement.classList.contains('dark'),colors:Object.fromEntries(${JSON.stringify(
  PILL_ROLES.map((role) => [role, t3Variable(role)]),
)}.map(([r,v])=>[r,s.getPropertyValue(v).trim()]))};})()`;

/** Reads the open T3 window's theme; with none open, the pill keeps what it last read. */
export const refreshPillTheme = async (): Promise<void> => {
  const window = Electron.BrowserWindow.getAllWindows().find(
    (w) => !w.isDestroyed() && !isCompanionWindow(w) && !w.webContents.getURL().startsWith("data:"),
  );
  if (window === undefined) {
    t3 = null;
    return emit();
  }
  try {
    const read = (await window.webContents.executeJavaScript(READ)) as {
      dark: unknown;
      colors: Record<string, unknown>;
    };
    const dark = read.dark === true;
    const colors = colorsFrom(
      read.colors,
      PALETTE_COLORS[settings.palette][dark ? "dark" : "light"],
    );
    t3 = { dark, colors };
    halves[dark ? "dark" : "light"] = colors;
  } catch {
    // A T3 window still loading keeps the last theme read.
  }
  emit();
};

/** The pill settings and Tessaya's palette, from Settings; starts watching the theme the first time. */
export const setPillSettings = (next: {
  readonly design: PillDesign;
  readonly wave: PillWave;
  readonly palette: Palette;
}): void => {
  settings = { design: next.design, wave: next.wave, palette: next.palette };
  emit();
  if (watching) return;
  watching = true;
  Electron.nativeTheme.on("updated", () => void refreshPillTheme());
  Electron.app.on("browser-window-blur", (_event, window) => {
    if (!isCompanionWindow(window)) void refreshPillTheme();
  });
  void refreshPillTheme();
};
