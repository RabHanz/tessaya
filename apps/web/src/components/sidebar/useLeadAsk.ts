import type { EnvironmentId } from "@t3tools/tessaya-contracts";
import { useEffect, useState } from "react";

import { randomUUID } from "~/lib/utils";
import { tessayaWorkSessions } from "../../state/tessayaWorkSessions";
import { leadAskSettled } from "../../tessayaIntentView";
import { useAtomCommand } from "../../state/use-atom-command";

/** How often an ask left for the lead is re-read until it is answered. */
const LEAD_POLL_MS = 1_500;

/**
 * Her one way to answer typed words from a page: the ask is left for the lead (the one assistant) on this server and
 * re-read until it settles, each line handed to `onLine`. The intent bar and Help both ask through it.
 */
export function useLeadAsk(environmentId: EnvironmentId, onLine: (line: string) => void) {
  const phoneCall = useAtomCommand(tessayaWorkSessions.phoneCall, { reportFailure: false });
  const [pending, setPending] = useState<{ readonly id: string; readonly at: number } | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- re-reads the lead's answer from the server until it settles; the server expires an undelivered ask in minutes
  useEffect(() => {
    if (pending === null) return;
    const timer = setInterval(() => {
      void phoneCall({
        environmentId,
        input: { op: "askGet", args: { id: pending.id } },
      }).then((result) => {
        const got =
          result._tag === "Success"
            ? (result.value.value as { status?: string; line?: string } | null)
            : undefined;
        if (got?.line !== undefined) onLine(got.line);
        if (leadAskSettled(got, pending.at, Date.now())) setPending(null);
      });
    }, LEAD_POLL_MS);
    return () => clearInterval(timer);
  }, [pending, environmentId, phoneCall, onLine]);

  /** Leaves the ask; true when the lead took it. Its first line ("Asking Tessaya…" or why not) goes to `onLine`. */
  const ask = async (text: string): Promise<boolean> => {
    const id = `web-${randomUUID()}`;
    const result = await phoneCall({ environmentId, input: { op: "ask", args: { id, text } } });
    const made =
      result._tag === "Success" ? (result.value.value as { ok?: boolean; line?: string }) : null;
    onLine(made?.line ?? "Tessaya is not reachable from here.");
    if (made?.ok !== true) return false;
    setPending({ id, at: Date.now() });
    return true;
  };

  return { ask, waiting: pending !== null };
}
