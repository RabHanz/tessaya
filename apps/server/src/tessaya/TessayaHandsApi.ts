/**
 * The remote hands API (docs/baton/REMOTE_HANDS.md) as a plain function, so the scope rules are testable without a server:
 * a session needs `baton:hands` (issued by the Director to that one session) to ask; only the desktop app's own session,
 * with `baton:hands-host`, takes and answers; asking never reaches a tool the allowlist does not name.
 */
import { AuthTessayaHandsHostScope, AuthTessayaHandsScope } from "@t3tools/contracts";
import {
  publishedSpecs,
  validCaller,
  type HandsBroker,
  type HandsAudit,
  type HandsResult,
} from "@t3tools/tessaya-shared/remoteHands";

export const HANDS_SCOPE = AuthTessayaHandsScope;
export const HANDS_HOST_SCOPE = AuthTessayaHandsHostScope;
const TAKE_WAIT_MS = 25_000;

export interface HandsRequest {
  readonly method: string;
  /** The path after `/tessaya/hands/`. */
  readonly path: string;
  readonly scopes: ReadonlySet<string>;
  /** Who is asking, for the audit log. */
  readonly session: string;
  readonly json?: unknown;
  /** An MCP client's `mcp-session-id`: the caller name its initialize gave. */
  readonly mcpSession?: string;
}
export interface HandsResponse {
  readonly status: number;
  readonly json: Record<string, unknown>;
  readonly headers?: Readonly<Record<string, string>>;
}

const CALLER_HELP =
  "Name yourself: caller (over MCP, clientInfo.name) is <agent>-<task> in lower case, like ventureos-desk.";

/** The hands over MCP (streamable HTTP, JSON answers): the caller is the client name, kept as the session id. */
const handsMcp = async (broker: HandsBroker, req: HandsRequest): Promise<HandsResponse> => {
  const rpc = (req.json ?? {}) as {
    id?: unknown;
    method?: unknown;
    params?: Record<string, unknown>;
  };
  const answer = (result: Record<string, unknown>, headers?: Record<string, string>) => ({
    status: 200,
    json: { jsonrpc: "2.0", id: rpc.id ?? null, result },
    ...(headers === undefined ? {} : { headers }),
  });
  const fail = (code: number, message: string) => ({
    status: 200,
    json: { jsonrpc: "2.0", id: rpc.id ?? null, error: { code, message } },
  });
  if (rpc.id === undefined) return { status: 202, json: {} };
  if (rpc.method === "initialize") {
    const caller = validCaller(
      (rpc.params?.["clientInfo"] as { name?: unknown } | undefined)?.name,
    );
    if (caller === null) return fail(-32602, CALLER_HELP);
    const version = rpc.params?.["protocolVersion"];
    return answer(
      {
        protocolVersion: typeof version === "string" ? version : "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "tessaya-hands", version: "1" },
      },
      { "mcp-session-id": caller },
    );
  }
  if (rpc.method === "ping") return answer({});
  if (rpc.method === "tools/list") {
    return answer({
      tools: broker.remoteTools().map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.input_schema,
      })),
    });
  }
  if (rpc.method === "tools/call") {
    const caller = validCaller(req.mcpSession);
    if (caller === null) return fail(-32600, `Initialize first. ${CALLER_HELP}`);
    const name = rpc.params?.["name"];
    const args = rpc.params?.["arguments"] ?? {};
    if (
      typeof name !== "string" ||
      typeof args !== "object" ||
      args === null ||
      Array.isArray(args)
    )
      return fail(-32602, "Send {name, arguments}.");
    const result = await broker.call(
      req.session,
      name,
      args as Record<string, unknown>,
      undefined,
      caller,
    );
    return answer({
      content: [
        {
          type: "text",
          text: result.ok ? (result.text ?? "Done.") : (result.error ?? "It did not work."),
        },
        ...(result.images ?? []).map((i) => ({
          type: "image",
          data: i.data,
          mimeType: i.mimeType,
        })),
      ],
      ...(result.ok ? {} : { isError: true }),
    });
  }
  return fail(-32601, `No method ${String(rpc.method)}.`);
};

const say = (status: number, message: string): HandsResponse => ({ status, json: { message } });

export const handleHands = async (
  broker: HandsBroker,
  req: HandsRequest,
  waitMs = TAKE_WAIT_MS,
): Promise<HandsResponse> => {
  const body = (req.json ?? {}) as Record<string, unknown>;
  if (req.method === "GET" && req.path === "audit") {
    if (!req.scopes.has(HANDS_SCOPE) && !req.scopes.has(HANDS_HOST_SCOPE)) {
      return say(403, "This session was not given remote hands.");
    }
    return { status: 200, json: { entries: broker.audit() satisfies ReadonlyArray<HandsAudit> } };
  }
  // No server-sent stream: an MCP client's GET is told so, and it carries on over POST.
  if (req.method === "GET" && req.path === "mcp") return say(405, "POST only.");
  if (req.method !== "POST") return say(404, "No such page.");
  if (req.path === "mcp") {
    if (!req.scopes.has(HANDS_SCOPE)) return say(403, "This session was not given remote hands.");
    return handsMcp(broker, req);
  }
  if (req.path === "call") {
    if (!req.scopes.has(HANDS_SCOPE)) {
      return say(
        403,
        "This session was not given remote hands. The Director issues baton:hands to one session on his own computer.",
      );
    }
    const tool = body["tool"];
    const args = body["args"] ?? {};
    if (
      typeof tool !== "string" ||
      typeof args !== "object" ||
      args === null ||
      Array.isArray(args)
    ) {
      return say(400, "Send {tool, args, caller}.");
    }
    const caller = validCaller(body["caller"]);
    if (caller === null) return say(400, CALLER_HELP);
    const result = await broker.call(
      req.session,
      tool,
      args as Record<string, unknown>,
      undefined,
      caller,
    );
    return { status: 200, json: { ...result } };
  }
  if (req.path === "take" || req.path === "reply") {
    if (!req.scopes.has(HANDS_HOST_SCOPE))
      return say(403, "Only the desktop app takes remote hands calls.");
    if (req.path === "take") {
      // The desktop's own tools for a brain turn, sent when they change; absent keeps what it offered.
      const tools = body["tools"] === undefined ? undefined : publishedSpecs(body["tools"]);
      const remote =
        body["remoteTools"] === undefined ? undefined : publishedSpecs(body["remoteTools"]);
      if (tools === null || remote === null)
        return say(400, "tools must be a list of {name, description, input_schema}.");
      const call = await broker.take(waitMs, tools, remote);
      return { status: 200, json: { call } };
    }
    const id = body["id"];
    const result = body["result"] as HandsResult | undefined;
    if (typeof id !== "string" || typeof result?.ok !== "boolean")
      return say(400, "Send {id, result}.");
    return broker.reply(id, result)
      ? { status: 200, json: { ok: true } }
      : say(404, "No such call.");
  }
  return say(404, "No such page.");
};
