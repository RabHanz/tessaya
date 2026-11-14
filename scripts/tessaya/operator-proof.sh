#!/usr/bin/env bash
# A repeatable proof of the operator's gate (D127, D128). No microphone, no pointer, no model, no
# network: it feeds Claude's and Codex's own permission messages through the real gate and checks
# what it answers. Prints PASS or FAIL for each case; exits 1 if any fails.
set -uo pipefail
cd "$(dirname "$0")/../../apps/desktop"
out="$(mktemp)"
trap 'rm -f "$out"' EXIT
vp test run src/tessaya/screen/operatorProof.test.ts --reporter=json --outputFile="$out" >/dev/null 2>&1
node -e '
const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const cases = r.testResults.flatMap((f) => f.assertionResults);
if (cases.length === 0) { console.log("FAIL  the proof did not run"); process.exit(1); }
for (const c of cases) console.log((c.status === "passed" ? "PASS  " : "FAIL  ") + c.title.replace(/^PROOF \d+: /, ""));
const bad = cases.filter((c) => c.status !== "passed").length;
console.log(bad === 0 ? "\nAll " + cases.length + " passed." : "\n" + bad + " of " + cases.length + " FAILED.");
process.exit(bad === 0 ? 0 : 1);
' "$out"
