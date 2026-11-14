// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalConsole:off globalRandom:off
// Remote hands latency on a real Windows desktop: the remote tool table over ONE long-lived sidecar (as the app runs it), called
// through the broker exactly as a remote session's call would be (call, take, run, reply). No network hop is included: add the
// round trip of the connection. Prints a table and writes remote-bench.json.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { ps, startSidecar } from "./sidecarClient.ts";
import { createHandsBroker } from "../../../packages/tessaya-shared/src/remoteHands.ts";
import { buildRemoteHandsTools } from "../../../apps/desktop/src/tessaya/agent/remoteHandsTools.ts";

const OUT = process.env["HANDS_OUT"] ?? NodePath.join(process.cwd(), "remote-out");
NodeFS.mkdirSync(OUT, { recursive: true });
const { call, kill, sidecar } = startSidecar(process.env["SIDECAR"] ?? "tessaya-voice.exe");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const tools = new Map(
  buildRemoteHandsTools({
    sidecar,
    scratchDir: NodeOS.tmpdir(),
    ops: {
      version: () => "bench",
      logs: {},
      processes: async () => [],
      stop: async () => {},
      update: async () => "n/a",
      pages: ["home"],
      openPage: async () => "n/a",
    },
  }).map((t) => [t.name, t]),
);

// The same path a remote call takes: broker.call, then the desktop's take, run and reply.
const broker = createHandsBroker({ now: () => Date.now(), newId: () => String(Math.random()) });
const serve = async () => {
  for (;;) {
    const c = await broker.take(1_000);
    if (c === null) continue;
    void tools
      .get(c.tool)!
      .run(c.args)
      .then(
        (out) =>
          broker.reply(c.id, {
            ok: true,
            ...(out.text === undefined ? {} : { text: out.text }),
            ...(out.images === undefined ? {} : { images: out.images }),
          }),
        (e: Error) => broker.reply(c.id, { ok: false, error: e.message }),
      );
  }
};
void serve();
await sleep(300);

const rows: Array<{ step: string; n: number; p50: number; p90: number; max: number; ok: number }> =
  [];
const measure = async (step: string, n: number, args: () => [string, Record<string, unknown>]) => {
  const times: number[] = [];
  let ok = 0;
  const seen = new Set<string | undefined>();
  for (let i = 0; i < n; i += 1) {
    const [tool, a] = args();
    const t0 = performance.now();
    const r = await broker.call("bench", tool, a);
    times.push(performance.now() - t0);
    if (r.ok) ok += 1;
    else if (!seen.has(r.error)) (seen.add(r.error), console.log(`  ${step}: ${r.error}`));
  }
  const s = [...times].sort((x, y) => x - y);
  const q = (p: number) => Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]!);
  rows.push({ step, n, p50: q(0.5), p90: q(0.9), max: q(1), ok });
};

ps("Start-Process calc.exe; Start-Sleep -Seconds 4");
await measure("ui_tree (named window, Calculator)", 20, () => [
  "ui_tree",
  { window: "Calculator" },
]);
await measure("click_element by pattern (Calculator, no focus)", 20, () => [
  "click_element",
  { label: "1", window: "Calculator", why: "bench" },
]);
{
  // Why a pattern click can fail: what the tree holds and what a plain locate finds for "1".
  const where = await call<Record<string, unknown>>({
    cmd: "locate",
    label: "1",
    x: 0,
    y: 0,
    window: "Calculator",
  });
  const tree = await call<{ controls?: string[] }>({ cmd: "ui_tree", window: "Calculator" });
  console.log(`  locate "1": ${JSON.stringify(where)}`);
  console.log(`  tree: ${(tree.controls ?? []).slice(0, 40).join(" | ")}`);
}
await measure("act_batch of 3 clicks (one call)", 10, () => [
  "act_batch",
  {
    steps: ["1", "2", "3"].map((label) => ({
      tool: "click_element",
      args: { label, window: "Calculator", why: "bench" },
    })),
  },
]);
// Put another window in front, so Calculator is covered, then take its picture.
ps("Start-Process notepad.exe; Start-Sleep -Seconds 2");
await measure("window_capture of a covered window (Calculator)", 10, () => [
  "window_capture",
  { window: "Calculator" },
]);
await measure("window_capture of the front window (Notepad)", 10, () => [
  "window_capture",
  { window: "Notepad" },
]);
const pic = await broker.call("bench", "window_capture", { window: "Calculator" });
if (pic.images?.[0] !== undefined)
  NodeFS.writeFileSync(
    NodePath.join(OUT, "covered-calculator.png"),
    Buffer.from(pic.images[0].data, "base64"),
  );

console.log(
  "| Step | Calls | OK | p50 ms | p90 ms | max ms |\n| --- | --- | --- | --- | --- | --- |",
);
for (const r of rows)
  console.log(`| ${r.step} | ${r.n} | ${r.ok} | ${r.p50} | ${r.p90} | ${r.max} |`);
NodeFS.writeFileSync(NodePath.join(OUT, "remote-bench.json"), JSON.stringify(rows, null, 2));
try {
  ps(
    "Get-Process -Name CalculatorApp,Calculator,win32calc,calc,notepad -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue",
  );
} catch {
  // best effort: nothing to stop is not a failure
}
kill();
process.exit(0);
