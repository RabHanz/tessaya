// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { artDir, readArt, stingFile, taskbarIconFile } from "./artFiles.ts";
import { PALETTES, type Palette } from "./palette.ts";

const here = NodePath.dirname(new URL(import.meta.url).pathname);
const dir = NodePath.resolve(here, "../../../resources/tessaya");

describe("the palette art", () => {
  it("has the sting and a taskbar icon for every palette, light and dark", () => {
    for (const palette of Object.keys(PALETTES) as Palette[])
      for (const theme of ["light", "dark"] as const) {
        const sting = readArt(dir, stingFile(palette, theme));
        // A WebP that animates: RIFF....WEBP with an ANIM chunk.
        expect(sting?.subarray(0, 4).toString("latin1"), `${palette} ${theme}`).toBe("RIFF");
        expect(sting?.includes("ANIM"), `${palette} ${theme}`).toBe(true);
        const icon = readArt(dir, taskbarIconFile(palette, theme));
        // An .ico header: reserved 0, type 1, and every size from 16 to 256.
        expect(icon?.readUInt16LE(2), `${palette} ${theme}`).toBe(1);
        expect(icon?.readUInt16LE(4)).toBeGreaterThanOrEqual(9);
      }
  });
  it("finds the folder in the packaged app's resources first, else beside the built script, and says null for a file that is not there", () => {
    expect(
      NodeFS.realpathSync(artDir(NodePath.resolve(here, "../../../dist-electron"), undefined)),
    ).toBe(NodeFS.realpathSync(dir));
    // Packaged: the app's resources folder comes first.
    expect(artDir("/nowhere/dist-electron", NodePath.resolve(dir, ".."))).toBe(dir);
    expect(readArt(dir, "nothing.webp")).toBeNull();
  });
});
