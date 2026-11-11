/**
 * The logo kit's three palettes (kit USAGE.md: Woad, Damson, Madder), each with a light and a dark half.
 * Shared so the web app's tests can resolve the theme files the desktop publishes exactly as the window does.
 */
export type Palette = "woad" | "damson" | "madder";

interface Swatch {
  readonly label: string;
  readonly ink: string;
  readonly paper: string;
  readonly dye: string;
  readonly dyeOnDark: string;
}

export const PALETTES: Readonly<Record<Palette, Swatch>> = {
  woad: { label: "Woad", ink: "#0F1B1E", paper: "#EEEDE4", dye: "#14505A", dyeOnDark: "#5FB3B3" },
  damson: {
    label: "Damson",
    ink: "#151019",
    paper: "#F3EFEB",
    dye: "#4A205E",
    dyeOnDark: "#BC96CE",
  },
  // The kit's Madder on dark (#D8505C) reads at 4.3:1 on the dark panel; lifted to pass AA as text.
  madder: {
    label: "Madder",
    ink: "#1C1517",
    paper: "#F4EEE3",
    dye: "#8E1F2F",
    dyeOnDark: "#E0707A",
  },
};

export const parsePalette = (v: unknown): Palette =>
  v === "damson" || v === "madder" ? v : "woad";

const mix = (a: string, b: string, p: number): string =>
  `#${[1, 3, 5]
    .map((i) =>
      Math.round(
        Number.parseInt(a.slice(i, i + 2), 16) * p +
          Number.parseInt(b.slice(i, i + 2), 16) * (1 - p),
      )
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;

/** The dark theme's panel, from appStyle's DARK_TOKENS: the washes are mixed onto it. */
const DARK_PANEL = "#111214";

/** The accent tokens of one half, in the same proportions as Woad's hand-tuned ones. */
export const paletteTokens = (p: Palette, dark: boolean): Readonly<Record<string, string>> => {
  const s = PALETTES[p];
  const d = dark ? s.dyeOnDark : s.dye;
  return dark
    ? {
        accent: d,
        "accent-text": d,
        focus: d,
        "accent-ink": s.ink,
        "accent-deep": mix(d, DARK_PANEL, 0.12),
        "accent-wash": mix(d, DARK_PANEL, 0.16),
        "accent-edge": mix(d, DARK_PANEL, 0.4),
        "on-deep-soft": mix(d, "#ffffff", 0.7),
      }
    : {
        accent: d,
        "accent-text": d,
        focus: d,
        "accent-ink": "#ffffff",
        "accent-deep": mix(d, "#000000", 0.72),
        "accent-wash": mix(d, "#ffffff", 0.11),
        "accent-edge": mix(d, "#ffffff", 0.32),
        "on-deep-soft": mix(d, s.paper, 0.22),
      };
};

/**
 * One T3 environment theme file per palette: each half is generated from its own paper or ink and dye, plus overrides.
 * The send button is pinned to the dye: T3's generator turns it 50 degrees off the accent, which takes Damson to red.
 */
export const paletteThemeFile = (p: Palette) => {
  const s = PALETTES[p];
  const light = paletteTokens(p, false);
  return {
    version: 1,
    name: `Tessaya ${s.label}`,
    appearance: "dark",
    canvas: s.ink,
    accent: s.dyeOnDark,
    colors: {
      messageAction: s.dyeOnDark,
      messageActionForeground: s.ink,
      messageActionHover: mix(s.dyeOnDark, "#ffffff", 0.85),
    },
    variants: {
      light: {
        canvas: s.paper,
        chrome: s.paper,
        toolbar: s.paper,
        sidebar: s.paper,
        accent: s.dye,
        accentForeground: "#ffffff",
        focus: s.dye,
        accentSurface: light["accent-wash"]!,
        accentSurfaceForeground: s.dye,
        messageAction: s.dye,
        messageActionForeground: "#ffffff",
        messageActionHover: mix(s.dye, "#000000", 0.85),
      },
    },
  } as const;
};
