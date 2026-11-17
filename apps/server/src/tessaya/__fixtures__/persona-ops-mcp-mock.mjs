// A stand-in for the ops system's MCP server (stdio), with the device.* tool schemas of the ops system's device capabilities and the
// approval.relay shape: it resolves its worker from the environment as the real one does, refuses unknown keys
// (`.strict()`), answers a delegate-less act `not_delegated`, files an approval for a post, and checks relays.
// Every call it gets is appended to MOCK_LOG as one JSON line.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeReadline from "node:readline";

const env = process.env;
if (env.OPS_WORKER_ID !== env.MOCK_WORKER_ID || env.OPS_TOKEN !== env.MOCK_TOKEN) {
  process.stderr.write("[ops-mcp] the token does not belong to this worker\n");
  process.exit(78);
}
const delegates = JSON.parse(env.MOCK_DELEGATES ?? "[]");
const seenNonces = new Set();
const log = (entry) =>
  env.MOCK_LOG && NodeFS.appendFileSync(env.MOCK_LOG, `${JSON.stringify(entry)}\n`);

const canonical = (v) =>
  Array.isArray(v)
    ? `[${v.map(canonical).join(",")}]`
    : v !== null && typeof v === "object"
      ? `{${Object.keys(v)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
          .join(",")}}`
      : JSON.stringify(v);

const strict = (args, keys) => Object.keys(args).find((k) => !keys.includes(k));
const may = (platform, account, what) =>
  delegates.some((d) => d.platform === platform && d.account === account && d[what] === true);
const refused = (refusal, detail) => ({ ok: { schedule: null, refusal, refusalDetail: detail } });
const fail = (code, message, extra = {}) => ({ error: { code, message, ...extra } });

const schedules = [];
const tools = {
  device_warmup_status: (a) =>
    strict(a, ["deviceSerial", "platform"])
      ? fail("INVALID_INPUT", `unknown key ${strict(a, ["deviceSerial", "platform"])}`)
      : { ok: { schedules } },
  device_warmup_schedule: (a) => {
    const bad = strict(a, ["deviceSerial", "plan", "enabled"]);
    if (bad) return fail("INVALID_INPUT", `unknown key ${bad}`);
    const p = a.plan ?? {};
    if (p.watchOnly !== true || p.interactions !== "none" || !Array.isArray(p.nicheTerms))
      return fail("INVALID_INPUT", "plan is not a watch-only plan");
    if (!may(p.platform, p.account, "warmup"))
      return refused(
        "not_delegated",
        `this agent holds no delegation to warm up @${p.account} on ${p.platform}`,
      );
    const row = {
      id: "00000000-0000-4000-8000-000000000001",
      deviceSerial: a.deviceSerial,
      platform: p.platform,
      account: p.account,
      plan: p,
      enabled: a.enabled,
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
      (s) => s.deviceSerial === a.deviceSerial && s.platform === a.platform,
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
    if (a.platform !== "tiktok") return fail("INVALID_INPUT", "platform must be tiktok");
    if (typeof a.idempotencyKey !== "string" || a.idempotencyKey.length < 8)
      return fail("INVALID_INPUT", "idempotencyKey is too short");
    if (!may(a.platform, a.account, "post"))
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
    if (!env.MOCK_RELAY_PUBKEY) return fail("FORBIDDEN", "no relay key registered");
    const ok = NodeCrypto.verify(
      null,
      Buffer.from(canonical(body), "utf8"),
      NodeCrypto.createPublicKey(env.MOCK_RELAY_PUBKEY),
      Buffer.from(String(signature), "base64"),
    );
    if (!ok) return fail("FORBIDDEN", "the signature does not verify");
    if (seenNonces.has(a.nonce)) return fail("CONFLICT", "nonce already used");
    seenNonces.add(a.nonce);
    if (Math.abs(Date.parse(a.issued_at) - Date.now()) > 5 * 60_000)
      return fail("FORBIDDEN", "stale");
    return {
      ok: {
        approvalId: a.approval_id,
        decision: a.decision === "approve" ? "approved" : "rejected",
      },
    };
  },
};

const send = (message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);

NodeReadline.createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize")
    return send({
      id: msg.id,
      result: {
        protocolVersion: msg.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "ops", version: "mock" },
      },
    });
  if (msg.method !== "tools/call")
    return msg.id === undefined ? undefined : send({ id: msg.id, result: {} });
  const { name, arguments: args = {} } = msg.params;
  log({ name, args });
  const tool = tools[name];
  if (!tool) return send({ id: msg.id, error: { code: -32602, message: `Unknown tool: ${name}` } });
  const out = tool(args);
  return send({
    id: msg.id,
    result: out.ok
      ? {
          content: [{ type: "text", text: JSON.stringify(out.ok) }],
          structuredContent: out.ok,
          isError: false,
        }
      : { content: [{ type: "text", text: JSON.stringify(out.error) }], isError: true },
  });
});
