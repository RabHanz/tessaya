// @effect-diagnostics nodeBuiltinImport:off globalJsonInEffect:off preferSchemaOverJson:off
import type * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeStream from "node:stream";

import { describe, expect, it } from "vite-plus/test";

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
  onHear: (said: string) => void = () => undefined,
) =>
  (() => {
    const stdin = new NodeStream.PassThrough();
    const stdout = new NodeStream.PassThrough();
    const proc = Object.assign(new NodeEvents.EventEmitter(), {
      stdin,
      stdout,
      kill: () => void proc.emit("exit", 0),
    });
    stdin.on("data", (chunk: Buffer) => {
      const said = String(JSON.parse(String(chunk)).message.content);
      heard.push(said);
      onHear(said);
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

const spec = { model: "sonnet", effort: "low", system: "Be brief.", tools: [] };

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

  it("survives a vanished binary, and warms each turn's own session before his words", async () => {
    const heard: Array<string> = [];
    const sessions = createVoiceSessions({ spawn: fakeClaude(heard, { count: 2 }), retryMs: 1 });
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
  });

  it("closes a session he cut off, and the next turn runs in its warm successor", async () => {
    const heard: Array<string> = [];
    let reached = () => undefined as void;
    const hanging = new Promise<void>((resolve) => (reached = resolve));
    const sessions = createVoiceSessions({
      spawn: fakeClaude(heard, { count: 0 }, (said) => said === "hang on" && reached()),
      retryMs: 1,
    });
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
  });
});
