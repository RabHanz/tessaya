import { createHandsBroker } from "@t3tools/tessaya-shared/remoteHands";
import { describe, expect, it } from "vite-plus/test";

import { handleHands, HANDS_HOST_SCOPE, HANDS_SCOPE } from "./TessayaHandsApi.ts";

const broker = () => {
  let n = 0;
  return createHandsBroker({ now: () => 0, newId: () => `c${(n += 1)}`, callTimeoutMs: 2_000 });
};
const asker = {
  method: "POST",
  path: "call",
  scopes: new Set([HANDS_SCOPE]),
  session: "remote-1",
} as const;
const host = { scopes: new Set([HANDS_HOST_SCOPE]), session: "desktop" } as const;

describe("remote hands API", () => {
  it("does nothing for a session without baton:hands, whatever else it holds", async () => {
    const b = broker();
    const r = await handleHands(b, {
      ...asker,
      scopes: new Set(["orchestration:operate", "orchestration:read"]),
      json: { tool: "ui_tree" },
    });
    expect(r.status).toBe(403);
    expect(b.audit()).toEqual([]);
  });

  it("lets only the desktop's session take and answer a call", async () => {
    const b = broker();
    expect((await handleHands(b, { ...asker, path: "take" }, 1)).status).toBe(403);
    // What the desktop offers a brain turn comes only with its own take, and only well-formed.
    expect(
      (await handleHands(b, { method: "POST", path: "take", ...host, json: { tools: "all" } }, 1))
        .status,
    ).toBe(400);
    expect(b.published()).toEqual([]);
    expect(
      (await handleHands(b, { ...asker, path: "reply", json: { id: "c1", result: { ok: true } } }))
        .status,
    ).toBe(403);
    const taking = handleHands(b, { method: "POST", path: "take", ...host }, 500);
    const asking = handleHands(b, {
      ...asker,
      json: { tool: "ui_tree", args: {}, caller: "ventureos-desk" },
    });
    const call = (await taking).json["call"] as { id: string; session: string; caller: string };
    expect(call.session).toBe("remote-1");
    expect(call.caller).toBe("ventureos-desk");
    expect(
      (
        await handleHands(b, {
          method: "POST",
          path: "reply",
          ...host,
          json: { id: call.id, result: { ok: true, text: "Notepad" } },
        })
      ).status,
    ).toBe(200);
    expect((await asking).json).toMatchObject({ ok: true, text: "Notepad" });
  });

  it("refuses a raw-coordinate tool and shows the audit to a holder only", async () => {
    const b = broker();
    await handleHands(b, { method: "POST", path: "take", ...host }, 1);
    const r = await handleHands(b, {
      ...asker,
      json: { tool: "click", args: { x: 1, y: 2 }, caller: "ventureos-desk" },
    });
    expect(r.json["error"]).toContain("not a remote hands tool");
    const audit = await handleHands(b, {
      method: "GET",
      path: "audit",
      scopes: new Set(["orchestration:read"]),
      session: "x",
    });
    expect(audit.status).toBe(403);
    expect(
      (await handleHands(b, { method: "GET", path: "audit", ...host })).json["entries"],
    ).toHaveLength(1);
  });

  it("refuses a call that does not say who is calling, and records the caller of one that does", async () => {
    const b = broker();
    await handleHands(b, { method: "POST", path: "take", ...host }, 1);
    for (const caller of [undefined, "", "Venture OS", "x".repeat(80)]) {
      const r = await handleHands(b, { ...asker, json: { tool: "ui_tree", args: {}, caller } });
      expect(r.status, String(caller)).toBe(400);
    }
    expect(b.audit()).toEqual([]);
    await handleHands(b, { ...asker, json: { tool: "click", args: {}, caller: "ventureos-desk" } });
    expect(b.audit()[0]).toMatchObject({ caller: "ventureos-desk", outcome: "refused" });
  });

  it("speaks MCP on the same door: the caller is its client name, tools are what the desktop offers remote callers", async () => {
    const b = broker();
    const mcp = (json: unknown, session?: string) =>
      handleHands(b, {
        ...asker,
        path: "mcp",
        json,
        ...(session === undefined ? {} : { mcpSession: session }),
      });
    expect(
      (
        await handleHands(b, {
          ...asker,
          path: "mcp",
          scopes: new Set(["orchestration:read"]),
          json: { jsonrpc: "2.0", id: 1, method: "tools/list" },
        })
      ).status,
    ).toBe(403);
    const bad = await mcp({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "Claude Code" } },
    });
    expect(bad.json["error"]).toBeDefined();
    const init = await mcp({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", clientInfo: { name: "ventureos-desk" } },
    });
    expect(init.headers?.["mcp-session-id"]).toBe("ventureos-desk");
    expect(init.json["result"]).toMatchObject({ capabilities: { tools: {} } });
    expect(
      (await mcp({ jsonrpc: "2.0", method: "notifications/initialized" }, "ventureos-desk")).status,
    ).toBe(202);
    // A call with no session names no caller.
    expect(
      (await mcp({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ui_tree" } }))
        .json["error"],
    ).toBeDefined();
    const spec = { name: "ui_tree", description: "Controls", input_schema: { type: "object" } };
    const taking = handleHands(
      b,
      { method: "POST", path: "take", ...host, json: { remoteTools: [spec] } },
      500,
    );
    const listed = await mcp({ jsonrpc: "2.0", id: 3, method: "tools/list" }, "ventureos-desk");
    expect(listed.json["result"]).toEqual({
      tools: [{ name: "ui_tree", description: "Controls", inputSchema: { type: "object" } }],
    });
    const calling = mcp(
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "ui_tree", arguments: {} } },
      "ventureos-desk",
    );
    const call = (await taking).json["call"] as { id: string; caller: string };
    expect(call.caller).toBe("ventureos-desk");
    await handleHands(b, {
      method: "POST",
      path: "reply",
      ...host,
      json: { id: call.id, result: { ok: false, error: "Refused: private window" } },
    });
    expect((await calling).json["result"]).toEqual({
      content: [{ type: "text", text: "Refused: private window" }],
      isError: true,
    });
  });
});
