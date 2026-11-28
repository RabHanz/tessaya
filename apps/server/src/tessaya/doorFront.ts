// The household's one front door, on the raw Node server before Effect sees a request (TessayaDoor fills it in).
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import type * as NodeStream from "node:stream";

/**
 * Exactly what the door lets through, the same list as the proxy in front of it (tessaya-door.yml): sign-in, the
 * client's own API, Tessels and The Margin. Access management, MCP, peer links and every `/tessaya/*` route stay
 * tailnet-only.
 */
const DOOR_EXACT: ReadonlySet<string> = new Set([
  "/",
  "/oauth/token",
  "/ws",
  "/api/environment",
  "/api/projects",
  "/api/projects/mutate",
  "/api/pull-requests/diff",
  "/api/tessel/phone",
  "/api/tessel/mqtt",
  "/api/r1/mqtt",
  "/camera/upload",
  "/api/tessaya/announce",
]);
const DOOR_PREFIXES = [
  "/assets/",
  "/.well-known/t3/",
  "/api/auth/",
  "/api/orchestration/",
  "/api/voice/",
  "/api/assets/",
  "/api/attachments/upload/",
  "/api/tessel/firmware/",
  "/api/r1/firmware/",
  "/api/devices/",
] as const;
const DOOR_DENIED = /^\/api\/auth\/(pairing-token|pairing-links|clients|connect-devices)(\/|$)/;

/** The request target the door forwards unchanged, or null: off the list, or spelled so a server could read it otherwise. */
export const doorPath = (raw: string | undefined): string | null => {
  if (raw === undefined || !raw.startsWith("/") || raw.startsWith("//")) return null;
  const path = raw.split(/[?#]/, 1)[0]!;
  if (/%2e|%2f|%5c|\\/i.test(path)) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw, "http://door.invalid");
  } catch {
    return null;
  }
  if (parsed.pathname !== path || DOOR_DENIED.test(path)) return null;
  return DOOR_EXACT.has(path) || DOOR_PREFIXES.some((prefix) => path.startsWith(prefix))
    ? raw
    : null;
};

/** The host a request names, lowercased, without its port. */
export const hostOf = (header: string | undefined): string =>
  (header ?? "").trim().toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const CALLER_HEADERS = /^(cf-connecting-ip|x-real-ip|x-forwarded-for|x-tessaya-door|tailscale-)/;

/**
 * The headers sent on: the caller's own, minus hop-by-hop and every header that would say who called, then the
 * caller as the proxy in front named it and the door's mark, so the machine behind treats it as the internet.
 */
export const forwardHeaders = (
  headers: NodeHttp.IncomingHttpHeaders,
  caller: string,
  upgrade: boolean,
): NodeHttp.OutgoingHttpHeaders => {
  const out: NodeHttp.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP.has(name) || CALLER_HEADERS.test(name)) continue;
    out[name] = value;
  }
  out["x-real-ip"] = caller;
  out["x-forwarded-for"] = caller;
  out["x-forwarded-proto"] = "https";
  out["x-tessaya-door"] = "1";
  if (upgrade) {
    out["connection"] = "Upgrade";
    out["upgrade"] = headers["upgrade"] ?? "websocket";
  }
  return out;
};

export type DoorTarget =
  /** Not this door's: the server handles it as usual. */
  | { readonly _tag: "pass" }
  /** A name under the door that is not a paired machine, or a path off the list. */
  | { readonly _tag: "none" }
  | { readonly _tag: "machine"; readonly environmentId: string };

export interface DoorHandler {
  readonly target: (host: string) => DoorTarget;
  /** Where the machine answers as itself now, or null when it does not (asleep, unlinked). */
  readonly resolve: (environmentId: string) => Promise<string | null>;
}

let handler: DoorHandler | null = null;

/** TessayaDoor sets this while its layer is up; null turns the door off. */
export const setDoorHandler = (next: DoorHandler | null) => {
  handler = next;
};

/** The door in use, for tests. */
export const currentDoorHandler = () => handler;

const CONNECT_TIMEOUT_MS = 5_000;
const BARE_404 = "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
const BARE_502 = "HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";

const callerOf = (request: NodeHttp.IncomingMessage) => {
  const named = request.headers["x-real-ip"];
  return (typeof named === "string" && named.trim()) || request.socket.remoteAddress || "internet";
};

const outgoing = (
  base: string,
  request: NodeHttp.IncomingMessage,
  path: string,
  upgrade: boolean,
) => {
  const url = new URL(path, base);
  const options: NodeHttp.RequestOptions = {
    method: request.method,
    headers: forwardHeaders(request.headers, callerOf(request), upgrade),
    timeout: CONNECT_TIMEOUT_MS,
  };
  return url.protocol === "https:"
    ? NodeHttps.request(url, options)
    : NodeHttp.request(url, options);
};

const serveRequest = async (
  door: DoorHandler,
  environmentId: string,
  path: string,
  request: NodeHttp.IncomingMessage,
  response: NodeHttp.ServerResponse,
) => {
  const bare = (status: number) => {
    if (!response.headersSent) response.writeHead(status, { "content-length": "0" });
    response.end();
  };
  const base = await door.resolve(environmentId).catch(() => null);
  if (base === null) return bare(502);
  const upstream = outgoing(base, request, path, false);
  upstream.on("timeout", () => upstream.destroy());
  upstream.on("error", () => bare(502));
  upstream.on("response", (answer) => {
    const headers = Object.fromEntries(
      Object.entries(answer.headers).filter(([name]) => !HOP_BY_HOP.has(name)),
    );
    response.writeHead(answer.statusCode ?? 502, headers);
    answer.pipe(response);
  });
  request.pipe(upstream);
};

const serveUpgrade = async (
  door: DoorHandler,
  environmentId: string,
  path: string,
  request: NodeHttp.IncomingMessage,
  socket: NodeStream.Duplex,
  head: Buffer,
) => {
  const base = await door.resolve(environmentId).catch(() => null);
  if (base === null) return void socket.end(BARE_502);
  const upstream = outgoing(base, request, path, true);
  upstream.on("timeout", () => upstream.destroy());
  upstream.on("error", () => socket.end(BARE_502));
  upstream.on("response", (answer) => {
    socket.end(
      `HTTP/1.1 ${answer.statusCode ?? 502} ${answer.statusMessage ?? ""}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
    );
    answer.resume();
  });
  upstream.on("upgrade", (answer, theirs, theirHead) => {
    const lines = [`HTTP/1.1 101 ${answer.statusMessage ?? "Switching Protocols"}`];
    for (let i = 0; i < answer.rawHeaders.length; i += 2)
      lines.push(`${answer.rawHeaders[i]}: ${answer.rawHeaders[i + 1]}`);
    socket.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (theirHead.length > 0) socket.write(theirHead);
    if (head.length > 0) theirs.write(head);
    theirs.on("error", () => socket.destroy());
    socket.on("error", () => theirs.destroy());
    theirs.pipe(socket);
    socket.pipe(theirs);
  });
  upstream.end();
};

/**
 * Puts the door in front of every request and upgrade: a name under the door that is not this server's goes to that
 * machine or ends here (404 off the list or unknown, bare 502 asleep); anything else reaches the server as before.
 */
export function withDoorFront<T extends NodeHttp.Server>(server: T): T {
  const emit = server.emit.bind(server) as (
    event: string | symbol,
    ...args: Array<unknown>
  ) => boolean;
  server.emit = ((event: string | symbol, ...args: Array<unknown>) => {
    const door = handler;
    if (door === null || (event !== "request" && event !== "upgrade")) return emit(event, ...args);
    const request = args[0] as NodeHttp.IncomingMessage;
    const target = door.target(hostOf(request.headers.host));
    if (target._tag === "pass") return emit(event, ...args);
    const path = target._tag === "machine" ? doorPath(request.url) : null;
    if (event === "request") {
      const response = args[1] as NodeHttp.ServerResponse;
      if (target._tag === "none" || path === null) {
        response.writeHead(404, { "content-length": "0" }).end();
        return true;
      }
      void serveRequest(door, target.environmentId, path, request, response);
      return true;
    }
    const socket = args[1] as NodeStream.Duplex;
    if (target._tag === "none" || path === null) {
      socket.end(BARE_404);
      return true;
    }
    void serveUpgrade(door, target.environmentId, path, request, socket, args[2] as Buffer);
    return true;
  }) as T["emit"];
  return server;
}
