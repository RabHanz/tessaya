import { useAtomValue } from "@effect/atom-react";

import { tessayaEnvironmentIdAtom } from "../../../state/tessayaHousehold";
import { tessayaWorkSessions } from "../../../state/tessayaWorkSessions";
import { useAtomCommand } from "../../../state/use-atom-command";
import type { StepUpCall } from "./stepUp";

/** The household's `stepUp` on her brain, as a StepUpCall. */
export function useStepUpCall(): StepUpCall | null {
  const environmentId = useAtomValue(tessayaEnvironmentIdAtom);
  const call = useAtomCommand(tessayaWorkSessions.householdCall, { reportFailure: false });
  if (environmentId === null) return null;
  return async (pin) => {
    const r = await call({ environmentId, input: { op: "stepUp", pin } });
    if (r._tag !== "Success")
      return { ok: false, refused: false, line: "Her brain can't be reached." };
    return {
      ok: r.value.status === "done",
      refused: r.value.status === "refused",
      line: r.value.line,
    };
  };
}
