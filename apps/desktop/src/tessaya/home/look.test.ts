import { describe, expect, it } from "vite-plus/test";

import {
  applyLookScript,
  effectiveGlass,
  effectiveMotion,
  lookClasses,
  materialFor,
  parseGlass,
  parseMotion,
  windowsBuild,
} from "./look.ts";

const calm = { reducedMotion: false, reducedTransparency: false };

describe("motion and glass", () => {
  it("defaults to full motion and glass on, and survives a hand-edited file", () => {
    expect(parseMotion(undefined)).toBe("full");
    expect(parseMotion("nonsense")).toBe("full");
    expect(parseGlass(7)).toBe("on");
    expect(parseMotion("off")).toBe("off");
    expect(parseGlass("reduced")).toBe("reduced");
  });

  it("follows the system only when left on Full or On; a chosen Reduced or Off is kept", () => {
    expect(effectiveMotion("full", { ...calm, reducedMotion: true })).toBe("reduced");
    expect(effectiveMotion("off", { ...calm, reducedMotion: true })).toBe("off");
    expect(effectiveMotion("full", calm)).toBe("full");
    expect(effectiveGlass("on", { ...calm, reducedTransparency: true })).toBe("reduced");
    expect(effectiveGlass("off", calm)).toBe("off");
  });

  it("names the classes B's styles read, and none for the defaults", () => {
    expect(lookClasses("full", "on")).toEqual([]);
    expect(lookClasses("reduced", "on")).toEqual(["motion-reduced"]);
    expect(lookClasses("off", "off")).toEqual(["motion-off", "glass-off"]);
    expect(lookClasses("reduced", "reduced")).toEqual(["motion-reduced", "glass-reduced"]);
    expect(lookClasses("full", "on", "damson")).toEqual(["palette-damson"]);
    expect(lookClasses("full", "on", "woad")).toEqual([]);
  });

  it("builds a script that removes every look class and adds only known ones", () => {
    const script = applyLookScript(["motion-off", 'evil");alert(1);//']);
    expect(script).toContain(
      '["motion-reduced","motion-off","glass-reduced","glass-off","palette-damson","palette-madder"].forEach',
    );
    expect(script).toContain('["motion-off"].forEach(x=>c.add(x))');
    expect(script).not.toContain("alert");
  });
});

describe("the window's material", () => {
  it("is Acrylic on Windows 11 22H2 or later, plain on Windows 10 and older builds", () => {
    expect(windowsBuild("10.0.22631")).toBe(22631);
    expect(windowsBuild("6.8.0-101-generic")).toBe(0);
    expect(materialFor("win32", "10.0.22631", "on")).toEqual({ backgroundMaterial: "acrylic" });
    expect(materialFor("win32", "10.0.22000", "on")).toEqual({});
    expect(materialFor("win32", "10.0.19045", "on")).toEqual({});
  });

  it("uses vibrancy on macOS, nothing on Linux, and drops the material when glass is reduced or off", () => {
    expect(materialFor("darwin", "24.0.0", "on")).toEqual({
      vibrancy: "under-window",
      visualEffectState: "followWindow",
    });
    expect(materialFor("linux", "6.8.0", "on")).toEqual({});
    expect(materialFor("win32", "10.0.22631", "reduced")).toEqual({ backgroundMaterial: "none" });
    expect(materialFor("win32", "10.0.22631", "off")).toEqual({ backgroundMaterial: "none" });
    expect(materialFor("darwin", "24.0.0", "off")).toEqual({});
  });
});
