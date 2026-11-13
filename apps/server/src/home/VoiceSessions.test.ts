// @effect-diagnostics nodeBuiltinImport:off globalJsonInEffect:off preferSchemaOverJson:off
import type * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeStream from "node:stream";

import { describe, expect, it, vi } from "vite-plus/test";

import { createVoiceSessions, sessionEvent, type SessionEvent } from "./VoiceSessions.ts";

const line = (event: unknown) => `${JSON.stringify(event)}\n`;
const text = (t: string) =>
  line({
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text: t } },
  });
const WARM = "only gets you ready";

/** A `claude -p` that answers each message with "ok" (a web search first when asked), or hangs on "hang". */
const fakeClaude = (
  heard: Array<string>,
  missing: { count: number },
  onHear: (said: string, proc: number) => void = () => undefined,
  killed: Array<number> = [],
) => {
  let spawned = 0;
  return (() => {
    const id = (spawned += 1);
    const stdin = new NodeStream.PassThrough();
    const stdout = new NodeStream.PassThrough();
    const proc = Object.assign(new NodeEvents.EventEmitter(), {
      stdin,
      stdout,
      kill: () => {
        killed.push(id);
        proc.emit("exit", 0);
      },
    });
    stdin.on("data", (chunk: Buffer) => {
      const said = String(JSON.parse(String(chunk)).message.content);
      heard.push(said);
      onHear(said, id);
      if (said.includes("hang")) return;
      if (said.includes("search"))
        stdout.write(
          line({
            type: "stream_event",
            event: {
              type: "content_block_start",
              content_block: { type: "tool_use", name: "WebSearch" },
            },
          }),
        );
      stdout.write(text("ok"));
      stdout.write(line({ type: "result", is_error: false }));
    });
    // A CLI that replaced itself mid-update: the first spawns find no binary.
    queueMicrotask(() =>
      missing.count-- > 0
        ? proc.emit("error", new Error("spawn claude ENOENT"))
        : proc.emit("spawn"),
    );
    return proc;
  }) as unknown as typeof NodeChildProcess.spawn;
};

const spec = {
  role: "voice" as const,
  model: "sonnet",
  effort: "low",
  system: "Be brief.",
  tools: [],
};

describe("warm subscription sessions for spoken turns", () => {
  it("reads what a turn says: words, a tool starting (web or not), the end, a failure", () => {
    expect(sessionEvent(text("Hi"))).toEqual({ type: "text", text: "Hi" });
    expect(
      sessionEvent(
        line({
          type: "stream_event",
          event: {
            type: "content_block_start",
            content_block: { type: "tool_use", name: "mcp__room__home_find" },
          },
        }),
      ),
    ).toEqual({ type: "tool", name: "home_find", web: false });
    expect(sessionEvent(line({ type: "result", is_error: true, result: "limit" }))).toEqual({
      type: "error",
      detail: "limit",
    });
    expect(sessionEvent(line({ type: "result" }))).toEqual({ type: "done" });
    expect(sessionEvent("not json")).toBeNull();
  });

  it("gives Claude Code's own file tools, in his folder, only to a session whose spec asks for them", async () => {
    const started: Array<{ cmd: string; args: ReadonlyArray<string>; cwd: unknown }> = [];
    const claude = fakeClaude([], { count: 0 });
    const spawn = ((cmd: string, args: ReadonlyArray<string>, options: { cwd?: unknown }) => {
      started.push({ cmd, args, cwd: options.cwd });
      return claude(cmd, args as Array<string>, options as never);
    }) as unknown as typeof NodeChildProcess.spawn;
    const sessions = createVoiceSessions({ spawn, retryMs: 1, lean: true });
    await sessions.warm("room", spec);
    await sessions.warm("desktop", {
      ...spec,
      builtins: { tools: ["Read", "Bash"], cwd: "/home/him", binary: "/opt/claude" },
    });
    await sessions.close();
    const toolsOf = (i: number) => started[i]!.args[started[i]!.args.indexOf("--tools") + 1];
    expect(toolsOf(0)).toBe("WebSearch,WebFetch");
    expect(started[0]!.cwd).not.toBe("/home/him");
    expect(toolsOf(1)).toBe("Read,Bash");
    expect(started[1]!.cwd).toBe("/home/him");
    expect(started.find((st) => st.cwd === "/home/him")?.cmd).toBe("/opt/claude");
    expect(started.find((st) => st.cwd !== "/home/him")?.cmd).toBe("claude");
  });

  it("survives a vanished binary, and warms each turn's own session before his words", async () => {
    const heard: Array<string> = [];
    const results: Array<string> = [];
    const sessions = createVoiceSessions({
      spawn: fakeClaude(heard, { count: 2 }),
      retryMs: 1,
      onResult: (s, result) => void results.push(`${s.role}:${String(result["type"])}`),
    });
    const events: Array<SessionEvent> = [];
    const turn = {
      run: async () => ({ text: "" }),
      onEvent: (e: SessionEvent) => void events.push(e),
    };
    await sessions.turn("r1", spec, "lights?", turn);
    await sessions.turn("r1", spec, "search the news", turn);
    await sessions.close();
    // Two spawns failed and were tried again. Each turn ran in a session of its own, warmed before his words: a
    // session that kept the conversation answered the house from memory (13 Nov room suite).
    expect(heard.filter((h) => !h.includes(WARM))).toEqual(["lights?", "search the news"]);
    const warmedBefore = (words: string) =>
      heard.slice(0, heard.indexOf(words)).filter((h) => h.includes(WARM)).length;
    expect(warmedBefore("lights?")).toBeGreaterThanOrEqual(1);
    expect(warmedBefore("search the news")).toBeGreaterThanOrEqual(2);
    expect(events).toContainEqual({ type: "tool", name: "WebSearch", web: true });
    expect(events.filter((e) => e.type === "text").length).toBe(2);
    // Every answered message is paid for, the warm-ups before each turn included.
    expect(results.length).toBeGreaterThanOrEqual(4);
    expect(new Set(results)).toEqual(new Set(["voice:result"]));
  });

  it("closes a session he cut off, and the next turn runs in a session warmed before the cut", async () => {
    const heard: Array<string> = [];
    const by: Array<string> = [];
    let reached = () => undefined as void;
    const hanging = new Promise<void>((resolve) => (reached = resolve));
    const sessions = createVoiceSessions({
      spawn: fakeClaude(heard, { count: 0 }, (said, proc) => {
        by.push(`${proc}:${said.includes(WARM) ? "warm" : said}`);
        if (said === "hang on") reached();
      }),
      retryMs: 1,
    });
    await sessions.warm("r1", spec);
    const turn = (signal?: AbortSignal) => ({
      run: async () => ({ text: "" }),
      onEvent: () => undefined,
      ...(signal === undefined ? {} : { signal }),
    });
    const abort = new AbortController();
    const cut = sessions.turn("r1", spec, "hang on", turn(abort.signal));
    // He talks over her once the session has his words.
    await hanging;
    abort.abort();
    await expect(cut).rejects.toThrow(/cut off/);
    await sessions.turn("r1", spec, "again", turn());
    await sessions.close();
    expect(heard.filter((h) => !h.includes(WARM))).toEqual(["hang on", "again"]);
    // An early start he talked past must not leave the next turn waiting on a warm-up (13 Nov: 2.9 s).
    const proc = by.find((b) => b.endsWith(":again"))!.split(":")[0];
    expect(by.indexOf(`${proc}:warm`)).toBeLessThan(by.indexOf("1:hang on"));
  });

  it("lets a vessel's sessions go when its spec changes", async () => {
    const killed: Array<number> = [];
    const sessions = createVoiceSessions({
      spawn: fakeClaude([], { count: 0 }, () => undefined, killed),
      retryMs: 1,
    });
    await sessions.warm("r1", spec);
    await sessions.warm("r1", { ...spec, system: "Be kind." });
    expect(killed.toSorted()).toEqual([1, 2]);
    await sessions.close();
  });

  it("a test harness's lean pool keeps one warm session and never renews it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const heard: Array<string> = [];
      const killed: Array<number> = [];
      const sessions = createVoiceSessions({
        spawn: fakeClaude(heard, { count: 0 }, () => undefined, killed),
        retryMs: 1,
        lean: true,
      });
      await sessions.warm("r1", spec);
      expect(heard.filter((h) => h.includes(WARM))).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(heard.filter((h) => h.includes(WARM))).toHaveLength(1);
      expect(killed).toEqual([]);
      await sessions.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("renews a waiting session before it goes stale, and stops once the vessel has gone quiet", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      let clock = 0;
      const killed: Array<number> = [];
      const sessions = createVoiceSessions({
        spawn: fakeClaude([], { count: 0 }, () => undefined, killed),
        now: () => clock,
        retryMs: 1,
      });
      await sessions.warm("r1", spec);
      clock += 30 * 60_000;
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      // Two replacements warmed, then the two they replaced went.
      expect(killed.toSorted()).toEqual([1, 2]);
      clock += 13 * 60 * 60_000;
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      expect(killed.toSorted()).toEqual([1, 2, 3, 4]);
      await sessions.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
