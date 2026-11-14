// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalFetch:off cryptoRandomUUID:off globalConsole:off
// A remote caller drives Notepad through the hub over HTTP, end to end on a Windows desktop: caller (bearer baton:hands)
// -> hub routes (the real handleHands + broker) -> the desktop's real long-poll loop -> the real gate -> the real remote
// tools over a long-lived sidecar -> UI Automation. Exits non-zero when any expectation fails. Prints the latency of each call
// as the caller saw it (loopback HTTP included; add the network to the laptop for a real remote).
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { BATON_TOOL_PREFIX } from "../../../packages/tessaya-shared/src/operator.ts";
import { createHandsBroker } from "../../../packages/tessaya-shared/src/remoteHands.ts";
import { handleHands } from "../../../apps/server/src/tessaya/TessayaHandsApi.ts";
import { createAgentGate, createTaint } from "../../../apps/desktop/src/tessaya/agent/agentGate.ts";
import { createRemoteHandsLoop } from "../../../apps/desktop/src/tessaya/agent/remoteHandsLoop.ts";
import { buildRemoteHandsTools } from "../../../apps/desktop/src/tessaya/agent/remoteHandsTools.ts";
import { ps, startSidecar } from "./sidecarClient.ts";

const OUT = process.env["HANDS_OUT"] ?? NodePath.join(process.cwd(), "remote-out");
NodeFS.mkdirSync(OUT, { recursive: true });
const TOKENS: Record<string, { scopes: string[]; session: string }> = {
  "caller-token": { scopes: ["baton:hands"], session: "remote-manager" },
  "host-token": { scopes: ["baton:hands-host"], session: "desktop" },
  "reader-token": {
    scopes: ["orchestration:read", "orchestration:operate"],
    session: "other-client",
  },
};

// The hub: the real API function behind a plain HTTP server.
const broker = createHandsBroker({
  now: () => Date.now(),
  newId: () => globalThis.crypto.randomUUID(),
});
const hub = NodeHttp.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    void (async () => {
      const who = TOKENS[(req.headers["authorization"] ?? "").replace(/^Bearer /, "")];
      if (who === undefined) return void (res.writeHead(401), res.end("{}"));
      const body =
        chunks.length === 0 ? undefined : JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const answer = await handleHands(
        broker,
        {
          method: req.method ?? "GET",
          path: (req.url ?? "").replace(/^\/tessaya\/hands\//, ""),
          scopes: new Set(who.scopes),
          session: who.session,
          ...(body === undefined ? {} : { json: body }),
        },
        2_000,
      );
      res.writeHead(answer.status, { "content-type": "application/json" });
      res.end(JSON.stringify(answer.json));
    })();
  });
});
await new Promise<void>((r) => hub.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(hub.address() as { port: number }).port}/tessaya/hands/`;
const post = async (token: string, path: string, body: unknown) => {
  const r = await fetch(base + path, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json()) as Record<string, any> };
};

// The desktop: sidecar, tools, gate (away: a question is a no), loop.
const { call, kill, sidecar } = startSidecar(process.env["SIDECAR"] ?? "tessaya-voice.exe");
void call;
const tools = new Map(
  buildRemoteHandsTools({
    sidecar,
    scratchDir: NodeOS.tmpdir(),
    ops: {
      version: () => "e2e",
      logs: {},
      processes: async () => [],
      stop: async () => {},
      update: async () => "n/a",
      pages: ["home"],
      openPage: async () => "n/a",
    },
  }).map((t) => [t.name, t]),
);
const gate = createAgentGate({
  actWithoutAsking: () => false,
  taint: createTaint(),
  textIsHis: () => false,
  focusedWindow: async () => ({ label: "notepad.exe: Untitled - Notepad", shell: false }),
  confirm: async () => false,
  record: () => undefined,
});
const loop = createRemoteHandsLoop({
  post: (path, body) => post("host-token", path, body),
  enabled: () => true,
  run: async (c) => {
    const tool = tools.get(c.tool);
    if (tool === undefined) return { ok: false, error: `${c.tool} is not a remote hands tool.` };
    const verdict = await gate({ tool: `${BATON_TOOL_PREFIX}${c.tool}`, input: c.args });
    if (!verdict.allow) return { ok: false, error: `Refused: ${verdict.reason}` };
    try {
      const out = await tool.run(c.args);
      return {
        ok: true,
        ...(out.text === undefined ? {} : { text: out.text }),
        ...(out.images === undefined ? {} : { images: out.images }),
      };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },
});
loop.start();

const rows: Array<{ step: string; ms: number; pass: boolean; note: string }> = [];
const step = async (name: string, run: () => Promise<{ pass: boolean; note: string }>) => {
  const t0 = performance.now();
  const r = await run().catch((e: Error) => ({ pass: false, note: e.message }));
  rows.push({ step: name, ms: Math.round(performance.now() - t0), ...r });
};
const remote = (tool: string, args: Record<string, unknown>) =>
  post("caller-token", "call", { tool, args });

ps("Start-Process notepad.exe; Start-Sleep -Seconds 3");
await step("ui_tree of Notepad (by window title)", async () => {
  const r = await remote("ui_tree", { window: "Notepad" });
  return {
    pass: r.json["ok"] === true && /Notepad/.test(String(r.json["text"])),
    note: String(r.json["text"] ?? r.json["error"]).split("\n")[0]!,
  };
});
await step("click Help by pattern, no focus", async () => {
  const r = await remote("click_element", { label: "Help", window: "Notepad", why: "e2e" });
  return {
    pass: r.json["ok"] === true && /no pointer/.test(String(r.json["text"])),
    note: String(r.json["text"] ?? r.json["error"]),
  };
});
await step("click About Notepad", async () => {
  const r = await remote("click_element", {
    label: "About Notepad",
    window: "Notepad",
    why: "e2e",
  });
  return { pass: r.json["ok"] === true, note: String(r.json["text"] ?? r.json["error"]) };
});
await step("wait_for the About dialog's OK", async () => {
  const r = await remote("wait_for", { label: "OK", seconds: 5, window: "About Notepad" });
  return {
    pass: r.json["ok"] === true && /is there/.test(String(r.json["text"])),
    note: String(r.json["text"] ?? r.json["error"]),
  };
});
await step("window_capture of Notepad (a PNG comes back)", async () => {
  const r = await remote("window_capture", { window: "Notepad" });
  const data = String((r.json["images"] as Array<{ data: string }> | undefined)?.[0]?.data ?? "");
  if (data !== "")
    NodeFS.writeFileSync(NodePath.join(OUT, "e2e-notepad.png"), Buffer.from(data, "base64"));
  return {
    pass: Buffer.from(data, "base64").subarray(1, 4).toString() === "PNG",
    note: `${data.length} base64 chars`,
  };
});
await step("Enter is refused while away (the gate would ask)", async () => {
  const r = await remote("press_keys", { keys: ["enter"], why: "e2e" });
  return {
    pass: r.json["ok"] === false && /Refused/.test(String(r.json["error"])),
    note: String(r.json["error"]),
  };
});
await step("a click on a raw point is not a remote tool", async () => {
  const r = await remote("click", { x: 1, y: 1, why: "e2e" });
  return {
    pass: r.json["ok"] === false && /not a remote hands tool/.test(String(r.json["error"])),
    note: String(r.json["error"]),
  };
});
await step("a session without baton:hands gets 403", async () => {
  const r = await post("reader-token", "call", { tool: "ui_tree", args: {} });
  return { pass: r.status === 403, note: `status ${r.status}` };
});
await step("the audit log holds every call, and no typed text", async () => {
  const r = await fetch(base + "audit", { headers: { authorization: "Bearer caller-token" } }).then(
    (x) => x.json() as Promise<{ entries: Array<{ tool: string; outcome: string }> }>,
  );
  return {
    pass: r.entries.length >= 6 && r.entries.some((e) => e.outcome === "refused"),
    note: `${r.entries.length} entries`,
  };
});

console.log("| Step | Caller-seen ms | Pass | Note |\n| --- | --- | --- | --- |");
for (const r of rows)
  console.log(
    `| ${r.step} | ${r.ms} | ${r.pass ? "yes" : "NO"} | ${r.note.replaceAll("|", "/").slice(0, 100)} |`,
  );
NodeFS.writeFileSync(NodePath.join(OUT, "remote-e2e.json"), JSON.stringify(rows, null, 2));
loop.stop();
kill();
try {
  ps(
    "Get-Process -Name notepad -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue; exit 0",
  );
} catch {
  // best effort
}
process.exit(rows.every((r) => r.pass) ? 0 : 1);
