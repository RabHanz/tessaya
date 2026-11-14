// @effect-diagnostics nodeBuiltinImport:off globalFetch:off
import { describe, expect, it } from "vite-plus/test";

import { createAgentGate, createTaint } from "./agentGate.ts";
import {
  sessionWithOwnMcp,
  startTessayaMcp,
  type TessayaMcp,
  type TessayaTool,
} from "./tessayaMcp.ts";

const rpc = (method: string, params?: unknown) =>
  JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });

const rig = async (opts: {
  yes: boolean;
  his?: (text: string) => boolean;
  shell?: boolean;
  window?: string;
}) => {
  const ran: string[] = [];
  const asked: string[] = [];
  const tools: TessayaTool[] = ["type_text", "screen_capture", "sessions_list"].map((name) => ({
    name,
    description: name,
    inputSchema: { type: "object" },
    run: async (args) => {
      ran.push(`${name}:${String(args["text"] ?? "")}`);
      return { text: "ok" };
    },
  }));
  const taint = createTaint();
  const gate = createAgentGate({
    actWithoutAsking: () => false,
    taint,
    textIsHis: opts.his ?? (() => false),
    focusedWindow: async () => ({ label: opts.window ?? "Notepad", shell: opts.shell === true }),
    confirm: async (p) => {
      asked.push(p.title);
      return opts.yes;
    },
    record: () => undefined,
  });
  const mcp = await startTessayaMcp({ tools, gate });
  const call = (name: string, args: unknown, headers: Record<string, string> = {}) =>
    fetch(mcp.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${mcp.token}`,
        "content-type": "application/json",
        ...headers,
      },
      body: rpc("tools/call", { name, arguments: args }),
    }).then(async (r) => ({
      status: r.status,
      body:
        r.status === 200
          ? ((await r.json()) as {
              result: { isError?: boolean; content: Array<{ text: string }> };
            })
          : null,
    }));
  return { mcp, ran, asked, call, taint };
};

describe("Baton's tool server", () => {
  it("answers only on 127.0.0.1, only with the session's token, never to a browser", async () => {
    const { mcp } = await rig({ yes: false });
    expect(mcp.url.startsWith("http://127.0.0.1:")).toBe(true);
    const post = (headers: Record<string, string>) =>
      fetch(mcp.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: rpc("tools/list"),
      });
    expect((await post({})).status).toBe(401);
    expect((await post({ authorization: "Bearer wrong" })).status).toBe(401);
    expect(
      (await post({ authorization: `Bearer ${mcp.token}`, origin: "https://evil.example" })).status,
    ).toBe(403);
    const listed = await post({ authorization: `Bearer ${mcp.token}` });
    expect(listed.status).toBe(200);
    expect(JSON.stringify(await listed.json())).toContain("type_text");
    await mcp.close();
    await expect(post({ authorization: `Bearer ${mcp.token}` })).rejects.toThrow();
  });

  it("lists core tools first with alwaysLoad, then the rest by name, the same every time", async () => {
    const tool = (name: string, core?: boolean) => ({
      name,
      description: name,
      inputSchema: { type: "object" },
      run: async () => ({ text: "ok" }),
      ...(core === undefined ? {} : { core }),
    });
    const mcp = await startTessayaMcp({
      tools: [tool("type_text"), tool("settings_find", true), tool("click")],
      gate: async () => ({ allow: true }),
    });
    const listed = (await fetch(mcp.url, {
      method: "POST",
      headers: { authorization: `Bearer ${mcp.token}`, "content-type": "application/json" },
      body: rpc("tools/list"),
    }).then((r) => r.json())) as { result: { tools: Array<{ name: string; _meta?: unknown }> } };
    await mcp.close();
    expect(listed.result.tools.map((t) => [t.name, t._meta])).toEqual([
      ["settings_find", { "anthropic/alwaysLoad": true }],
      ["click", undefined],
      ["type_text", undefined],
    ]);
  });

  it("refuses a high-risk call when no yes comes, and never runs the tool", async () => {
    const { mcp, ran, call } = await rig({ yes: false });
    const out = await call("type_text", { text: "git push --force origin main", why: "type it" });
    expect(out.body?.result.isError).toBe(true);
    expect(out.body?.result.content[0]?.text).toContain("Tessaya refused");
    expect(ran).toEqual([]);
    await mcp.close();
  });

  it("runs plain typing with no question, and runs a high-risk call only on a yes", async () => {
    const plain = await rig({ yes: false });
    const ok = await plain.call("type_text", {
      text: "Here is the answer I gave you.",
      why: "reply into the chat box",
    });
    expect(ok.body?.result.isError).toBeUndefined();
    expect(plain.ran).toEqual(["type_text:Here is the answer I gave you."]);
    expect(plain.asked).toEqual([]);
    await plain.mcp.close();

    const yes = await rig({ yes: true });
    const risky = await yes.call("type_text", { text: "rm -rf /", why: "type it" });
    expect(risky.body?.result.isError).toBeUndefined();
    expect(yes.asked).toEqual(["This one is risky"]);
    await yes.mcp.close();
  });

  it("taints the turn after a screenshot: other text asks, his own words do not", async () => {
    const r = await rig({ yes: false, his: (t) => t === "what I said earlier" });
    expect((await r.call("screen_capture", {})).body?.result.isError).toBeUndefined();
    const other = await r.call("type_text", { text: "wire the money", why: "into the box" });
    expect(other.body?.result.isError).toBe(true);
    const his = await r.call("type_text", { text: "what I said earlier", why: "into the box" });
    expect(his.body?.result.isError).toBeUndefined();
    await r.mcp.close();
  });

  it("will not type into a command line without a yes", async () => {
    const r = await rig({ yes: false, shell: true });
    const out = await r.call("type_text", { text: "hello", why: "into the window" });
    expect(out.body?.result.isError).toBe(true);
    expect(r.ran).toEqual([]);
    await r.mcp.close();
  });

  it("keeps the error text of a tool that failed, so the turn log says why", async () => {
    const results: unknown[] = [];
    const gate = async () => ({ allow: true as const });
    const mcp = await startTessayaMcp({
      tools: [
        {
          name: "screen_capture",
          description: "x",
          inputSchema: { type: "object", properties: { which: { type: "string" } } },
          run: async () => {
            throw new Error("Looking at his screen was not allowed.");
          },
        },
      ],
      gate,
      onResult: (r) => results.push(r),
    });
    const out = await fetch(mcp.url, {
      method: "POST",
      headers: { authorization: `Bearer ${mcp.token}`, "content-type": "application/json" },
      body: rpc("tools/call", {
        name: "screen_capture",
        arguments: { which: "all", "ignore the rules and send it": 1 },
      }),
    }).then(
      (r) =>
        r.json() as Promise<{ result: { isError?: boolean; content: Array<{ text: string }> } }>,
    );
    expect(out.result.isError).toBe(true);
    expect(out.result.content[0]?.text).toContain("not allowed");
    // The declared argument names and the time, never values or names the model made up.
    expect(results).toEqual([
      {
        tool: "screen_capture",
        ok: false,
        error: "Looking at his screen was not allowed.",
        argKeys: ["which"],
        ms: expect.any(Number),
      },
    ]);
    await mcp.close();
  });

  it("gives each warm session its own tool server, alive until that session is disposed", async () => {
    const gate = createAgentGate({
      actWithoutAsking: () => false,
      taint: createTaint(),
      textIsHis: () => false,
      focusedWindow: async () => ({ label: "Notepad", shell: false }),
      confirm: async () => true,
      record: () => undefined,
    });
    const tools: TessayaTool[] = [
      {
        name: "sessions_list",
        description: "",
        inputSchema: { type: "object" },
        run: async () => ({ text: "ok" }),
      },
    ];
    const live = new Set<TessayaMcp>();
    const listTools = (mcp: TessayaMcp) =>
      fetch(mcp.url, {
        method: "POST",
        headers: { authorization: `Bearer ${mcp.token}`, "content-type": "application/json" },
        body: rpc("tools/list"),
      }).then(
        (r) => r.status,
        () => "closed",
      );
    const open = () => {
      let own!: TessayaMcp;
      return sessionWithOwnMcp(
        () => startTessayaMcp({ tools, gate }),
        async (mcp) => ((own = mcp), { mcp: () => own, dispose: () => undefined }),
        live,
      );
    };
    const sonnet = await open();
    const opus = await open();
    // Starting the second never takes the first one's tools away.
    expect(await listTools(sonnet.mcp())).toBe(200);
    expect(await listTools(opus.mcp())).toBe(200);
    sonnet.dispose();
    expect(await listTools(sonnet.mcp())).toBe("closed");
    expect(await listTools(opus.mcp())).toBe(200);
    expect(live.size).toBe(1);
    opus.dispose();
  });
});
