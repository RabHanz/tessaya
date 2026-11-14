// @effect-diagnostics nodeBuiltinImport:off
/**
 * The window's motion and the taskbar icons are files in the app (apps/desktop/resources/tessaya), one per palette
 * and theme, made by scripts/tessaya/pack-window-motion.py and pack-taskbar-icons.py. Only the one in use is read,
 * when it is needed, so none of them weighs on the page.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { Palette } from "./palette.ts";
import type { Theme } from "./theme.ts";

export const stingFile = (palette: Palette, theme: Theme): string =>
  `sting-${palette}-${theme}.webp`;
export const taskbarIconFile = (palette: Palette, theme: Theme): string =>
  `taskbar-${palette}-${theme}.ico`;

/**
 * In the packaged app the build puts them in its resources folder (`DESKTOP_EXTRA_RESOURCES`); run from the source tree
 * they are beside the built main script (dist-electron/..).
 */
export const artDir = (dirname: string, resourcesPath: string | undefined): string => {
  const candidates = [
    ...(resourcesPath === undefined ? [] : [NodePath.join(resourcesPath, "tessaya")]),
    NodePath.join(dirname, "..", "resources", "tessaya"),
    NodePath.join(dirname, "..", "..", "resources", "tessaya"),
  ];
  return candidates.find((dir) => NodeFS.existsSync(dir)) ?? candidates[0]!;
};

/**
 * Her characters (apps/web/public/companion, from the Character Studio): the build puts them in the resources folder;
 * run from the source tree they are in the web app's public folder.
 */
export const companionDir = (dirname: string, resourcesPath: string | undefined): string => {
  const candidates = [
    ...(resourcesPath === undefined ? [] : [NodePath.join(resourcesPath, "companion")]),
    NodePath.join(dirname, "..", "..", "web", "public", "companion"),
    NodePath.join(dirname, "..", "..", "..", "web", "public", "companion"),
  ];
  return candidates.find((dir) => NodeFS.existsSync(dir)) ?? candidates[0]!;
};

/** The bytes of one file, or null when it is missing: a missing animation only means the still mark. */
export const readArt = (dir: string, name: string): Buffer | null => {
  try {
    return NodeFS.readFileSync(NodePath.join(dir, name));
  } catch {
    return null;
  }
};
