/**
 * The remote hands API (docs/baton/REMOTE_HANDS.md) as a plain function, so the scope rules are testable without a server:
 * a session needs `baton:hands` (issued by the Director to that one session) to ask; only the desktop app's own session,
 * with `baton:hands-host`, takes and answers; asking never reaches a tool the allowlist does not name.
 */
import { AuthTessayaHandsHostScope, AuthTessayaHandsScope } from "@t3tools/contracts";
import {
  publishedSpecs,
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
}
export interface HandsResponse {
  readonly status: number;
  readonly json: Record<string, unknown>;
}

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
  if (req.method !== "POST") return say(404, "No such page.");
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
      return say(400, "Send {tool, args}.");
    }
    const result = await broker.call(req.session, tool, args as Record<string, unknown>);
    return { status: 200, json: { ...result } };
  }
  if (req.path === "take" || req.path === "reply") {
    if (!req.scopes.has(HANDS_HOST_SCOPE))
      return say(403, "Only the desktop app takes remote hands calls.");
    if (req.path === "take") {
      // The desktop's own tools for a brain turn, sent when they change; absent keeps what it offered.
      const tools = body["tools"] === undefined ? undefined : publishedSpecs(body["tools"]);
      if (tools === null)
        return say(400, "tools must be a list of {name, description, input_schema}.");
      const call = await broker.take(waitMs, tools);
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
