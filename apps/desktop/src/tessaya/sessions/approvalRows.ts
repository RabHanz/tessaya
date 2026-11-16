/** The Approvals area of Baton's window (D146): one row per thing waiting for his yes. */
import type { Approval } from "@t3tools/tessaya-shared/approvals";
import type { PhonePrompt } from "@t3tools/tessaya-shared/phoneRelay";

import type { HomeControl } from "../home/tessayaHome.ts";

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

/**
 * The cards waiting for his yes on any of his servers (settings, home and owner acts), answerable at his desk: the yes
 * and no on one row, any other answer on its own. `ac:<index>:<else>:<card>`, with `:later` for the row's second button.
 */
export const cardControls = (cards: ReadonlyArray<PhonePrompt>): ReadonlyArray<HomeControl> =>
  cards.flatMap((c) => [
    {
      id: `ac:${c.yes}:${c.cancel}:${c.id}`,
      section: "Waiting for you",
      label: `${c.title}: ${c.detail}`,
      ...(c.on === undefined ? {} : { hint: `Asked on ${c.on}` }),
      kind: "action" as const,
      button: c.buttons[c.yes] ?? "Yes",
      ...(c.cancel === c.yes ? {} : { secondary: c.buttons[c.cancel] ?? "No" }),
      lead: true,
    },
    ...c.buttons.flatMap((b, i) =>
      i === c.yes || i === c.cancel
        ? []
        : [
            {
              id: `ac:${i}:${i}:${c.id}`,
              section: "Waiting for you",
              label: `${c.title}: ${b}`,
              kind: "action" as const,
              button: b,
            },
          ],
    ),
  ]);

/** Which card and which answer an `ac:` row's button gives. */
export const cardAction = (id: string) => {
  const m = /^ac:(\d+):(\d+):(.+?)(:later)?$/.exec(id);
  return m === null ? null : { id: m[3]!, index: Number(m[m[4] === undefined ? 1 : 2]) };
};
