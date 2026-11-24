import { describe, expect, it } from "vite-plus/test";

import { bridgeClientName, bridgeOwner, createBridge, webTools } from "./browserBridge.ts";

/** A pw-proxy stand-in: it records each request's client name and session, and answers like @playwright/mcp. */
const fakeProxy = (opts: { readonly down?: boolean } = {}) => {
  const seen: Array<{ method: string; client: string | null; session: string | null }> = [];
  const sessions = new Map<string, string>();
  let n = 0;
  const fetch = async (_url: string, init: { headers: Record<string, string>; body: string }) => {
    if (opts.down === true) throw new Error("ECONNREFUSED");
    const rpc = JSON.parse(init.body) as {
      id?: number;
      method: string;
      params?: Record<string, unknown>;
    };
    const session = init.headers["mcp-session-id"] ?? null;
    if (rpc.method === "initialize") {
      const name = String((rpc.params?.["clientInfo"] as { name?: string } | undefined)?.name);
      const id = `s${(n += 1)}`;
      sessions.set(id, name);
      seen.push({ method: rpc.method, client: name, session: id });
      return new Response(
        `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: {} })}\n\n`,
        { headers: { "mcp-session-id": id, "content-type": "text/event-stream" } },
      );
    }
    seen.push({ method: rpc.method, client: session && (sessions.get(session) ?? null), session });
    if (rpc.id === undefined) return new Response(null, { status: 202 });
    const result =
      rpc.method === "tools/list"
        ? {
            tools: [
              { name: "browser_navigate", description: "Go", inputSchema: { type: "object" } },
              { name: "browser_snapshot", description: "Look", inputSchema: { type: "object" } },
              { name: "browser_close", description: "Close", inputSchema: { type: "object" } },
            ],
          }
        : {
            content: [
              { type: "text", text: `ran ${String(rpc.params?.["name"])}` },
              { type: "image", data: "AAAA", mimeType: "image/png" },
            ],
          };
    return Response.json({ jsonrpc: "2.0", id: rpc.id, result });
  };
  return { fetch, seen };
};

describe("the shared browser bridge", () => {
  it("names each line of work for its own tab group: tessaya-<task>, or sebastian-<task> for his outreach", () => {
    expect(bridgeClientName("tessaya", "Desk turn!")).toBe("tessaya-desk-turn");
    expect(bridgeClientName("sebastian", "Upwork outreach")).toBe("sebastian-upwork-outreach");
    expect(bridgeClientName("tessaya", "   ")).toBe("tessaya-work");
    expect(bridgeOwner({ id: "alter-ego", name: "Sebastian" })).toBe("sebastian");
    expect(bridgeOwner({ id: "butler", name: "Alfred" })).toBe("tessaya");
  });

  it("serves the bridge's tools as web_<name>, never browser_close, each call under the owner's client name", async () => {
    const proxy = fakeProxy();
    let owner: "tessaya" | "sebastian" = "tessaya";
    const bridge = createBridge({ fetch: proxy.fetch });
    const tools = await webTools(bridge, () => bridgeClientName(owner, "desk"));
    expect(tools.map((t) => t.name)).toEqual(["web_navigate", "web_snapshot"]);
    const out = await tools[1]!.run({});
    expect(out).toEqual({
      text: "ran browser_snapshot",
      images: [{ data: "AAAA", mimeType: "image/png" }],
    });
    owner = "sebastian";
    await tools[0]!.run({ url: "https://www.upwork.com/" });
    const calls = proxy.seen.filter((s) => s.method === "tools/call");
    expect(calls.map((c) => c.client)).toEqual(["tessaya-desk", "sebastian-desk"]);
    // One MCP session per client name, reused.
    await tools[1]!.run({});
    expect(proxy.seen.filter((s) => s.method === "initialize").map((s) => s.client)).toEqual([
      "tessaya-check",
      "tessaya-desk",
      "sebastian-desk",
    ]);
  });

  it("says in one line when the bridge is not answering, and offers no web tools", async () => {
    const bridge = createBridge({ fetch: fakeProxy({ down: true }).fetch });
    expect((await bridge.check()).state).toBe("not-connected");
    expect(await webTools(bridge, () => "tessaya-desk")).toEqual([]);
  });
});
