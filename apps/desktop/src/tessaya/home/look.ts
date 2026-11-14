/**
 * Motion and glass: two settings (Settings, General) that become classes on the page's root so the styles
 * can read them. Auto-reduced when the system asks for less. Pure; the window applies the results.
 */
import type { Palette } from "./palette.ts";

export type Motion = "full" | "reduced" | "off";
export type Glass = "on" | "reduced" | "off";

export const parseMotion = (v: unknown): Motion => (v === "reduced" || v === "off" ? v : "full");
export const parseGlass = (v: unknown): Glass => (v === "reduced" || v === "off" ? v : "on");

export interface SystemAsks {
  readonly reducedMotion: boolean;
  readonly reducedTransparency: boolean;
}

/** A choice of Full follows the system when it asks for less; Reduced and Off are always taken as chosen. */
export const effectiveMotion = (set: Motion, os: SystemAsks): Motion =>
  set === "full" && os.reducedMotion ? "reduced" : set;

export const effectiveGlass = (set: Glass, os: SystemAsks): Glass =>
  set === "on" && os.reducedTransparency ? "reduced" : set;

/** Class names on the root element: html.motion-reduced, html.motion-off, html.glass-reduced, html.glass-off. */
export const lookClasses = (
  motion: Motion,
  glass: Glass,
  palette: Palette = "woad",
): ReadonlyArray<string> => [
  ...(motion === "full" ? [] : [`motion-${motion}`]),
  ...(glass === "on" ? [] : [`glass-${glass}`]),
  ...(palette === "woad" ? [] : [`palette-${palette}`]),
];

export const ALL_LOOK_CLASSES: ReadonlyArray<string> = [
  "motion-reduced",
  "motion-off",
  "glass-reduced",
  "glass-off",
  "palette-damson",
  "palette-madder",
];

/** The script that sets those classes on the page. Fixed words only: nothing from outside goes into it. */
export const applyLookScript = (classes: ReadonlyArray<string>): string =>
  `(()=>{const c=document.documentElement.classList;${JSON.stringify(ALL_LOOK_CLASSES)}.forEach(x=>c.remove(x));${JSON.stringify(classes.filter((x) => ALL_LOOK_CLASSES.includes(x)))}.forEach(x=>c.add(x));})()`;

/** Windows 11 reports 10.0.22000 or higher; the background material needs 22621 (22H2). */
export const windowsBuild = (release: string): number => {
  const m = /^10\.0\.(\d+)/.exec(release);
  return m === null ? 0 : Number(m[1]);
};

export interface MaterialOptions {
  readonly backgroundMaterial?: "acrylic" | "none";
  readonly vibrancy?: "under-window";
  readonly visualEffectState?: "followWindow";
}

/**
 * The window's material: Acrylic on Windows 11 (22H2 and later), a blur of what is behind the window, so the page's
 * glass is see-through like the system's own; vibrancy on macOS; nothing elsewhere (and nothing when glass is reduced
 * or off). Windows 10 and Linux keep the page's own field, which looks the same without the see-through.
 */
export const materialFor = (platform: string, release: string, glass: Glass): MaterialOptions => {
  if (glass !== "on")
    return platform === "win32" && windowsBuild(release) >= 22621
      ? { backgroundMaterial: "none" }
      : {};
  if (platform === "win32")
    return windowsBuild(release) >= 22621 ? { backgroundMaterial: "acrylic" } : {};
  if (platform === "darwin") return { vibrancy: "under-window", visualEffectState: "followWindow" };
  return {};
};

/** The window itself is clear, so the system material shows through the page's thinned ground. */
export const seeThrough = (m: MaterialOptions): boolean => m.backgroundMaterial === "acrylic";
