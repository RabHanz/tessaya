// @effect-diagnostics nodeBuiltinImport:off
/**
 * The logo kit's three palettes (kit USAGE.md: Woad, Damson, Madder) as themes, each with a light and a dark half.
 * Woad is the default and is the window's own tokens in appStyle.ts; the others override the accent tokens.
 * The same palettes are published to the T3 window as environment themes (`<state>/themes/*.json`), so its own
 * Appearance settings can pick them.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  paletteThemeFile,
  PALETTES,
  paletteTokens,
  type Palette,
} from "@t3tools/baton-shared/palettes";

export {
  paletteThemeFile,
  PALETTES,
  paletteTokens,
  parsePalette,
  type Palette,
} from "@t3tools/baton-shared/palettes";

const block = (tokens: Readonly<Record<string, string>>) =>
  Object.entries(tokens)
    .map(([k, v]) => `--${k}:${v}`)
    .join(";");

/** Root classes from look.ts pick the palette; Woad needs no rule. */
export const PALETTE_CSS = (["damson", "madder"] as const)
  .map(
    (p) =>
      `html.palette-${p}:not([data-theme=dark]){${block(paletteTokens(p, false))}}html.palette-${p}[data-theme=dark]{${block(paletteTokens(p, true))}}`,
  )
  .join("\n");

/** Writes the three theme files the T3 server publishes; only when one is missing or differs, so the watcher stays quiet. */
export const publishPaletteThemes = (stateDir: string): void => {
  const dir = NodePath.join(stateDir, "themes");
  NodeFS.mkdirSync(dir, { recursive: true });
  for (const p of Object.keys(PALETTES) as Palette[]) {
    const file = NodePath.join(dir, `tessaya-${p}.json`);
    const text = `${JSON.stringify(paletteThemeFile(p), null, 2)}\n`;
    let old: string | null = null;
    try {
      old = NodeFS.readFileSync(file, "utf8");
    } catch {
      // Missing: written below.
    }
    if (old !== text) NodeFS.writeFileSync(file, text);
  }
};

/** The T3 window's own keys for its chosen theme and its light/dark mix (apps/web useTheme.ts, themePalette.ts). */
export const T3_THEME_KEY = "t3code:theme";
export const T3_THEME_HALVES_KEY = "t3code:theme-halves:v1";

/**
 * The T3 theme to select when he picks a palette here, or null to leave the T3 window alone. It follows while the
 * T3 window wears one of Tessaya's themes, or while it is still on T3's untouched default and Tessaya has never set
 * it. A theme he picked there himself, or a light/dark mix, is his: it is never replaced.
 */
export const linkedT3Theme = (
  palette: Palette,
  t3: { readonly theme: string | null; readonly halves: string | null },
  linkedBefore: boolean,
): string | null => {
  const ours = t3.theme !== null && t3.theme.startsWith("tessaya-");
  const untouched = (t3.theme === null || t3.theme === "system") && !linkedBefore;
  const mixed = t3.halves !== null && t3.halves !== "null";
  return !mixed && (ours || untouched) ? `tessaya-${palette}` : null;
};
