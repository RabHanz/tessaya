/**
 * A standing job's run (KIRO-1): only its own tools, and each call judged by standingVerdict as one nobody is watching,
 * before the device slot's own gate (taint on, no act-without-asking) has its say.
 */
import type { Gate } from "./agentGate.ts";
import { tessayaToolName } from "@t3tools/tessaya-shared/operator";

export const standingGate =
  (
    slotGate: Gate,
    job: {
      readonly tools: ReadonlyArray<string>;
      readonly judge: (tool: string) => { readonly verdict: string; readonly why?: string };
    },
  ): Gate =>
  async (call) => {
    const name = tessayaToolName(call.tool);
    if (!job.tools.includes(name))
      return { allow: false, reason: `${name} is not one of this job's tools.` };
    const verdict = job.judge(name);
    return verdict.verdict === "allow"
      ? slotGate(call)
      : { allow: false, reason: verdict.why ?? `${name} is held with nobody there.` };
  };
