/**
 * The Cloud area of the window: the approval card (in Approvals), the Cloud page (settings, what each
 * assistant can do, my requests) and the 'what needs me' rows. All words come from strings.ts.
 */
import type { NeedItem } from "@t3tools/tessaya-shared/needsMe";
import type { CardState } from "@t3tools/tessaya-shared/cloud/card";
import type { CloudRequest } from "@t3tools/tessaya-shared/cloud/types";

import type { HomeControl } from "../home/tessayaHome.ts";
import { text } from "../home/strings.ts";
import { requestKey, type CloudSettings, type CloudView } from "./cloudService.ts";

const CAPS = [1, 2, 3, 5];

/** The page's settings, assistants and requests. */
export const cloudPageControls = (v: CloudView, s: CloudSettings): ReadonlyArray<HomeControl> => {
  const section = text("cloud.section.where");
  const out: HomeControl[] = [
    {
      id: "cl.set.on",
      section,
      label: text("cloud.on.label"),
      hint: text("cloud.on.hint"),
      kind: "toggle",
      on: s.on,
    },
    {
      id: "setup.cloud.github",
      section,
      label: text("setup.cloud.github"),
      hint: text("setup.cloud.githubHint"),
      kind: "action",
      button: text("setup.cloud.githubButton"),
      more: true,
    },
    {
      id: "setup.cloud.always",
      section,
      label: text("setup.cloud.always"),
      kind: "check",
      status: "ok",
      detail: text("setup.cloud.alwaysDetail"),
      more: true,
    },
  ];
  if (!s.on) {
    return [
      ...out,
      {
        id: "cl.off",
        section,
        label: text("cloud.off.label"),
        kind: "check",
        status: "ok",
        detail: text("cloud.off.detail"),
      },
    ];
  }
  out.push(
    {
      id: "cl.set.transport",
      section,
      label: text("cloud.transport.label"),
      hint: text("cloud.transport.hint"),
      kind: "choice",
      value: s.transport,
      options: [
        { value: "local", label: text("cloud.transport.local") },
        { value: "hub", label: text("cloud.transport.hub") },
        { value: "ssh", label: text("cloud.transport.ssh") },
      ],
    },
    {
      id: "cl.set.ask",
      section,
      label: text("cloud.ask.label"),
      hint: text("cloud.ask.hint"),
      kind: "toggle",
      on: s.askPopup,
    },
    {
      id: "cl.set.cap",
      section,
      label: text("cloud.cap.label"),
      hint: text("cloud.cap.hint"),
      kind: "choice",
      value: String(s.capPoints),
      options: CAPS.map((n) => ({ value: String(n), label: text("cloud.cap.option", { n }) })),
    },
    {
      id: "cl.set.codexEnv",
      section,
      label: text("cloud.codexEnv.label"),
      hint: text("cloud.codexEnv.hint"),
      kind: "editor",
      text: s.codexEnv,
      mine: s.codexEnv !== "",
      more: true,
    },
  );
  if (s.transport === "hub") {
    out.push({
      id: "cl.set.hubEnv",
      section,
      label: text("cloud.hub.label"),
      hint: text("cloud.hub.hint"),
      kind: "choice",
      value: s.hubEnv,
      options: [
        { value: "", label: text("cloud.hub.thisWindow") },
        ...v.environments.map((e) => ({ value: e.id, label: e.label })),
      ],
    });
  }
  if (s.transport === "ssh") {
    const field = (id: string, key: string, value: string): HomeControl => ({
      id,
      section,
      label: text(key),
      hint: text("cloud.ssh.hint"),
      kind: "editor",
      text: value,
      mine: value !== "",
    });
    out.push(
      field("cl.set.sshHost", "cloud.ssh.host", s.sshHost),
      field("cl.set.sshUser", "cloud.ssh.user", s.sshUser),
      field("cl.set.machineKey", "cloud.ssh.machineKey", s.machineKey),
      field("cl.set.approverKey", "cloud.ssh.approverKey", s.approverKey),
      field("cl.set.machineKeyVault", "cloud.ssh.machineKeyVault", s.machineKeyVault),
      field("cl.set.approverKeyVault", "cloud.ssh.approverKeyVault", s.approverKeyVault),
    );
  }
  out.push({
    id: "cl.test",
    section,
    label: text("cloud.test.label"),
    hint: text("cloud.test.hint"),
    kind: "action",
    button: text("cloud.test.button"),
  });
  if (v.tested !== null) {
    v.tested.forEach((t, i) =>
      out.push({
        id: `cl.testrow.${i}`,
        section: text("cloud.test.section"),
        label: t.line,
        kind: "check",
        status: t.ok ? "ok" : "warn",
        detail: "",
      }),
    );
  }
  const assistants = text("cloud.section.assistants");
  for (const p of v.providers) {
    const d = v.detections[p.id];
    out.push({
      id: `cl.det.${p.id}`,
      section: assistants,
      label: d?.line ?? p.label,
      kind: "check",
      status: d?.signedIn === true ? "ok" : "warn",
      detail: d?.signInCommand == null ? "" : text("cloud.signin", { command: d.signInCommand }),
    });
    if (d?.signInCommand != null) {
      out.push({
        id: `cl.signin.${p.id}`,
        section: assistants,
        label: text("cloud.signin.label", { name: p.label }),
        kind: "action",
        button: text("cloud.signin.button"),
      });
    }
  }
  if (v.error !== null)
    out.push({
      id: "cl.err",
      section: assistants,
      label: text("cloud.error"),
      kind: "check",
      status: "warn",
      detail: v.error,
    });
  out.push({
    id: "cl.refresh",
    section: assistants,
    label: text("cloud.refresh.label"),
    kind: "action",
    button: text("cloud.refresh.button"),
  });
  const mine = text("cloud.section.requests");
  if (v.requests.length === 0)
    out.push({
      id: "cl.none",
      section: mine,
      label: text("cloud.none"),
      kind: "check",
      status: "ok",
      detail: "",
    });
  for (const r of v.requests.toReversed().slice(0, 30)) {
    const over = r.pointsUsed !== null && r.pointsUsed > s.capPoints;
    out.push({
      id: `cl.req.${r.provider}:${r.id}`,
      section: mine,
      label: r.task ?? r.id,
      kind: "check",
      status: r.state === "failed" || over ? "warn" : "ok",
      detail: [
        `${r.provider} ${r.id}`,
        r.state,
        r.account,
        r.branch,
        r.sessionLink,
        r.result?.url,
        r.weeklyBefore === null ? null : `${r.weeklyBefore}% to ${r.weeklyAfter ?? "?"}%`,
        r.pointsUsed === null ? null : `${r.pointsUsed} points${over ? " (over your flag)" : ""}`,
      ]
        .filter((x): x is string => x != null && x !== "")
        .join(" · "),
    });
  }
  return out;
};

/** Requests waiting for him, each as a card: assistant, then account, then confirm. Nothing is preselected. */
export const approvalCardControls = (v: CloudView): ReadonlyArray<HomeControl> => {
  const waiting = v.requests.filter((r) => r.state === "awaiting-director");
  const section = text("cloud.section.waiting");
  return waiting.flatMap((r): ReadonlyArray<HomeControl> => {
    const key = requestKey(r);
    const state: CardState = v.cards.get(key) ?? { phase: "provider" };
    const head: HomeControl = {
      id: `cl.head.${r.provider}:${r.id}`,
      section,
      label: r.task ?? r.id,
      hint: [
        text("cloud.card.repo", { repo: r.repo ?? "?", branch: r.branch ?? "?" }),
        text("cloud.card.asked", {
          who: [r.caller, r.label].filter(Boolean).join(" / ") || "?",
          expected: r.expectedUsage === null ? "" : `, ${r.expectedUsage} points expected`,
        }),
        ...(r.fromWeb ? [text("cloud.fromweb")] : []),
      ].join(". "),
      kind: "check",
      status: r.fromWeb ? "warn" : "ok",
      detail: "",
      lead: true,
    };
    const ids = (verb: string, rest?: string) =>
      `cl.${verb}.${r.provider}:${r.id}${rest === undefined ? "" : `:${rest}`}`;
    const deny: HomeControl = {
      id: ids("deny"),
      section,
      label: text("cloud.card.denyLabel"),
      kind: "action",
      button: text("cloud.card.deny"),
    };
    switch (state.phase) {
      case "provider":
        return [
          head,
          ...v.choices.map((c): HomeControl => ({
            id: ids("p", c.id),
            section,
            label: c.label,
            ...(c.why === null ? {} : { hint: c.why }),
            kind: "action",
            button: text("cloud.card.choose"),
            disabled: !c.enabled,
          })),
          deny,
        ];
      case "account": {
        const c = v.choices.find((x) => x.id === state.provider);
        return [
          head,
          ...(c?.accounts ?? []).map((a): HomeControl => ({
            id: ids("a", a.account),
            section,
            label: a.account,
            hint: a.enabled
              ? [
                  a.percent === null
                    ? text("cloud.card.unknown")
                    : text("cloud.card.usage", {
                        percent: a.percent,
                        resets:
                          a.resets === null ? "" : text("cloud.card.resets", { when: a.resets }),
                      }),
                  ...((a.why ?? "").includes("renews soon") ? [text("cloud.card.renewSoon")] : []),
                ].join(" · ")
              : (a.why ?? ""),
            kind: "action",
            button: text("cloud.card.use", { account: a.account }),
            disabled: !a.enabled,
          })),
          {
            id: ids("ok", "later"),
            section,
            label: text("cloud.card.back"),
            kind: "action",
            button: text("cloud.card.back"),
          },
          deny,
        ];
      }
      case "confirm":
        return [
          head,
          {
            id: ids("ok"),
            section,
            label: text("cloud.card.approveOn", {
              account: state.account,
              provider: state.provider,
            }),
            kind: "action",
            button: text("cloud.card.approve"),
            secondary: text("cloud.card.back"),
          },
        ];
      case "approving":
        return [
          head,
          {
            id: `cl.busy.${key}`,
            section,
            label: text("cloud.card.working"),
            kind: "check",
            status: "ok",
            detail: "",
          },
        ];
      case "done":
        return [
          head,
          {
            id: `cl.done.${key}`,
            section,
            label: text("cloud.card.done", { account: state.account }),
            kind: "check",
            status: "ok",
            detail: "",
          },
        ];
      case "denied":
        return [
          head,
          {
            id: `cl.denied.${key}`,
            section,
            label: text("cloud.card.denied"),
            kind: "check",
            status: "ok",
            detail: "",
          },
        ];
      case "error":
        return [
          head,
          {
            id: `cl.fail.${key}`,
            section,
            label: state.message,
            kind: "check",
            status: "bad",
            detail: "",
          },
          {
            id: ids("ok", "later"),
            section,
            label: text("cloud.card.retry"),
            kind: "action",
            button: text("cloud.card.retry"),
          },
        ];
    }
  });
};

/** One 'needs you' row per request that waits for an answer. */
export const cloudNeeds = (requests: ReadonlyArray<CloudRequest>): ReadonlyArray<NeedItem> =>
  requests
    .filter((r) => r.state === "awaiting-director")
    .map((r) => ({
      id: `cloud:${requestKey(r)}`,
      source: "approval" as const,
      title: text("cloud.need.title", { task: r.task ?? r.id }),
      why: text("cloud.need.why"),
      weight: 90,
    }));
