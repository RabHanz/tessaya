// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { emptyContextBus } from "@t3tools/baton-shared/contextBus";
import type { VoiceRouter } from "@t3tools/baton-voice";
import { describe, expect, it } from "vite-plus/test";

import { withBrainRoutes } from "../voice/desktopVoiceCore.ts";
import {
  resolveBinary,
  resultOf,
  spawnable,
  startVisionSession,
  subscriptionEnv,
  userMessage,
  toolRequestOf,
  toolUsesOf,
  visionArgs,
} from "./claudeVision.ts";
import { virtualKeys, xdotoolChord } from "./inputDriver.ts";

describe("claudeVision", () => {
  it("never passes an API key to the child", () => {
    const metered = subscriptionEnv({
      ANTHROPIC_BASE_URL: "https://proxy",
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_CODE_USE_VERTEX: "1",
      KEEP: "yes",
    });
    expect(metered).toEqual({ KEEP: "yes" });
    const env = subscriptionEnv({
      PATH: "/bin",
      ANTHROPIC_API_KEY: "sk",
      ANTHROPIC_AUTH_TOKEN: "t",
    });
    expect(env).toEqual({ PATH: "/bin" });
  });

  it("runs safe, tool-less and unsaved", () => {
    const args = visionArgs("/tmp/p.txt", "sonnet");
    expect(args).toContain("--safe-mode");
    expect(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2)).toEqual([
      "--tools",
      "",
    ]);
    expect(args).toContain("--no-session-persistence");
    expect(args).not.toContain("--bare"); // --bare would require an API key
  });

  it("asks for medium effort on Opus, and none of the fast router model", () => {
    const opus = visionArgs("/tmp/p.txt", "claude-opus-5-5");
    expect(opus.slice(opus.indexOf("--effort"), opus.indexOf("--effort") + 2)).toEqual([
      "--effort",
      "medium",
    ]);
    expect(visionArgs("/tmp/p.txt", "haiku")).not.toContain("--effort");
  });

  it("sends images as base64 blocks", () => {
    const line = JSON.parse(
      userMessage([
        { type: "text", text: "hi" },
        { type: "image", mediaType: "image/jpeg", data: Buffer.from([1, 2, 3]) },
      ]),
    );
    expect(line.message.content[1]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: "AQID" },
    });
  });

  it("reads the answer out of the result event only", () => {
    expect(resultOf('{"type":"assistant"}')).toBeNull();
    expect(resultOf("not json")).toBeNull();
    expect(resultOf('{"type":"result","result":"ok [POINT:1,2]"}')).toEqual({
      ok: true,
      text: "ok [POINT:1,2]",
    });
    expect(resultOf('{"type":"result","is_error":true,"result":"Not logged in"}')).toEqual({
      ok: false,
      error: "Not logged in",
    });
  });

  it("finds claude.exe or npm's claude.cmd on a Windows PATH", () => {
    const env = { Path: "C:\\a;C:\\b" };
    expect(resolveBinary("claude", "win32", env, (p) => p === "C:\\b\\claude.cmd")).toBe(
      "C:\\b\\claude.cmd",
    );
    expect(
      resolveBinary("claude", "win32", env, (p) => p.endsWith("claude.exe") || p.endsWith(".cmd")),
    ).toBe("C:\\a\\claude.exe");
    expect(resolveBinary("claude", "linux", env, () => true)).toBe("claude");
    expect(resolveBinary("D:\\tools\\claude.exe", "win32", env, () => false)).toBe(
      "D:\\tools\\claude.exe",
    );
    // npm's shim runs the package's own exe, which a server can start without a shell (his laptop, 13 Nov).
    const exe = "C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe";
    expect(spawnable("C:\\npm\\claude.cmd", (p) => p === exe)).toBe(exe);
    expect(spawnable("C:\\npm\\claude.cmd", () => false)).toBe("C:\\npm\\claude.cmd");
    expect(spawnable("claude")).toBe("claude");
  });

  it("names a missing claude in words", async () => {
    const session = startVisionSession({
      claudeBinary: "/nonexistent/claude",
      model: "sonnet",
      systemPrompt: "x",
      workDir: NodePath.join(process.env["TMPDIR"] ?? "/tmp", "baton-screen-test"),
      env: {},
      platform: "linux",
    });
    await expect(session.ask([{ type: "text", text: "hi" }])).rejects.toThrow(
      "Claude Code was not found",
    );
    session.dispose();
  });

  // The real thing, on the subscription: BATON_REAL_CLAUDE=1 with `claude` signed in (Linux/macOS).
  // BATON_REAL_SCREENSHOT: a 900x506 PNG of YouTube's home page, its search box where the bounds below say.
  it.runIf(
    process.env["BATON_REAL_CLAUDE"] === "1" && process.env["BATON_REAL_SCREENSHOT"] !== undefined,
  )("answers a screenshot question with a point on the right element", async () => {
    const png = NodeFS.readFileSync(process.env["BATON_REAL_SCREENSHOT"]!);
    const { LOOK_PROMPT, parseReply } = await import("@t3tools/baton-shared/screenCompanion");
    const session = startVisionSession({
      claudeBinary: "claude",
      model: "sonnet",
      systemPrompt: LOOK_PROMPT,
      workDir: NodePath.join(process.env["TMPDIR"] ?? "/tmp", "baton-screen-real"),
      env: process.env,
      platform: "linux",
    });
    try {
      const reply = parseReply(
        await session.ask([
          {
            type: "text",
            text: "user's screen (cursor is here) (image dimensions: 900x506 pixels)",
          },
          { type: "image", mediaType: "image/png", data: png },
          { type: "text", text: "where do i type to search for videos?" },
        ]),
      );
      // The search box spans roughly x 240–580, y 52–82 in this frame.
      expect(reply.point).not.toBeNull();
      expect(reply.point!.x).toBeGreaterThan(240);
      expect(reply.point!.x).toBeLessThan(580);
      expect(reply.point!.y).toBeGreaterThan(45);
      expect(reply.point!.y).toBeLessThan(90);
      expect(reply.spoken.length).toBeGreaterThan(10);
    } finally {
      session.dispose();
    }
  });
});

describe("inputDriver key maps", () => {
  it("maps chords to Windows virtual keys", () => {
    expect(virtualKeys(["ctrl", "s"])).toEqual([0x11, 0x53]);
    expect(virtualKeys(["alt", "F4"])).toEqual([0x12, 0x73]);
    expect(virtualKeys(["enter"])).toEqual([0x0d]);
    expect(() => virtualKeys(["win"])).toThrow('does not press "win"');
  });

  it("maps chords to xdotool names", () => {
    expect(xdotoolChord(["ctrl", "l"])).toBe("ctrl+l");
    expect(xdotoolChord(["enter"])).toBe("Return");
    expect(xdotoolChord(["shift", "f5"])).toBe("shift+F5");
  });
});

describe("withBrainRoutes", () => {
  const seen: string[] = [];
  const inner: VoiceRouter = {
    route: async (effect) => {
      seen.push(`${effect.kind}:${"text" in effect ? effect.text : ""}`);
      return { kind: "ran", reply: "from baton", workSessionId: null, source: "intent" };
    },
  };
  const bus = emptyContextBus;
  const router = withBrainRoutes(inner, {
    said: async (text) =>
      text === "nuke it" ? { kind: "refused", reply: "no" } : { kind: "handled" },
  });
  const route = (effect: unknown) => router.route(effect as never, { bus, now: 0 });

  it("lets the brain handle or refuse, and sends nothing to the old intent path", async () => {
    await expect(
      route({ kind: "command", text: "capital of Peru", inheritedTarget: null }),
    ).resolves.toMatchObject({ reply: "", source: "screen" });
    await expect(
      route({ kind: "command", text: "nuke it", inheritedTarget: null }),
    ).resolves.toMatchObject({ kind: "refused", reason: "high_risk" });
    await route({ kind: "session_message", text: "run the tests" });
    expect(seen).toEqual([]);
  });

  it("never lets dictated text near the brain", async () => {
    let asked = 0;
    const counting = withBrainRoutes(inner, {
      said: async () => {
        asked += 1;
        return { kind: "handled" };
      },
    });
    await counting.route({ kind: "dictate", text: "my private note" } as never, { bus, now: 0 });
    expect(asked).toBe(0);
  });
});

describe("the operator's Claude session", () => {
  it("opens the gate only for an operator, and shuts out his and the folder's settings", () => {
    const plain = visionArgs("p.txt", "sonnet");
    expect(plain[plain.indexOf("--tools") + 1]).toBe("");
    expect(plain).not.toContain("--permission-prompt-tool");
    const operator = visionArgs("p.txt", "sonnet", true);
    expect(operator[operator.indexOf("--setting-sources") + 1]).toBe("");
    expect(operator[operator.indexOf("--permission-mode") + 1]).toBe("default");
    expect(operator[operator.indexOf("--permission-prompt-tool") + 1]).toBe("stdio");
    expect(operator).toContain("--safe-mode");
    // Safe mode drops every MCP server, Tessaya's own too, so the assistant's session goes without it.
    const assistant = visionArgs("p.txt", "sonnet", true, "mcp.json");
    expect(assistant).not.toContain("--safe-mode");
    expect(assistant).toContain("--strict-mcp-config");
    expect(assistant[assistant.indexOf("--setting-sources") + 1]).toBe("");
  });

  it("reads a permission request, and nothing else, as one", () => {
    const line = JSON.stringify({
      type: "control_request",
      request_id: "r1",
      request: { subtype: "can_use_tool", tool_name: "Write", input: { file_path: "b.txt" } },
    });
    expect(toolRequestOf(line)).toEqual({
      requestId: "r1",
      call: { tool: "Write", input: { file_path: "b.txt" } },
    });
    expect(toolRequestOf('{"type":"assistant"}')).toBeNull();
    expect(toolRequestOf("not json")).toBeNull();
  });

  it("finds every tool call, including those the CLI runs with no request", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Bash", input: { command: "echo" } }] },
    });
    expect(toolUsesOf(line)).toEqual([{ tool: "Bash", input: { command: "echo" } }]);
  });
});
