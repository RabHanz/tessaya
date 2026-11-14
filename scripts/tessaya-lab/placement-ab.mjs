// The desktop placement A/B (SPINE-UNIFY §3): first audio by `placement` (app, here, home) in voice-turns.ndjson.
// Usage: node scripts/tessaya-lab/placement-ab.mjs <voice-turns.ndjson> [since ISO time]; `--self-test` checks the maths.
// Rule set before measuring: (b) is the default only if its p50 <= 2.33 s + 150 ms and p90 <= 9.1 s, on n >= 40.

import * as NodeFS from "node:fs";

const BASE_P50 = 2330;
const BASE_P90 = 9100;
const MIN_N = 40;

const quantile = (sorted, q) =>
  sorted.length === 0
    ? null
    : sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];

export const summarise = (lines, since = null) => {
  const arms = {};
  for (const line of lines) {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e?.kind !== "agent_turn" || e.ok !== true || typeof e.firstAudioMs !== "number") continue;
    if (since !== null && !(e.at >= since)) continue;
    (arms[e.placement ?? "app"] ??= []).push(e.firstAudioMs);
  }
  const out = {};
  for (const [arm, ms] of Object.entries(arms)) {
    const sorted = ms.toSorted((a, b) => a - b);
    out[arm] = { n: sorted.length, p50: quantile(sorted, 0.5), p90: quantile(sorted, 0.9) };
  }
  const home = out["home"];
  const verdict =
    home === undefined || home.n < MIN_N
      ? `not enough home turns (${home?.n ?? 0} of ${MIN_N})`
      : home.p50 <= BASE_P50 + 150 && home.p90 <= BASE_P90
        ? "default (b): the home server"
        : "default (a): this machine";
  return { arms: out, verdict };
};

if (process.argv[2] === "--self-test") {
  const turn = (placement, firstAudioMs) =>
    JSON.stringify({
      at: "2026-11-15T00:00:00Z",
      kind: "agent_turn",
      ok: true,
      placement,
      firstAudioMs,
    });
  const fast = Array.from({ length: 40 }, (_, i) => turn("home", 2000 + i * 10));
  const r = summarise([...fast, turn("app", 2500), "not json", turn("home", null)]);
  console.assert(
    r.arms.home.n === 40 && r.arms.home.p50 === 2190 && r.arms.home.p90 === 2350,
    r.arms.home,
  );
  console.assert(r.verdict === "default (b): the home server", r.verdict);
  const slow = Array.from({ length: 40 }, (_, i) => turn("home", 2600 + i));
  console.assert(summarise(slow).verdict === "default (a): this machine");
  console.assert(summarise(fast.slice(0, 10)).verdict.startsWith("not enough"));
  console.assert(summarise(fast, "2027-01-01").arms.home === undefined);
  console.log("self-test done");
} else if (process.argv[2] !== undefined) {
  const lines = NodeFS.readFileSync(process.argv[2], "utf8").split("\n");
  const { arms, verdict } = summarise(lines, process.argv[3] ?? null);
  for (const [arm, s] of Object.entries(arms))
    console.log(`${arm.padEnd(5)} n=${s.n} first audio p50 ${s.p50} ms, p90 ${s.p90} ms`);
  console.log(`baseline p50 ${BASE_P50} ms, p90 ${BASE_P90} ms -> ${verdict}`);
}
