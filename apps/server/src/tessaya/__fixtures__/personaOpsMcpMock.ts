// @effect-diagnostics nodeBuiltinImport:off globalJsonInEffect:off preferSchemaOverJson:off globalDate:off
/**
 * A stand-in for the ops system's MCP over Streamable HTTP, with the device.* tool schemas of its device capabilities
 * and the approval.relay shape. Like the real door it refuses any Origin (403) and a token or worker header that do
 * not match (401), keeps sessions in memory (an unknown one is 404), and answers tool calls as server-sent events.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";

interface Delegate {
  readonly platform: string;
  readonly account: string;
  readonly mayWarmup: boolean;
  readonly mayPost: boolean;
}

interface OpsMockOptions {
  readonly workerHeader: string;
  readonly workerId: string;
  readonly token: string;
  readonly delegates: ReadonlyArray<Delegate>;
  /** False for an ops system that has no device_delegates_list yet. */
  readonly delegatesTool: boolean;
}

type Out = { readonly ok: Record<string, unknown> } | { readonly error: Record<string, unknown> };
type Args = Record<string, unknown> & { plan?: Record<string, unknown> };

const canonical = (v: unknown): string =>
  Array.isArray(v)
    ? `[${v.map(canonical).join(",")}]`
    : v !== null && typeof v === "object"
      ? `{${Object.keys(v)
          .toSorted()
          .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
          .join(",")}}`
      : JSON.stringify(v);

export const startOpsMock = (options: OpsMockOptions) => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const sessions = new Set<string>();
  const state = { initializes: 0, failNext: false, relayPubkey: "" };
  const seenNonces = new Set<unknown>();
  const schedules: Array<Record<string, unknown>> = [];

  const strict = (args: Args, keys: ReadonlyArray<string>) =>
    Object.keys(args).find((k) => !keys.includes(k));
  const may = (platform: unknown, account: unknown, what: "mayWarmup" | "mayPost") =>
    options.delegates.some((d) => d.platform === platform && d.account === account && d[what]);
  const refused = (refusal: string, detail: string): Out => ({
    ok: { schedule: null, refusal, refusalDetail: detail },
  });
  const fail = (code: string, message: string, extra = {}): Out => ({
    error: { code, message, ...extra },
  });

  const tools: Record<string, (a: Args) => Out> = {
    ...(options.delegatesTool
      ? {
          device_delegates_list: (a: Args) =>
            strict(a, ["note"])
              ? fail("INVALID_INPUT", "unknown key")
              : { ok: { delegates: options.delegates } },
        }
      : {}),
    device_warmup_status: (a) =>
      strict(a, ["deviceSerial", "platform"])
        ? fail("INVALID_INPUT", `unknown key ${strict(a, ["deviceSerial", "platform"])}`)
        : { ok: { schedules } },
    device_warmup_schedule: (a) => {
      const bad = strict(a, ["deviceSerial", "plan", "enabled"]);
      if (bad) return fail("INVALID_INPUT", `unknown key ${bad}`);
      const p = a.plan ?? {};
      if (
        p["watchOnly"] !== true ||
        p["interactions"] !== "none" ||
        !Array.isArray(p["nicheTerms"])
      )
        return fail("INVALID_INPUT", "plan is not a watch-only plan");
      if (!may(p["platform"], p["account"], "mayWarmup"))
        return refused(
          "not_delegated",
          `this agent holds no delegation to warm up @${String(p["account"])} on ${String(p["platform"])}`,
        );
      const row = {
        id: "00000000-0000-4000-8000-000000000001",
        deviceSerial: a["deviceSerial"],
        platform: p["platform"],
        account: p["account"],
        plan: p,
        enabled: a["enabled"],
        runRequestedAt: null,
        sessions: [],
        updatedAt: new Date(0).toISOString(),
      };
      schedules.push(row);
      return { ok: { schedule: row, refusal: null, refusalDetail: null } };
    },
    device_warmup_run: (a) => {
      const bad = strict(a, ["deviceSerial", "platform"]);
      if (bad) return fail("INVALID_INPUT", `unknown key ${bad}`);
      const row = schedules.find(
        (s) => s["deviceSerial"] === a["deviceSerial"] && s["platform"] === a["platform"],
      );
      return row
        ? {
            ok: {
              schedule: { ...row, runRequestedAt: new Date(0).toISOString() },
              refusal: null,
              refusalDetail: null,
            },
          }
        : refused("no_schedule", "no warm-up is scheduled for that phone and platform");
    },
    device_post_enqueue: (a) => {
      const bad = strict(a, [
        "deviceSerial",
        "platform",
        "account",
        "mediaRef",
        "caption",
        "idempotencyKey",
      ]);
      if (bad) return fail("INVALID_INPUT", `unknown key ${bad}`);
      if (a["platform"] !== "tiktok") return fail("INVALID_INPUT", "platform must be tiktok");
      if (typeof a["idempotencyKey"] !== "string" || a["idempotencyKey"].length < 8)
        return fail("INVALID_INPUT", "idempotencyKey is too short");
      if (!may(a["platform"], a["account"], "mayPost"))
        return {
          ok: {
            requestId: null,
            status: null,
            refusal: "not_delegated",
            refusalDetail: "no delegation to post",
          },
        };
      return fail("APPROVAL_REQUIRED", "This R3 action needs a human decision before it runs.", {
        capability: "device.post.enqueue",
        requestId: "req-1",
        auditRecordId: "audit-1",
        approval: {
          approvalId: "11111111-1111-4111-8111-111111111111",
          actionType: "device.post.enqueue",
          actionClass: "R3",
          requestedMutation: { before: null, after: a },
        },
        grantPath: "approval.approve",
      });
    },
    approval_relay: (a) => {
      const { signature, ...body } = a;
      if (state.relayPubkey === "") return fail("FORBIDDEN", "no relay key registered");
      const ok = NodeCrypto.verify(
        null,
        Buffer.from(canonical(body), "utf8"),
        NodeCrypto.createPublicKey(state.relayPubkey),
        Buffer.from(String(signature), "base64"),
      );
      if (!ok) return fail("FORBIDDEN", "the signature does not verify");
      if (seenNonces.has(a["nonce"])) return fail("CONFLICT", "nonce already used");
      seenNonces.add(a["nonce"]);
      if (Math.abs(Date.parse(String(a["issued_at"])) - Date.now()) > 5 * 60_000)
        return fail("FORBIDDEN", "stale");
      return {
        ok: {
          approvalId: a["approval_id"],
          decision: a["decision"] === "approve" ? "approved" : "rejected",
        },
      };
    },
  };

  const json = (res: NodeHttp.ServerResponse, status: number, body: unknown, headers = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };

  const server = NodeHttp.createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => (raw += chunk));
    req.on("end", () => {
      if (req.headers.origin !== undefined) return json(res, 403, { error: "no browsers" });
      if (
        req.headers.authorization !== `Bearer ${options.token}` ||
        req.headers[options.workerHeader.toLowerCase()] !== options.workerId
      )
        return json(res, 401, { error: { message: "the token does not belong to this worker" } });
      if (state.failNext) {
        state.failNext = false;
        return void res.writeHead(502).end("bad gateway");
      }
      const msg = JSON.parse(raw) as {
        id?: number;
        method: string;
        params?: { protocolVersion?: string; name?: string; arguments?: Args };
      };
      if (msg.method === "initialize") {
        state.initializes++;
        const id = NodeCrypto.randomUUID();
        sessions.add(id);
        return json(
          res,
          200,
          {
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              protocolVersion: msg.params?.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: "ops", version: "mock" },
            },
          },
          { "mcp-session-id": id },
        );
      }
      const session = req.headers["mcp-session-id"];
      if (typeof session !== "string" || !sessions.has(session))
        return json(res, 404, { error: "unknown session" });
      if (msg.id === undefined) return void res.writeHead(202).end();
      const send = (message: object) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        // A notification first, so the client must pick its answer out by id.
        const note = { jsonrpc: "2.0", method: "notifications/progress", params: {} };
        res.write(`event: message\ndata: ${JSON.stringify(note)}\n\n`);
        res.end(
          `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, ...message })}\n\n`,
        );
      };
      if (msg.method !== "tools/call") return send({ result: {} });
      const name = msg.params?.name ?? "";
      const args = msg.params?.arguments ?? {};
      calls.push({ name, args });
      const tool = tools[name];
      if (tool === undefined)
        return send({ error: { code: -32602, message: `Unknown tool: ${name}` } });
      const out = tool(args);
      return send({
        result:
          "ok" in out
            ? {
                content: [{ type: "text", text: JSON.stringify(out.ok) }],
                structuredContent: out.ok,
                isError: false,
              }
            : { content: [{ type: "text", text: JSON.stringify(out.error) }], isError: true },
      });
    });
  });

  const url = new Promise<string>((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve(`http://127.0.0.1:${port}/mcp`);
    }),
  );
  return {
    url,
    calls,
    state,
    /** The server forgets every session, as a restart there would. */
    forget: () => sessions.clear(),
    close: () => void server.close(),
  };
};
