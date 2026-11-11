import { describe, expect, it } from "vite-plus/test";

import {
  herdrPaneRef,
  isDescriptorProcess,
  isTessayaOwnFolder,
  parseClaudeSessionDescriptor,
} from "./ClaudeLiveSessions.ts";

const descriptor = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    pid: 42,
    sessionId: "s-1",
    cwd: "/home/dev/p",
    kind: "interactive",
    entrypoint: "cli",
    name: "Vantageos",
    status: "busy",
    updatedAt: 1793006446893,
    ...over,
  });

const live = { alive: () => true, env: () => new Map<string, string>(), account: "sablebox" };

describe("live Claude Code sessions from their own descriptors (D68)", () => {
  it("reads an interactive session with its account and state", () => {
    const session = parseClaudeSessionDescriptor(descriptor(), live);
    expect(session).toMatchObject({
      pid: 42,
      sessionId: "s-1",
      status: "busy",
      account: "sablebox",
      herdrPane: null,
    });
  });

  it("skips -p workers, dead processes and unreadable files", () => {
    expect(parseClaudeSessionDescriptor(descriptor({ kind: "print" }), live)).toBeNull();
    expect(parseClaudeSessionDescriptor(descriptor(), { ...live, alive: () => false })).toBeNull();
    expect(parseClaudeSessionDescriptor("{nope", live)).toBeNull();
    expect(parseClaudeSessionDescriptor(descriptor({ entrypoint: "sdk-cli" }), live)).toBeNull();
    // T3's own claudeAgent turns report kind "interactive" with this entrypoint.
    expect(parseClaudeSessionDescriptor(descriptor({ entrypoint: "t3-code" }), live)).toBeNull();
  });

  it("knows which Herdr pane a session lives in", () => {
    expect(
      herdrPaneRef(
        new Map([
          ["HERDR_PANE_ID", "w1:p2"],
          ["HERDR_SESSION", "default"],
        ]),
      ),
    ).toBe("w1:p2");
    expect(
      herdrPaneRef(
        new Map([
          ["HERDR_PANE_ID", "w1:p1"],
          ["HERDR_SESSION", "fab-api"],
        ]),
      ),
    ).toBe("fab-api~w1:p1");
    expect(herdrPaneRef(new Map())).toBeNull();
  });
});

describe("Tessaya's own helper sessions", () => {
  it("are told apart from the user's projects by their folder under the app's data directory", () => {
    expect(isTessayaOwnFolder("C:\\Users\\robin\\.t3\\userdata")).toBe(true);
    expect(isTessayaOwnFolder("/home/dev/.t3/userdata/screen")).toBe(true);
    expect(isTessayaOwnFolder("D:\\Downloads\\Development\\3D-Printer")).toBe(false);
    expect(isTessayaOwnFolder("/home/dev/.t3x/work")).toBe(false);
    expect(isTessayaOwnFolder(null)).toBe(false);
  });
});

describe("a pid is signalled only while it is still the session's own process", () => {
  // /proc/<pid>/stat: field 22 (the start time) is the 20th after the command's closing parenthesis.
  const stat = (start: number) =>
    `42 (claude (x)) S ${Array.from({ length: 18 }, () => "0").join(" ")} ${start} 0`;
  const proc = (cmdline: string | null, start = 500) => ({
    cmdline,
    stat: stat(start),
    bootMs: 1_000_000,
  });
  it("matches the recorded start time, and a command line that runs claude", () => {
    expect(isDescriptorProcess({ pid: 42, procStart: "500" }, proc("claude --resume s"))).toBe(
      true,
    );
    expect(isDescriptorProcess({ pid: 42, procStart: "500" }, proc("node vite", 500))).toBe(false);
    // The number was reused by a later process.
    expect(isDescriptorProcess({ pid: 42, procStart: "500" }, proc("claude", 900))).toBe(false);
    expect(isDescriptorProcess({ pid: 42, procStart: "500" }, proc(null))).toBe(false);
  });
  it("without a recorded start time, refuses a process that started after the session did", () => {
    // boot 1 000 000 ms + 500 ticks × 10 ms = 1 005 000 ms.
    expect(isDescriptorProcess({ pid: 42, startedAt: 1_005_500 }, proc("claude"))).toBe(true);
    expect(isDescriptorProcess({ pid: 42, startedAt: 1_000_000 }, proc("claude"))).toBe(false);
    expect(isDescriptorProcess({ pid: 42 }, proc("claude"))).toBe(false);
  });
});
