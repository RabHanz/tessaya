// @effect-diagnostics nodeBuiltinImport:off globalDate:off
/**
 * Baton's tools over MCP (D143): 127.0.0.1 only, a random port, this session's token on every request,
 * no browsers, closed when the session ends. The gate runs here in the handler, before any tool.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";

import { BATON_TOOL_PREFIX } from "@t3tools/baton-shared/operator";

import type { Gate } from "./agentGate.ts";

export interface ToolOutput {
  readonly text?: string;
  readonly images?: ReadonlyArray<{ readonly data: string; readonly mimeType: string }>;
}

export interface BatonTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly run: (args: Readonly<Record<string, unknown>>) => Promise<ToolOutput>;
  /** Kept loaded when tool search is on (`anthropic/alwaysLoad`); the registry's core flag. */
  readonly core?: boolean;
  /** One of his server's shared tools, and whether it only reads: the gate judges it by that. */
  readonly shared?: "read" | "write";
}

export interface BatonMcp {
  readonly url: string;
  readonly token: string;
  readonly close: () => Promise<void>;
}

const MAX_BODY = 1_000_000;
const PROTOCOL = "2025-06-18";

const sameToken = (given: string, token: string): boolean => {
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && NodeCrypto.timingSafeEqual(a, b);
};

interface Rpc {
  readonly jsonrpc?: string;
  readonly id?: string | number | null;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
}

export const startBatonMcp = async (input: {
  readonly tools: ReadonlyArray<BatonTool>;
  readonly gate: Gate;
  /** Removes vault values from anything headed back to the model (D151). */
  readonly scrub?: (text: string) => string;
  /** Every tool call's outcome, with the error text when it failed: the turn log keeps it. */
  readonly onResult?: (result: {
    readonly tool: string;
    readonly ok: boolean;
    readonly error?: string;
    /** The argument names, never their values. */
    readonly argKeys: ReadonlyArray<string>;
    readonly ms: number;
    /** What a call that worked answered, kept only on this machine so a turn can be replayed. */
    readonly text?: string;
  }) => void;
}): Promise<BatonMcp> => {
  const token = NodeCrypto.randomBytes(32).toString("hex");
  let port = 0;
  const tools = new Map(input.tools.map((t) => [t.name, t]));

  const callTool = async (params: Record<string, unknown>) => {
    const name = typeof params["name"] === "string" ? params["name"] : "";
    const tool = tools.get(name);
    if (tool === undefined)
      return { isError: true, content: [{ type: "text", text: `No tool named ${name}.` }] };
    const args =
      typeof params["arguments"] === "object" && params["arguments"] !== null
        ? (params["arguments"] as Record<string, unknown>)
        : {};
    const started = Date.now();
    // Only the names the tool declares: a key the model made up could carry screen text into the trace.
    const declared = Object.keys(
      (tool.inputSchema["properties"] ?? {}) as Readonly<Record<string, unknown>>,
    );
    const took = () => ({
      argKeys: Object.keys(args).filter((k) => declared.includes(k)),
      ms: Date.now() - started,
    });
    const verdict = await input
      .gate({
        tool: `${BATON_TOOL_PREFIX}${name}`,
        input: args,
        ...(tool.shared === undefined ? {} : { shared: tool.shared }),
      })
      .catch(() => ({ allow: false as const, reason: "Tessaya could not check that." }));
    if (!verdict.allow) {
      input.onResult?.({
        tool: name,
        ok: false,
        error: `refused: ${verdict.reason}`.slice(0, 300),
        ...took(),
      });
      return {
        isError: true,
        content: [{ type: "text", text: `Tessaya refused: ${verdict.reason}` }],
      };
    }
    try {
      const out = await tool.run(args);
      input.onResult?.({
        tool: name,
        ok: true,
        ...took(),
        ...(out.text === undefined ? {} : { text: (input.scrub ?? ((t) => t))(out.text) }),
      });
      return {
        content: [
          ...(out.text === undefined
            ? []
            : [{ type: "text", text: (input.scrub ?? ((t) => t))(out.text) }]),
          ...(out.images ?? []).map((i) => ({ type: "image", data: i.data, mimeType: i.mimeType })),
        ],
      };
    } catch (error) {
      input.onResult?.({
        tool: name,
        ok: false,
        error: (input.scrub ?? ((t) => t))(
          error instanceof Error ? error.message : String(error),
        ).slice(0, 300),
        ...took(),
      });
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: (input.scrub ?? ((t) => t))(
              error instanceof Error ? error.message : String(error),
            ),
          },
        ],
      };
    }
  };

  const handle = async (rpc: Rpc): Promise<unknown | null> => {
    const reply = (result: unknown) => ({ jsonrpc: "2.0", id: rpc.id ?? null, result });
    switch (rpc.method) {
      case "initialize":
        return reply({
          protocolVersion:
            typeof rpc.params?.["protocolVersion"] === "string"
              ? rpc.params["protocolVersion"]
              : PROTOCOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "baton", version: "1" },
        });
      case "ping":
        return reply({});
      case "tools/list":
        return reply({
          // Core first, then by name: a stable list keeps the prompt's tool block cached.
          tools: [...tools.values()]
            .toSorted(
              (a, b) =>
                Number(b.core ?? false) - Number(a.core ?? false) || a.name.localeCompare(b.name),
            )
            .map(({ name, description, inputSchema, core }) => ({
              name,
              description,
              inputSchema,
              ...(core === true ? { _meta: { "anthropic/alwaysLoad": true } } : {}),
            })),
        });
      case "tools/call":
        return reply(await callTool(rpc.params ?? {}));
      default:
        // A notification has no id and wants no answer; anything else is a method we do not have.
        return rpc.id === undefined
          ? null
          : { jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "Method not found" } };
    }
  };

  const server = NodeHttp.createServer((req, res) => {
    const refuse = (status: number, why: string) => {
      res.writeHead(status, { "content-type": "text/plain" }).end(why);
    };
    const host = req.headers.host ?? "";
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`)
      return refuse(403, "wrong host");
    if (req.headers.origin !== undefined) return refuse(403, "no browsers");
    const auth = req.headers.authorization ?? "";
    if (!auth.startsWith("Bearer ") || !sameToken(auth.slice(7), token))
      return refuse(401, "token");
    if (req.method !== "POST") return refuse(405, "post only");
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) req.destroy();
      else chunks.push(chunk);
    });
    req.on("end", () => {
      void (async () => {
        try {
          const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          const calls = Array.isArray(body) ? body : [body];
          const answers = (await Promise.all(calls.map((c) => handle(c as Rpc)))).filter(
            (a) => a !== null,
          );
          if (answers.length === 0) return void res.writeHead(202).end();
          res
            .writeHead(200, { "content-type": "application/json" })
            .end(JSON.stringify(Array.isArray(body) ? answers : answers[0]));
        } catch {
          refuse(400, "bad request");
        }
      })();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  port = (server.address() as { port: number }).port;

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    token,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
};

/**
 * A session with its own tool server, closed when that session is disposed: the warm sessions of each model run
 * side by side, and one shared server, closed by the next session's start, left all but the newest without tools.
 */
export const sessionWithOwnMcp = async <S extends { readonly dispose: () => void }>(
  startMcp: () => Promise<BatonMcp>,
  start: (mcp: BatonMcp) => S | Promise<S>,
  live: Set<BatonMcp>,
): Promise<S> => {
  const mcp = await startMcp();
  live.add(mcp);
  const close = () => {
    if (live.delete(mcp)) void mcp.close();
  };
  try {
    const session = await start(mcp);
    return {
      ...session,
      dispose: () => {
        session.dispose();
        close();
      },
    };
  } catch (error) {
    close();
    throw error;
  }
};
