import { describe, expect, it } from "vite-plus/test";

import { herdrTerminalSessionName, terminalShellCandidates } from "./HerdrTerminal.ts";

const shells = [{ shell: "/bin/bash" }, { shell: "/bin/sh" }];

describe("a terminal backed by a Herdr session (D61)", () => {
  it("is an ordinary shell unless the machine asks for Herdr", () => {
    expect(
      terminalShellCandidates({ runtime: undefined, threadId: "t", terminalId: "x", shells }),
    ).toEqual(shells);
    expect(
      terminalShellCandidates({ runtime: "pty", threadId: "t", terminalId: "x", shells }),
    ).toEqual(shells);
  });

  it("attaches to one named session per terminal, and keeps the shells as a fallback", () => {
    const candidates = terminalShellCandidates({
      runtime: "herdr",
      threadId: "thread-1",
      terminalId: "default",
      shells,
    });
    expect(candidates[0]).toEqual({ shell: "herdr", args: ["--session", "t3-thread-1-default"] });
    expect(candidates.slice(1)).toEqual(shells);
  });

  it("names the session the same way every time, so reopening re-attaches", () => {
    expect(herdrTerminalSessionName("a/b c", "term:2")).toBe(
      herdrTerminalSessionName("a/b c", "term:2"),
    );
    expect(herdrTerminalSessionName("a/b c", "term:2")).toBe("t3-a-b-c-term-2");
    expect(herdrTerminalSessionName("x".repeat(100), "y".repeat(100)).length).toBeLessThanOrEqual(
      64,
    );
  });
});
