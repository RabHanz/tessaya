/** The Approvals area of Baton's window (D146): one row per thing waiting for his yes. */
import type { Approval } from "@t3tools/tessaya-shared/approvals";

import type { HomeControl } from "../home/batonHome.ts";

export const approvalControls = (
  items: ReadonlyArray<Approval>,
  state: "loading" | "ready" | { readonly error: string },
): ReadonlyArray<HomeControl> =>
  state === "loading"
    ? [
        {
          id: "a.loading",
          section: "Waiting for you",
          label: "Reading what is waiting",
          kind: "check",
          status: "ok",
          detail: "Asking the sessions window; it opens if it is not already.",
        },
      ]
    : state !== "ready"
      ? [
          {
            id: "a.load",
            section: "Waiting for you",
            label: "Could not read what is waiting",
            hint: state.error,
            kind: "action",
            button: "Try again",
          },
        ]
      : items.length === 0
        ? [
            {
              id: "a.empty",
              section: "Waiting for you",
              label: "Nothing is waiting for your yes",
              kind: "check",
              status: "ok",
              detail: "No plan or question needs you.",
            },
          ]
        : items.map((a): HomeControl => ({
            id: `a:${a.id}`,
            section: "Waiting for you",
            label: `${a.title}: ${a.action}`,
            hint: `${JSON.stringify(a.agent)} asks${a.project === null ? "" : `, in ${JSON.stringify(a.project)}`}. Would use: ${a.permission}`,
            kind: "action",
            button: a.kind === "plan" ? "Approve" : "Open T3",
            ...(a.kind === "plan" ? { secondary: "Deny" } : {}),
            lead: true,
          }));

/** `a:p:<job>` Approve and `a:p:<job>:later` Deny; `a:s:<key>` opens the session. */
export const approvalAction = (id: string) => {
  const m = /^a:(p|s):(.+?)(:later)?$/.exec(id);
  return m === null
    ? null
    : ({ kind: m[1] === "p" ? "plan" : "session", ref: m[2]!, deny: m[3] !== undefined } as const);
};
