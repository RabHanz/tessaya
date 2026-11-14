// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { EnvironmentThemeFile, environmentThemeFileHasColors } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { APP_CSS } from "./appStyle.ts";
import {
  linkedT3Theme,
  PALETTES,
  paletteThemeFile,
  parsePalette,
  publishPaletteThemes,
  type Palette,
} from "./palette.ts";

describe("the palettes", () => {
  it("parses a saved choice, and anything else is Woad", () => {
    expect(["damson", "madder", "woad", "purple", undefined].map(parsePalette)).toEqual([
      "damson",
      "madder",
      "woad",
      "woad",
      "woad",
    ]);
  });

  it("gives the window a light and a dark rule for each palette but Woad", () => {
    for (const p of ["damson", "madder"])
      for (const half of [
        `html.palette-${p}:not([data-theme=dark]){`,
        `html.palette-${p}[data-theme=dark]{`,
      ])
        expect(APP_CSS).toContain(half);
    expect(APP_CSS).not.toContain("palette-woad");
  });

  it("selects the matching T3 theme only while the T3 window is on Tessaya's or untouched", () => {
    const t3 = (theme: string | null, halves: string | null = null) => ({ theme, halves });
    expect(linkedT3Theme("damson", t3(null), false)).toBe("tessaya-damson");
    expect(linkedT3Theme("damson", t3("system"), false)).toBe("tessaya-damson");
    expect(linkedT3Theme("woad", t3("tessaya-damson"), true)).toBe("tessaya-woad");
    // He went back to T3's default after a link, or picked his own: both are left alone.
    expect(linkedT3Theme("madder", t3("system"), true)).toBeNull();
    expect(linkedT3Theme("madder", t3("ocean"), false)).toBeNull();
    expect(linkedT3Theme("madder", t3("dark"), false)).toBeNull();
    expect(
      linkedT3Theme("madder", t3("tessaya-woad", '{"light":"iris","dark":"tessaya-woad"}'), true),
    ).toBeNull();
  });

  it("publishes theme files the T3 server accepts, and rewrites none that did not change", () => {
    const decode = Schema.decodeUnknownSync(EnvironmentThemeFile);
    for (const p of Object.keys(PALETTES) as Palette[])
      expect(environmentThemeFileHasColors(decode(paletteThemeFile(p)))).toBe(true);
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "palettes-"));
    publishPaletteThemes(dir);
    const file = NodePath.join(dir, "themes", "tessaya-damson.json");
    expect(NodeFS.readdirSync(NodePath.join(dir, "themes")).toSorted()).toEqual([
      "tessaya-damson.json",
      "tessaya-madder.json",
      "tessaya-woad.json",
    ]);
    NodeFS.utimesSync(file, 0, 0);
    publishPaletteThemes(dir);
    expect(NodeFS.statSync(file).mtimeMs).toBe(0);
  });
});
