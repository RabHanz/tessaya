import { PALETTES, paletteThemeFile, type Palette } from "@t3tools/baton-shared/palettes";
import { getThemeColorsForAppearance } from "@t3tools/shared/themePalettes";
import { describe, expect, it } from "vite-plus/test";

import { publishedThemeDefinitions } from "./themePalette";

// OKLCH hue ranges: woad is the blue dye, damson plum, madder red.
const FAMILY: Record<Palette, (hue: number) => boolean> = {
  woad: (h) => h >= 180 && h <= 270,
  damson: (h) => h >= 290 && h <= 330,
  madder: (h) => h >= 350 || h <= 40,
};
// What reads as the theme's colour in the composer: the send button, the labels, the card and its edge.
const ROLES = [
  "accent",
  "focus",
  "messageAction",
  "accentSurfaceForeground",
  "text",
  "textMuted",
  "surface",
  "border",
] as const;

// A near-grey has no family; its hue is noise.
const tinted = (color: string, inFamily: (hue: number) => boolean) => {
  const [, chroma, hue] = /^oklch\(\S+ (\S+) (\S+)\)$/.exec(color) ?? [];
  return Number(chroma) < 0.01 || inFamily(Number(hue));
};

const CASES = (Object.keys(PALETTES) as Palette[]).flatMap((palette) =>
  (["light", "dark"] as const).map((appearance) => ({ palette, appearance })),
);

describe("Tessaya palettes as T3 themes", () => {
  it.each(CASES)(
    "keeps $palette $appearance in its dye's hue family",
    ({ palette, appearance }) => {
      const [theme] = publishedThemeDefinitions([
        { id: `tessaya-${palette}`, ...paletteThemeFile(palette) },
      ]);
      const colors = getThemeColorsForAppearance(theme!, appearance)!;
      const off = ROLES.filter((role) => !tinted(colors[role], FAMILY[palette]));
      expect(off.map((role) => `${role} ${colors[role]}`)).toEqual([]);
    },
  );
});
