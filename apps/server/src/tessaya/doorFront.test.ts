// The door on the raw Node server: what passes, what is forwarded, and what ends at the door.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import { afterEach, describe, expect, it } from "@effect/vitest";

import {
  type DoorHandler,
  doorPath,
  forwardHeaders,
  setDoorHandler,
  withDoorFront,
} from "./doorFront.ts";

const servers: Array<NodeHttp.Server> = [];
// Upgraded sockets leave the server's own bookkeeping, so they are closed by hand.
const sockets: Array<NodeNet.Socket> = [];

const listen = (server: NodeHttp.Server) =>
  new Promise<number>((resolve) => {
    servers.push(server);
    server.on("connection", (socket) => sockets.push(socket));
    server.listen(0, "127.0.0.1", () => resolve((server.address() as NodeNet.AddressInfo).port));
  });

afterEach(async () => {
  setDoorHandler(null);
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

const get = (port: number, host: string, path: string) =>
  new Promise<{ status: number; body: string; seen: string | undefined }>((resolve, reject) => {
    const request = NodeHttp.request(
      {
        host: "127.0.0.1",
        port,
        path,
        headers: { host, "x-real-ip": "203.0.113.9", "cf-connecting-ip": "198.51.100.1" },
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (body += chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body,
            seen: response.headers["x-seen"] as string | undefined,
          }),
        );
      },
    );
    request.on("error", reject);
    request.end();
  });

/** A machine behind the door that says what it was sent. */
const machine = async () => {
  const server = NodeHttp.createServer((request, response) => {
    response.setHeader(
      "x-seen",
      JSON.stringify({
        path: request.url,
        host: request.headers.host,
        realIp: request.headers["x-real-ip"],
        door: request.headers["x-tessaya-door"],
        cf: request.headers["cf-connecting-ip"] ?? null,
      }),
    );
    response.end("from the machine");
  });
  server.on("upgrade", (request, socket) => {
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nX-Door: ${request.headers["x-tessaya-door"]}\r\n\r\n`,
    );
    socket.on("data", (chunk) => socket.write(chunk));
  });
  return `http://127.0.0.1:${await listen(server)}/`;
};

/** The door brain: its own requests answer "from hive"; like the real server, it takes upgrades too. */
const hive = async (door: DoorHandler) => {
  setDoorHandler(door);
  const server = withDoorFront(
    NodeHttp.createServer((_request, response) => response.end("from hive")),
  );
  server.on("upgrade", (_request, socket) =>
    socket.end("HTTP/1.1 418 From Hive\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"),
  );
  return listen(server);
};

const names = (url: string | null): DoorHandler => ({
  target: (host) =>
    host === "nest.home.example.com"
      ? { _tag: "machine", environmentId: "env-nest" }
      : host === "stray.home.example.com"
        ? { _tag: "none" }
        : { _tag: "pass" },
  resolve: (id) => Promise.resolve(id === "env-nest" ? url : null),
});

describe("doorPath", () => {
  it.each([
    ["/", "/"],
    ["/ws?ticket=abc", "/ws?ticket=abc"],
    ["/api/auth/session", "/api/auth/session"],
    ["/oauth/token", "/oauth/token"],
    ["/api/orchestration/shell", "/api/orchestration/shell"],
    ["/api/tessaya/announce", "/api/tessaya/announce"],
    ["/api/devices/tessel/v1/ready", "/api/devices/tessel/v1/ready"],
  ])("lets %j through", (raw, expected) => {
    expect(doorPath(raw)).toBe(expected);
  });

  it.each([
    "/mcp",
    "/oauth/mcp/token",
    "/.well-known/oauth-authorization-server",
    "/tessaya/private",
    "/tessaya/layer/companion",
    "/api/tessaya/pack",
    "/api/preview/tunnel",
    "/api/peer-link/client-pairing",
    "/api/auth/pairing-token",
    "/api/auth/clients/revoke",
    "/api/auth/connect-devices/approve",
    "/wsx",
    "/api/auth/../../tessaya/private",
    "/api/auth/%2e%2e/%2e%2e/tessaya/private",
    "/api/assets/..%2f..%2ftessaya",
    "/api/auth\\..\\mcp",
    "//evil.example.com/",
    "http://evil.example.com/",
    undefined,
  ])("keeps %j out", (raw) => {
    expect(doorPath(raw)).toBeNull();
  });
});

describe("forwardHeaders", () => {
  it("drops what would say who called and names the caller as the proxy did", () => {
    const out = forwardHeaders(
      {
        host: "nest.home.example.com",
        authorization: "Bearer t",
        "cf-connecting-ip": "198.51.100.1",
        "tailscale-user-login": "someone",
        "x-tessaya-door": "0",
        "x-forwarded-for": "198.51.100.2",
        connection: "keep-alive",
      },
      "203.0.113.9",
      false,
    );
    expect(out).toEqual({
      host: "nest.home.example.com",
      authorization: "Bearer t",
      "x-real-ip": "203.0.113.9",
      "x-forwarded-for": "203.0.113.9",
      "x-forwarded-proto": "https",
      "x-tessaya-door": "1",
    });
  });
});

describe("withDoorFront", () => {
  it("forwards a named machine's allowed path, marked, without the caller's Cloudflare header", async () => {
    const port = await hive(names(await machine()));
    const answer = await get(port, "nest.home.example.com", "/api/environment");
    expect(answer.status).toBe(200);
    expect(answer.body).toBe("from the machine");
    expect(JSON.parse(answer.seen!)).toEqual({
      path: "/api/environment",
      host: "nest.home.example.com",
      realIp: "203.0.113.9",
      door: "1",
      cf: null,
    });
  });

  it("leaves the door's own name and every other host to the server", async () => {
    const port = await hive(names(await machine()));
    expect((await get(port, "hive.home.example.com", "/tessaya/private")).body).toBe("from hive");
    expect((await get(port, "192.168.1.10:3773", "/")).body).toBe("from hive");
  });

  it("ends off-list paths and unknown names at the door with a bare 404", async () => {
    const port = await hive(names(await machine()));
    expect(await get(port, "nest.home.example.com", "/tessaya/private")).toMatchObject({
      status: 404,
      body: "",
    });
    expect(await get(port, "nest.home.example.com", "/mcp")).toMatchObject({
      status: 404,
      body: "",
    });
    expect(await get(port, "stray.home.example.com", "/")).toMatchObject({ status: 404, body: "" });
  });

  it("answers a bare 502 when the machine does not answer as itself (asleep, unlinked or another machine)", async () => {
    const port = await hive(names(null));
    expect(await get(port, "nest.home.example.com", "/")).toMatchObject({ status: 502, body: "" });
  });

  it("answers a bare 502 when the recorded address refuses the connection", async () => {
    const port = await hive(names("http://127.0.0.1:9/"));
    expect(await get(port, "nest.home.example.com", "/")).toMatchObject({ status: 502, body: "" });
  });

  it("carries a WebSocket upgrade through, both ways", async () => {
    const port = await hive(names(await machine()));
    const echoed = await new Promise<{ door: string | undefined; echo: string }>(
      (resolve, reject) => {
        const request = NodeHttp.request({
          host: "127.0.0.1",
          port,
          path: "/ws",
          headers: { host: "nest.home.example.com", connection: "Upgrade", upgrade: "websocket" },
        });
        request.on("upgrade", (response, socket) => {
          socket.once("data", (chunk: Buffer) => {
            resolve({
              door: response.headers["x-door"] as string | undefined,
              echo: chunk.toString(),
            });
            socket.destroy();
          });
          socket.write("hello");
        });
        request.on("error", reject);
        request.end();
      },
    );
    expect(echoed).toEqual({ door: "1", echo: "hello" });
  });

  it("refuses an upgrade on an off-list path", async () => {
    const port = await hive(names(await machine()));
    const status = await new Promise<number>((resolve, reject) => {
      const request = NodeHttp.request({
        host: "127.0.0.1",
        port,
        path: "/mcp",
        headers: { host: "nest.home.example.com", connection: "Upgrade", upgrade: "websocket" },
      });
      request.on("response", (response) => resolve(response.statusCode ?? 0));
      request.on("upgrade", () => resolve(101));
      request.on("error", reject);
      request.end();
    });
    expect(status).toBe(404);
  });
});
