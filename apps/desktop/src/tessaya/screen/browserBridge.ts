// @effect-diagnostics globalFetch:off
/**
 * The shared Playwright browser bridge (its own operations doc, BROWSER-BRIDGE.md): one MCP endpoint on his laptop,
 * `localhost:8931/mcp`, that every agent uses to drive the "Agents" browser profile. The proxy files each MCP client
 * name under a tab group, so her work is `tessaya-<task>` and Sebastian's outreach is `sebastian-<task>`. Its tools
 * reach her model as `web_<name>` on her own tool server, so her gate judges every call (webPolicy.ts).
 */
import { BRIDGE_NATIVE_PREFIX } from "@t3tools/tessaya-shared/webPolicy";

import type { TessayaTool, ToolOutput } from "../agent/tessayaMcp.ts";

export const BRIDGE_URL = "http://localhost:8931/mcp";
const CHECK_CLIENT = "tessaya-check";
const CALL_MS = 60_000;
const CHECK_MS = 4_000;
/** The proxy answers these itself and never forwards them; the model is not offered them at all. */
const NEVER = new Set(["browser_close", "browser_install"]);

export type BridgeOwner = "tessaya" | "sebastian";

export interface BridgeCheck {
  readonly state: "ready" | "not-connected";
  /** One line a person can read aloud. */
  readonly message: string;
}

/** Whose line of work a turn is: Sebastian's outreach has its own group, everyone else works as Tessaya. */
export const bridgeOwner = (persona: {
  readonly id: string;
  readonly name: string;
}): BridgeOwner =>
  persona.id === "alter-ego" || /^sebastian$/i.test(persona.name.trim()) ? "sebastian" : "tessaya";

export const bridgeClientName = (owner: BridgeOwner, task: string): string => {
  const slug = task
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return `${owner}-${slug === "" ? "work" : slug}`;
};

type Fetch = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<Response>;

interface Rpc {
  readonly result?: Record<string, unknown>;
  readonly error?: { readonly message?: string };
}

/** The bridge answers as JSON or as one SSE `data:` line, like @playwright/mcp. */
const readRpc = async (res: Response): Promise<Rpc | null> => {
  if (res.status === 202) return null;
  const text = await res.text();
  if (!res.ok) throw new Error(`The browser bridge answered ${res.status}.`);
  const line = text.split("\n").find((l) => l.startsWith("data:"));
  return JSON.parse(line === undefined ? text : line.slice(5)) as Rpc;
};

export const createBridge = (input: { readonly url?: string; readonly fetch?: Fetch } = {}) => {
  const url = input.url ?? BRIDGE_URL;
  const fetch: Fetch = input.fetch ?? ((u, init) => globalThis.fetch(u, init));
  const sessions = new Map<string, Promise<string | null>>();
  let id = 0;

  const post = async (
    body: Record<string, unknown>,
    session: string | null,
    ms: number,
  ): Promise<{ readonly rpc: Rpc | null; readonly session: string | null }> => {
    const signal = AbortSignal.timeout(ms);
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(session === null ? {} : { "mcp-session-id": session }),
      },
      body: JSON.stringify({ jsonrpc: "2.0", ...body }),
      signal,
    });
    return { rpc: await readRpc(res), session: res.headers.get("mcp-session-id") };
  };

  /** One MCP session per client name, opened on first use and kept; a failed open is forgotten. */
  const sessionFor = (name: string, ms: number): Promise<string | null> => {
    const open = sessions.get(name);
    if (open !== undefined) return open;
    const opening = (async () => {
      const init = await post(
        {
          id: (id += 1),
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name, version: "1" },
          },
        },
        null,
        ms,
      );
      await post({ method: "notifications/initialized" }, init.session, ms);
      return init.session;
    })();
    sessions.set(name, opening);
    opening.catch(() => sessions.delete(name));
    return opening;
  };

  const request = async (
    name: string,
    method: string,
    params: Record<string, unknown>,
    ms = CALL_MS,
  ): Promise<Record<string, unknown>> => {
    const session = await sessionFor(name, ms);
    // A restarted proxy forgets sessions: the next call opens a fresh one.
    const { rpc } = await post({ id: (id += 1), method, params }, session, ms).catch(
      (e: unknown) => {
        sessions.delete(name);
        throw e;
      },
    );
    if (rpc?.error !== undefined)
      throw new Error(rpc.error.message ?? "The browser bridge refused that.");
    return rpc?.result ?? {};
  };

  return {
    check: async (): Promise<BridgeCheck> => {
      try {
        await sessionFor(CHECK_CLIENT, CHECK_MS);
        return { state: "ready", message: "The shared browser bridge answers." };
      } catch {
        sessions.delete(CHECK_CLIENT);
        return {
          state: "not-connected",
          message:
            "The shared browser bridge (localhost:8931) is not answering on this computer. Start the bridge, then check again.",
        };
      }
    },
    list: async (): Promise<ReadonlyArray<Record<string, unknown>>> => {
      const result = await request(CHECK_CLIENT, "tools/list", {}, CHECK_MS);
      return Array.isArray(result["tools"])
        ? (result["tools"] as Array<Record<string, unknown>>)
        : [];
    },
    call: async (name: string, tool: string, args: Readonly<Record<string, unknown>>) =>
      request(name, "tools/call", { name: tool, arguments: args }),
  };
};

export type Bridge = ReturnType<typeof createBridge>;

const outputOf = (result: Record<string, unknown>): ToolOutput => {
  const content = Array.isArray(result["content"])
    ? (result["content"] as Array<Record<string, unknown>>)
    : [];
  const text = content
    .filter((c) => c["type"] === "text" && typeof c["text"] === "string")
    .map((c) => c["text"] as string)
    .join("\n");
  const images = content.flatMap((c) =>
    c["type"] === "image" && typeof c["data"] === "string" && typeof c["mimeType"] === "string"
      ? [{ data: c["data"], mimeType: c["mimeType"] }]
      : [],
  );
  if (result["isError"] === true)
    throw new Error(text === "" ? "The browser bridge refused that." : text);
  return { text, ...(images.length === 0 ? {} : { images }) };
};

/**
 * The bridge's tools as hers, `browser_click` as `web_click`, each call made under `client()` (read per call, so the
 * owner follows the persona answering). None when the bridge does not answer.
 */
export const webTools = async (
  bridge: Bridge,
  client: () => string,
): Promise<ReadonlyArray<TessayaTool>> => {
  const listed = await bridge.list().catch(() => []);
  return listed.flatMap((t): ReadonlyArray<TessayaTool> => {
    const name = t["name"];
    if (typeof name !== "string" || !name.startsWith(BRIDGE_NATIVE_PREFIX) || NEVER.has(name))
      return [];
    const schema = t["inputSchema"];
    return [
      {
        name: `web_${name.slice(BRIDGE_NATIVE_PREFIX.length)}`,
        description: `${typeof t["description"] === "string" ? t["description"] : name} (the shared browser bridge, in your own tab)`,
        inputSchema:
          typeof schema === "object" && schema !== null
            ? (schema as Record<string, unknown>)
            : { type: "object" },
        run: async (args) => outputOf(await bridge.call(client(), name, args)),
      },
    ];
  });
};
