/** Baton's window follows Windows unless he picks Light or Dark in Settings, General. */
export type Appearance = "system" | "light" | "dark";
export type Theme = "light" | "dark";

/** The saved value, or "system" for anything else: a hand-edited file never breaks the window. */
export const parseAppearance = (value: unknown): Appearance =>
  value === "light" || value === "dark" ? value : "system";

export const resolveTheme = (appearance: Appearance, systemIsDark: boolean): Theme =>
  appearance === "system" ? (systemIsDark ? "dark" : "light") : appearance;

/** What Electron's native theme is told: the system material (Acrylic's tint, the title bar) then matches the page. */
export const themeSourceFor = (appearance: Appearance): "system" | Theme => appearance;

/** The window's own colour before the page paints, so opening it never flashes the other theme. */
export const THEME_GROUND: Readonly<Record<Theme, string>> = { light: "#f3f0e8", dark: "#121110" };
