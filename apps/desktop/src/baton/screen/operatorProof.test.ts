// @effect-diagnostics globalFetch:off nodeBuiltinImport:off
/**
 * The repeatable proof of the operator's gate (D127, D128): `scripts/tessaya/operator-proof.sh` runs this.
 * No microphone, no pointer, no model. Each case feeds the harness's own protocol lines through the
 * real gate: Claude's `control_request` and Codex's approval requests in, the harness's reply out.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { textIsFromConversation } from "@t3tools/tessaya-shared/conversation";
import {
  gatePrompt,
  judgeToolCall,
  spokenOutcome,
  announceTool,
  type ToolCall,
} from "@t3tools/tessaya-shared/operator";
import { describe, expect, it } from "vite-plus/test";

import { createAgentGate, createTaint } from "../agent/agentGate.ts";
import { createPersonaConversations } from "../conversation/conversationLog.ts";
import { startBatonMcp, type BatonTool } from "../agent/batonMcp.ts";
import { makeCodexClient } from "./codexOperator.ts";
import { toolAnswerOf, toolRequestOf, toolUsesOf } from "./claudeVision.ts";

type Said = "yes" | "no" | "expired";

/** One operator turn as the companion runs it: calls announced, then asked, in order. */
const turn = (options: { actWithoutAsking: boolean; said: Said }) => {
  let ran = 0;
  let tainted = false;
  const asked: Array<{ tool: string; risky: boolean; noOnExpiry: boolean }> = [];
  const announce = (tool = "x") => void ({ tainted, ran } = announceTool(ran, tool));
  const gate = async (call: ToolCall) => {
    const judged = judgeToolCall(call, {
      actWithoutAsking: options.actWithoutAsking,
      tainted,
    });
    if (judged.verdict === "allow") return { allow: true as const };
    if (judged.verdict === "deny") return { allow: false as const, reason: judged.why };
    const prompt = gatePrompt(judged, "x");
    asked.push({ tool: call.tool, risky: judged.risky === true, noOnExpiry: prompt.noOnExpiry });
    // An unanswered ordinary question waits for the box, which is not a yes either.
    const outcome = spokenOutcome(options.said, {
      yes: 0,
      cancel: 1,
      noOnExpiry: prompt.noOnExpiry,
    });
    return outcome === 0
      ? { allow: true as const }
      : { allow: false as const, reason: "He said no. Stop and tell him." };
  };
  return { announce, gate, asked };
};

const claudeLine = (id: string, tool_name: string, input: Record<string, unknown>) =>
  JSON.stringify({
    type: "control_request",
    request_id: id,
    request: { subtype: "can_use_tool", tool_name, input },
  });
const claudeUse = (name: string, input: Record<string, unknown>) =>
  JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name, input }] } });

/** Claude: a stream-json line in, the permission reply out. */
const claudeReply = async (t: ReturnType<typeof turn>, lines: ReadonlyArray<string>) => {
  const replies: unknown[] = [];
  for (const line of lines) {
    const request = toolRequestOf(line);
    if (request === null) {
      for (const use of toolUsesOf(line)) t.announce(use.tool);
      continue;
    }
    replies.push(toolAnswerOf(await t.gate(request.call), request.call));
  }
  return replies;
};

const settle = async () => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};
/** Codex: an approval request in, the harness's decision out. */
const codexReply = async (
  t: ReturnType<typeof turn>,
  method: string,
  params: Record<string, unknown>,
) => {
  const sent: Array<Record<string, unknown>> = [];
  const client = makeCodexClient({ write: (line) => sent.push(JSON.parse(line)), gate: t.gate });
  t.announce("commandExecution");
  client.onLine(JSON.stringify({ id: 1, method, params }));
  await settle();
  return sent;
};

describe("operator proof", () => {
  it("PROOF 1: a fetch after a read asks, even with Act without asking on", async () => {
    const t = turn({ actWithoutAsking: true, said: "no" });
    const replies = await claudeReply(t, [
      claudeUse("Read", { file_path: "notes.txt" }),
      claudeUse("WebFetch", { url: "https://example.com/?q=1" }),
      claudeLine("r1", "WebFetch", { url: "https://example.com/?q=1" }),
    ]);
    expect(t.asked.map((a) => a.tool)).toEqual(["WebFetch"]);
    expect(replies).toEqual([{ behavior: "deny", message: "He said no. Stop and tell him." }]);
  });

  it("PROOF 2: a high-risk call asks, and an answer that never comes is a no", async () => {
    const claude = turn({ actWithoutAsking: true, said: "expired" });
    const [claudeAnswer] = await claudeReply(claude, [
      claudeLine("r2", "Bash", { command: "git push --force origin main" }),
    ]);
    expect(claude.asked).toEqual([{ tool: "Bash", risky: true, noOnExpiry: true }]);
    expect(claudeAnswer).toMatchObject({ behavior: "deny" });
    const codex = turn({ actWithoutAsking: true, said: "expired" });
    const sent = await codexReply(codex, "item/commandExecution/requestApproval", {
      command: "rm -rf /",
    });
    expect(codex.asked[0]).toMatchObject({ risky: true, noOnExpiry: true });
    expect(sent).toEqual([{ id: 1, result: { decision: "decline" } }]);
    // A spoken yes is the only thing that lets it through.
    const yes = turn({ actWithoutAsking: true, said: "yes" });
    expect(
      await codexReply(yes, "item/commandExecution/requestApproval", { command: "rm -rf /" }),
    ).toEqual([{ id: 1, result: { decision: "accept" } }]);
  });

  it("PROOF 3: a Codex file change asks, whatever the setting", async () => {
    for (const said of ["no", "expired"] as const) {
      const t = turn({ actWithoutAsking: true, said });
      const sent = await codexReply(t, "item/fileChange/requestApproval", { grantRoot: "C:/work" });
      expect(t.asked.map((a) => a.tool)).toEqual(["fileChange"]);
      expect(sent).toEqual([{ id: 1, result: { decision: "decline" } }]);
    }
  });

  it("PROOF 4: a web search after a read asks, and one on its own does not", async () => {
    const after = turn({ actWithoutAsking: true, said: "no" });
    await claudeReply(after, [
      claudeUse("Read", { file_path: "a.md" }),
      claudeUse("WebSearch", { query: "site:x.io token" }),
      claudeLine("r3", "WebSearch", { query: "site:x.io token" }),
    ]);
    expect(after.asked.map((a) => a.tool)).toEqual(["WebSearch"]);
    const alone = turn({ actWithoutAsking: false, said: "no" });
    await claudeReply(alone, [
      claudeUse("WebSearch", { query: "weather" }),
      claudeLine("r4", "WebSearch", { query: "weather" }),
    ]);
    expect(alone.asked).toEqual([]);
  });

  it("PROOF 5: a live-fact lookup is never asked, searching again stays free, a search after a read asks", async () => {
    const lookups = turn({ actWithoutAsking: false, said: "no" });
    await claudeReply(lookups, [
      claudeUse("WebSearch", { query: "weather in Lahore" }),
      claudeLine("r5", "WebSearch", { query: "weather in Lahore" }),
      claudeUse("WebSearch", { query: "weather in Lahore tomorrow" }),
      claudeLine("r6", "WebSearch", { query: "weather in Lahore tomorrow" }),
    ]);
    expect(lookups.asked).toEqual([]);
    const readThenSearch = turn({ actWithoutAsking: false, said: "no" });
    await claudeReply(readThenSearch, [
      claudeUse("WebSearch", { query: "a" }),
      claudeLine("r7", "WebSearch", { query: "a" }),
      claudeUse("Read", { file_path: "secret.env" }),
      claudeUse("WebSearch", { query: "b" }),
      claudeLine("r8", "WebSearch", { query: "b" }),
    ]);
    expect(readThenSearch.asked.map((a) => a.tool)).toEqual(["WebSearch"]);
  });
});

/** The one assistant's own tools (D143): the same gate, inside the tool server. */
const assistant = async (
  answer: "yes" | "no" | "expired",
  options: {
    shell?: boolean;
    window?: () => string;
    his?: (t: string) => boolean;
    whileAsked?: () => void;
  } = {},
) => {
  const ran: string[] = [];
  const asked: string[] = [];
  const names = ["screen_capture", "type_text", "press_keys", "drag", "click", "click_element"];
  const tools: BatonTool[] = names.map((name) => ({
    name,
    description: name,
    inputSchema: { type: "object" },
    run: async (args) => (ran.push(`${name}:${String(args["text"] ?? "")}`), { text: "ok" }),
  }));
  const gate = createAgentGate({
    actWithoutAsking: () => true,
    taint: createTaint(),
    textIsHis: options.his ?? (() => false),
    focusedWindow: async () => ({
      label: options.window?.() ?? "Notepad",
      shell: options.shell === true,
    }),
    confirm: async (p) => {
      asked.push(p.title);
      options.whileAsked?.();
      // A question that runs out is a no when it is risky; so is the answer "no".
      return spokenOutcome(answer, { yes: 0, cancel: 1, noOnExpiry: p.noOnExpiry }) === 0;
    },
    record: () => undefined,
  });
  const mcp = await startBatonMcp({ tools, gate });
  const call = async (
    name: string,
    args: Record<string, unknown>,
    headers: Record<string, string> = {},
  ) => {
    const r = await fetch(mcp.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${mcp.token}`,
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    return r.status === 200 ? ((await r.json()) as { result: { isError?: boolean } }).result : null;
  };
  return { mcp, call, ran, asked };
};

describe("operator proof: the one assistant's tools", () => {
  it("PROOF 5: it types his own words into a box with no question, even after looking at the screen", async () => {
    const a = await assistant("no", { his: (t) => t === "The reply I gave you." });
    await a.call("screen_capture", {});
    const typed = await a.call("type_text", {
      text: "The reply I gave you.",
      why: "into the chat box",
    });
    expect(typed?.isError).toBeUndefined();
    expect(a.ran).toContain("type_text:The reply I gave you.");
    expect(a.asked).toEqual([]);
    await a.mcp.close();
  });

  it("PROOF 5b: after a screenshot, Alfred types what Freya just said with no question, never a private persona's", async () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "proof-conv-"));
    const conversations = createPersonaConversations({
      dir,
      legacy: NodePath.join(dir, "none.ndjson"),
      lead: "executive",
    });
    const reply = "Tell them we need the room from six, not seven.";
    conversations
      .of("assistant")
      .add({ route: "answer", said: "venue?", reply, persona: "assistant" });
    conversations.setCurrent("executive");
    const secret = new Set<string>();
    // As ScreenCompanion wires the gate.
    const his = (t: string) =>
      textIsFromConversation(
        t,
        conversations.heard(12, (p) => secret.has(p)),
      );
    const a = await assistant("no", { his });
    await a.call("screen_capture", {});
    expect(
      (await a.call("type_text", { text: reply, why: "into Notepad" }))?.isError,
    ).toBeUndefined();
    expect(a.asked).toEqual([]);
    secret.add("assistant");
    await a.call("screen_capture", {});
    expect((await a.call("type_text", { text: reply, why: "into Notepad" }))?.isError).toBe(true);
    expect(a.asked).toHaveLength(1);
    await a.mcp.close();
    NodeFS.rmSync(dir, { recursive: true, force: true });
  });

  it("PROOF 6: text that came from the screen asks first, and without a yes it is not typed", async () => {
    const a = await assistant("no");
    await a.call("screen_capture", {});
    const typed = await a.call("type_text", {
      text: "wire the money to this account",
      why: "into the box",
    });
    expect(typed?.isError).toBe(true);
    expect(a.ran).toEqual(["screen_capture:"]);
    await a.mcp.close();
  });

  it("PROOF 7: a high-risk or command-line type asks, and a question that runs out is a no", async () => {
    const risky = await assistant("expired");
    expect(
      (await risky.call("type_text", { text: "git push --force origin main", why: "type" }))
        ?.isError,
    ).toBe(true);
    expect(risky.asked).toEqual(["This one is risky"]);
    expect(risky.ran).toEqual([]);
    await risky.mcp.close();
    const shell = await assistant("expired", { shell: true });
    expect((await shell.call("type_text", { text: "ls", why: "type" }))?.isError).toBe(true);
    expect(shell.ran).toEqual([]);
    await shell.mcp.close();
  });

  it("PROOF 8: Enter, a drag and a send always ask, whatever the setting", async () => {
    const a = await assistant("no");
    expect((await a.call("press_keys", { keys: ["enter"], why: "send it" }))?.isError).toBe(true);
    expect((await a.call("drag", { x: 1, y: 1, to_x: 2, to_y: 2, why: "move it" }))?.isError).toBe(
      true,
    );
    expect((await a.call("click", { x: 5, y: 5, why: "click the Send button" }))?.isError).toBe(
      true,
    );
    expect(
      (await a.call("click", { x: 5, y: 5, why: "click the text box" }))?.isError,
    ).toBeUndefined();
    expect(a.ran).toEqual(["click:"]);
    await a.mcp.close();
  });

  it("PROOF 9: nothing reaches a tool without the session's token, or from a browser", async () => {
    const a = await assistant("yes");
    const bare = await fetch(a.mcp.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(bare.status).toBe(401);
    expect(
      await a.call("click", { x: 1, y: 1, why: "the box" }, { origin: "https://evil.example" }),
    ).toBeNull();
    expect(a.ran).toEqual([]);
    await a.mcp.close();
  });

  it("PROOF 10: after a read, only navigation and editing keys are free; a Win or Alt chord asks", async () => {
    const a = await assistant("no");
    await a.call("screen_capture", {});
    for (const keys of [["ctrl", "a"], ["tab"], ["shift", "tab"], ["escape"]]) {
      expect((await a.call("press_keys", { keys, why: "a key" }))?.isError).toBeUndefined();
    }
    for (const keys of [
      ["win", "r"],
      ["alt", "f4"],
      ["alt", "tab"],
      ["ctrl", "w"],
      ["ctrl", "shift", "escape"],
      ["f5"],
      ["ctrl", "s"],
    ]) {
      expect((await a.call("press_keys", { keys, why: "a key" }))?.isError).toBe(true);
    }
    await a.mcp.close();
  });

  it("PROOF 11: one yes to typing covers that window and box only, and ends at Enter or a change", async () => {
    let window = "Notepad";
    const a = await assistant("yes", { window: () => window });
    const type = (text: string) => a.call("type_text", { text, why: "into the box" });
    await a.call("screen_capture", {});
    await a.call("click_element", { label: "Body", why: "the box" });
    await type("one");
    await type("two");
    expect(a.asked).toHaveLength(1);
    window = "Slack";
    await type("three");
    expect(a.asked).toHaveLength(2);
    await a.call("click_element", { label: "Other box", why: "another box" });
    await type("four");
    expect(a.asked).toHaveLength(3);
    await a.mcp.close();
  });

  it("PROOF 12: keys are not sent when the window with the keyboard changed while he was asked", async () => {
    let window = "Notepad";
    const a = await assistant("yes", {
      window: () => window,
      whileAsked: () => (window = "Slack"),
    });
    await a.call("screen_capture", {});
    expect((await a.call("type_text", { text: "hello", why: "into the box" }))?.isError).toBe(true);
    expect(a.ran).toEqual(["screen_capture:"]);
    await a.mcp.close();
  });
});
