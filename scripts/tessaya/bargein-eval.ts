// @effect-diagnostics globalConsole:off
// Measures the barge-in detector in the synthetic room (docs/baton/BARGE_IN.md): false barge-ins on Tessaya's own voice per 10 minutes,
// and recall of interruptions by how loud he is over the echo. node scripts/tessaya/bargein-eval.ts [seconds-per-room]
import { evaluateGuard } from "../../packages/baton-voice/src/echoSim.ts";

const result = await evaluateGuard({ seconds: Number(process.argv[2] ?? 120), levelsDb: [-6, 0, 6, 12] });
console.log(JSON.stringify(result, null, 2));
const ok = result.falsePer10Min <= 1 && (result.recall["0"] ?? 0) >= 0.9;
console.log(
  ok
    ? "meets the target"
    : "does not meet the target (under 1 false per 10 min and recall >= 0.9 at 0 dB)",
);
if (process.argv.includes("--require") && !ok) process.exit(1);
