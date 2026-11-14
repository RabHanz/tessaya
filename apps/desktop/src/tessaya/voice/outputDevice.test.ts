// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  createOutputWatch,
  outputDeviceFrom,
  outputKindOf,
  readScript,
  speakerModeOf,
} from "./outputDevice.ts";

describe("headphones or speakers, from the playback device", () => {
  it.each([
    // [what the reader printed (a form factor, maybe more after it), what it means]
    ["3", "headphones"],
    ["5", "headphones"],
    ["6", "headphones"],
    ["1", "speakers"],
    ["2", "speakers"],
    ["9", "speakers"],
    // Only the form factor decides: a Bluetooth speaker or soundbar is a speaker, never headphones.
    ["1;BTHENUM", "speakers"],
    ["10;BTHHFENUM", null],
    ["10", null],
    ["", null],
    ["Exception calling Get", null],
  ] as const)("%j is %s", (out, kind) => {
    expect(outputKindOf(out)).toBe(kind);
  });

  it("follows the device on Automatic, and his choice otherwise", () => {
    expect(speakerModeOf("auto", "headphones")).toBe("headphones");
    expect(speakerModeOf("auto", null)).toBe("speakers");
    expect(speakerModeOf("speakers", "headphones")).toBe("speakers");
    expect(speakerModeOf("headphones", "speakers")).toBe("headphones");
  });

  it.each([
    // [saved settings, the choice they mean]
    [{ headphones: true }, "headphones"],
    [{ headphones: true, outputDevice: "auto" }, "auto"],
    [{}, "auto"],
    [{ outputDevice: "bogus" }, "auto"],
    [{ outputDevice: "speakers" }, "speakers"],
  ] as const)("reads %j as %s", (saved, choice) => {
    expect(outputDeviceFrom(saved)).toBe(choice);
  });

  it("compiles the reader once, into its own folder, and only loads it after that", () => {
    const script = readScript("C:\\Users\\user\\state's\\voice");
    // Built to a temporary file and moved into place; a DLL that will not load is deleted and built again.
    // A failed load must throw into the catch, and a temporary file left by a failed move is cleared.
    expect(script).toMatch(/-OutputAssembly \$tmp -ErrorAction Stop/);
    expect(script).toMatch(
      /Move-Item -Force -LiteralPath \$tmp -Destination \$dll\s+Remove-Item -Force -LiteralPath \$tmp/,
    );
    expect(script).toMatch(/try \{ Add-Type -LiteralPath \$dll -ErrorAction Stop \} catch/);
    expect(script).toMatch(/if \(-not \(Test-Path -LiteralPath \$dll\)\) \{ Build \}/);
    expect(script).toMatch(
      /catch \{\s+Remove-Item -Force -LiteralPath \$dll[^}]*Build\s+Add-Type -LiteralPath \$dll/,
    );
    expect(script).toContain("C:\\Users\\user\\state''s\\voice\\tessaya-output-");
  });

  it("reads at most once a while, except after headphones, only on Windows, and forgets on a failed read", async () => {
    let clock = 0;
    const outs: Array<string | Error> = ["1", "3", "3", new Error("powershell")];
    let runs = 0;
    const dir = NodePath.join(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "output-")),
      "voice",
    );
    const watch = createOutputWatch({
      platform: "win32",
      dir,
      everyMs: 1_000,
      now: () => clock,
      run: async () => {
        const out = outs[runs++];
        if (out instanceof Error) throw out;
        return out ?? "";
      },
    });
    // The reader's folder is made for it.
    expect(NodeFS.existsSync(dir)).toBe(true);
    await watch.refresh();
    expect(watch.kind()).toBe("speakers");
    await watch.refresh();
    expect(runs).toBe(1);
    clock = 1_000;
    await watch.refresh();
    expect(watch.kind()).toBe("headphones");
    // Headphones on: every look reads again, so taking them off is seen at once, and until that look returns the
    // old headphones answer counts as unknown (speakers).
    const look = watch.refresh();
    expect(watch.kind()).toBe(null);
    await look;
    expect(runs).toBe(3);
    expect(watch.kind()).toBe("headphones");
    await watch.refresh();
    expect(watch.kind()).toBe(null);
    const mac = createOutputWatch({ platform: "darwin", dir, run: async () => "3" });
    await mac.refresh();
    expect(mac.kind()).toBe(null);
    NodeFS.rmSync(NodePath.dirname(dir), { recursive: true, force: true });
  });
});
