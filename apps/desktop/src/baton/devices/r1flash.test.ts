import { describe, expect, it } from "vite-plus/test";

import { r1flashArgs, r1flashAsset, r1flashEvent, signedSums } from "./r1flash.ts";

describe("repairing an R1 by cable from the desktop", () => {
  it("builds r1flash's arguments only for the operations the page may ask for", () => {
    expect(r1flashArgs({ op: "ports" })).toEqual(["ports", "--json"]);
    expect(r1flashArgs({ op: "flash", version: "smp-0.3.98", port: "COM7" })).toEqual([
      "flash",
      "--version",
      "smp-0.3.98",
      "--port",
      "COM7",
      "--json",
    ]);
    expect(r1flashArgs({ op: "recover", port: "/dev/ttyUSB0" })).toEqual([
      "recover",
      "--port",
      "/dev/ttyUSB0",
      "--json",
    ]);
    expect(r1flashArgs({ op: "console", port: "/dev/cu.usbserial-1410" })).not.toBeNull();
    // Never a file of the page's choosing, an unsigned image, a version that is not a release, or another flag.
    expect(r1flashArgs({ op: "flash", version: "smp-0.3.98 --allow-unsigned" })).toBeNull();
    expect(r1flashArgs({ op: "flash", version: "../x.bin" })).toBeNull();
    expect(r1flashArgs({ op: "flash" })).toBeNull();
    expect(r1flashArgs({ op: "restore" })).toBeNull();
    expect(r1flashArgs({ op: "detect", port: "COM7 --allow-unsigned" })).toBeNull();
    expect(r1flashArgs({ op: "detect", port: "/etc/passwd" })).toBeNull();
    expect(r1flashArgs(null)).toBeNull();
  });

  it("passes on r1flash's events and drops anything else it prints", () => {
    expect(r1flashEvent('{"ev":"progress","phase":"write","done":1,"total":4}')).toEqual({
      ev: "progress",
      phase: "write",
      done: 1,
      total: 4,
    });
    expect(r1flashEvent("plain text")).toBeNull();
    expect(r1flashEvent('{"phase":"write"}')).toBeNull();
    expect(r1flashEvent("[1,2]")).toBeNull();
  });

  it("names this machine's build, and refuses checksums not signed by the release key", () => {
    expect(r1flashAsset("win32", "x64")).toBe("r1flash-windows-amd64.exe");
    expect(r1flashAsset("darwin", "arm64")).toBe("r1flash-darwin-arm64");
    expect(r1flashAsset("linux", "arm64")).toBe("r1flash-linux-arm64");
    expect(r1flashAsset("win32", "arm64")).toBeNull();
    expect(r1flashAsset("linux", "ia32")).toBeNull();
    const sums = Buffer.from("abc  r1flash-linux-amd64\n");
    expect(signedSums(sums, "00".repeat(64))).toBe(false);
    expect(signedSums(sums, "not hex")).toBe(false);
  });
});
