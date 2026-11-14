import { describe, expect, it } from "vite-plus/test";

import {
  PALETTE_COLORS,
  lookVars,
  parsePillDesign,
  parsePillWave,
  resolveLook,
  t3Variable,
  waveFor,
} from "./pillLook.ts";

const base = {
  design: "tessaya",
  wave: "match",
  palette: "woad",
  systemDark: true,
  t3: null,
  t3Halves: {},
} as const;

describe("the pill's look", () => {
  it("takes each design's own waveform unless he picked one, and falls back to Tessaya and Match", () => {
    expect([
      waveFor("tessaya", "match"),
      waveFor("quiet", "match"),
      waveFor("lively", "match"),
    ]).toEqual(["mound", "bars", "beads"]);
    expect(waveFor("quiet", "beads")).toBe("beads");
    expect([parsePillDesign("neon"), parsePillWave(undefined), parsePillDesign("lively")]).toEqual([
      "tessaya",
      "match",
      "lively",
    ]);
  });

  it("wears the T3 window's theme and its half, Tessaya's palette with no T3 window, and the last T3 read before that", () => {
    const grove = { ...PALETTE_COLORS.woad.light, accent: "oklch(0.52 0.11 158)" };
    const read = resolveLook({ ...base, t3: { dark: false, colors: grove } });
    expect(read.dark).toBe(false);
    expect(read.colors.accent).toBe("oklch(0.52 0.11 158)");
    expect(resolveLook({ ...base, palette: "madder" }).colors).toEqual(PALETTE_COLORS.madder.dark);
    expect(resolveLook({ ...base, systemDark: false, t3Halves: { light: grove } }).colors).toBe(
      grove,
    );
  });

  it("puts only plain colours from a custom theme into the page", () => {
    const look = resolveLook({
      ...base,
      t3: {
        dark: true,
        colors: { ...PALETTE_COLORS.damson.dark, text: "red;}body{display:none", error: 42 },
      },
    });
    expect(look.colors.text).toBe(PALETTE_COLORS.woad.dark.text);
    expect(look.colors.error).toBe(PALETTE_COLORS.woad.dark.error);
    expect(look.colors.accent).toBe(PALETTE_COLORS.damson.dark.accent);
  });

  it("gives the pill the canvas on dark and the overlay on light, and reads the T3 window's own variables", () => {
    expect(lookVars(resolveLook(base))).toContain(`--t-pill:${PALETTE_COLORS.woad.dark.canvas}`);
    expect(lookVars(resolveLook({ ...base, systemDark: false }))).toContain(
      `--t-pill:${PALETTE_COLORS.woad.light.surfaceOverlay}`,
    );
    expect(t3Variable("accentSurfaceForeground")).toBe("--app-theme-accent-surface-foreground");
  });
});
