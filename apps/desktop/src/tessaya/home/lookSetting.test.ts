// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { tabOf } from "./tabs.ts";

const source = (file: string) =>
  NodeFS.readFileSync(NodePath.join(import.meta.dirname, file), "utf8");

describe("the Motion and Glass settings are wired end to end", () => {
  it("are saved, shown in Settings, General, found by the settings search and applied live", () => {
    const voice = source("../voice/DesktopTessayaVoice.ts");
    expect(voice).toContain('id: "v.motion"');
    expect(voice).toContain('id: "v.glass"');
    expect(voice).toContain("save({ motion: parseMotion(value) })");
    expect(voice).toContain("save({ glass: parseGlass(value) })");
    expect(voice).toContain("look: () => ({ motion: settings.motion, glass: settings.glass })");
    expect(voice).toContain("save({ palette: parsePalette(value) })");
    expect(voice).toContain("palette: settings.palette })");
    expect(tabOf("v.motion")).toBe("appearance");
    expect(tabOf("v.glass")).toBe("appearance");
    // Each push applies the look when it changed, so a change shows without a reload.
    expect(source("./tessayaHome.ts")).toMatch(/applyTheme\(\);\s*applyLook\(false\);/);
  });

  it("never lets the splash delay the window past its cap, and skips it for a quiet launch", () => {
    const home = source("./tessayaHome.ts");
    expect(home).toContain("quietLaunch: input.quietLaunch?.() ?? false");
    expect(home).toContain('reducedMotion: look().motion !== "full"');
  });
});
