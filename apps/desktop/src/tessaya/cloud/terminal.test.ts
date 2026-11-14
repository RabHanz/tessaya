import { describe, expect, it } from "vite-plus/test";

import { terminalPlan } from "./terminal.ts";

describe("opening a sign-in in a terminal", () => {
  it("opens a visible window on each system for the two fixed commands", () => {
    expect(terminalPlan("win32", "claude auth login")).toEqual({
      file: "cmd.exe",
      args: ["/d", "/c", "start", "", "cmd.exe", "/d", "/k", "claude auth login"],
    });
    expect(terminalPlan("darwin", "codex login")?.file).toBe("osascript");
    expect(terminalPlan("linux", "codex login")?.args.join(" ")).toContain("codex login");
  });
  it("refuses any other text, so a task or a page can never choose the command", () => {
    for (const bad of ["claude auth login && del *", "rm -rf /", "", "codex login; x"])
      expect(terminalPlan("win32", bad)).toBeNull();
  });
});
