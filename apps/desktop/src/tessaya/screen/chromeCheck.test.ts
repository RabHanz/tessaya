import { describe, expect, it, vi } from "vite-plus/test";

import {
  checkChrome,
  checkChromeWithin,
  CLAUDE_CHROME_EXTENSION_ID,
  type ChromeProbe,
} from "./chromeCheck.ts";

const probe = (platform: string, present: ReadonlyArray<string>): ChromeProbe => ({
  platform,
  env: { LOCALAPPDATA: "C:\\Users\\sam\\AppData\\Local" },
  home: "/home/sam",
  user: "sam",
  tmp: "/tmp",
  exists: async (p) => present.some((x) => p.replaceAll("\\", "/").endsWith(x)),
  list: async (dir) =>
    dir.includes("pipe")
      ? present.filter((x) => x.startsWith("claude-mcp"))
      : dir.includes("claude-mcp-browser-bridge")
        ? present.filter((x) => x.endsWith(".sock"))
        : dir.includes("Chrome") || dir.includes("google-chrome")
          ? ["Default", "Crashpad"]
          : [],
});
const EXT = `Default/Extensions/${CLAUDE_CHROME_EXTENSION_ID}`;

describe("is Claude in Chrome set up", () => {
  it("says what to do when the extension is missing, or installed but not connected, in one line each", async () => {
    const missing = await checkChrome(probe("linux", []));
    expect(missing.state).toBe("no-extension");
    expect(missing.message).toContain("Install the extension");
    const idle = await checkChrome(probe("linux", [EXT]));
    expect(idle.state).toBe("not-connected");
    expect(idle.message.split("\n")).toHaveLength(1);
  });
  it("is ready when the extension is there and its host is listening, on each system", async () => {
    expect((await checkChrome(probe("linux", [EXT, "laptop.sock"]))).state).toBe("ready");
    expect((await checkChrome(probe("win32", [EXT, "claude-mcp-browser-bridge-sam"]))).state).toBe(
      "ready",
    );
    expect((await checkChrome(probe("darwin", [EXT, "a.sock"]))).state).toBe("ready");
    expect((await checkChrome(probe("freebsd", [EXT, "a.sock"]))).state).toBe("unsupported");
  });
  it("never waits on a probe that hangs and never throws when one fails", async () => {
    vi.useFakeTimers();
    try {
      const hang = { ...probe("linux", [EXT]), list: () => new Promise<never>(() => undefined) };
      const waiting = checkChromeWithin(hang, 4_000);
      await vi.advanceTimersByTimeAsync(4_001);
      expect(await waiting).toEqual({
        state: "not-connected",
        message: "Chrome did not answer in time.",
      });
      const broken = { ...probe("linux", [EXT]), list: () => Promise.reject(new Error("EPERM")) };
      expect((await checkChromeWithin(broken, 4_000)).message).toBe("Chrome could not be checked.");
    } finally {
      vi.useRealTimers();
    }
  });
});
