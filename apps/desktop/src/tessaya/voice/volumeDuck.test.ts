// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { createVolumeDuck, parseVolume, setScript } from "./volumeDuck.ts";

const rig = (platform = "win32", failSet = false) => {
  const file = NodePath.join(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "duck-")),
    "volume.json",
  );
  const sets: string[] = [];
  const duck = createVolumeDuck({
    file,
    platform,
    run: async (script) => {
      if (script.includes("::Get()")) return "0.62;0\n";
      if (failSet) throw new Error("no audio device");
      sets.push(script.match(/::Set\(([^)]*)\)/)?.[1] ?? "");
      return "";
    },
  });
  return { duck, file, sets };
};

describe("the volume while dictating", () => {
  it("reads and sets the master volume", () => {
    expect(parseVolume("0.62;1")).toEqual({ level: 0.62, muted: true });
    expect(parseVolume("garbage")).toBeNull();
    expect(setScript(2, false)).toContain("::Set(1.000, $false)");
  });
  it("lowers it for the dictation and puts back exactly what he had", async () => {
    const { duck, file, sets } = rig();
    expect(await duck.start("lower")).toBe(true);
    expect(NodeFS.existsSync(file)).toBe(true);
    expect(await duck.start("lower")).toBe(false);
    await duck.stop();
    expect(sets).toEqual(["0.150, $false", "0.620, $false"]);
    expect(NodeFS.existsSync(file)).toBe(false);
  });
  it("mutes without changing the level, does nothing when off or off Windows, and repairs after a crash", async () => {
    const m = rig();
    await m.duck.start("mute");
    expect(m.sets[0]).toBe("0.620, $true");
    expect(await rig().duck.start("off")).toBe(false);
    expect(await rig("linux").duck.start("lower")).toBe(false);
    const crashed = rig();
    NodeFS.writeFileSync(crashed.file, JSON.stringify({ level: 0.4, muted: false }));
    expect(await crashed.duck.recover()).toBe(true);
    expect(crashed.sets).toEqual(["0.400, $false"]);
    expect(NodeFS.existsSync(crashed.file)).toBe(false);
  });
  it("leaves the volume alone when it cannot be set", async () => {
    const { duck } = rig("win32", true);
    expect(await duck.start("lower")).toBe(false);
  });
});
