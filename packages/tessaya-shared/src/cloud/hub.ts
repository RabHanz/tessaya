/**
 * Transport 2, the general multi-machine answer: one computer holds the logins and runs the harness (it
 * answers `serveCloudCall` with its local providers); every other computer reaches it through the
 * authenticated T3 connection it already has, as `baton.cloud.call`. No SSH, no tailnet, no keys of its
 * own. The request and the answer are plain JSON; the contract is in docs/baton/CLOUD_DISPATCH.md.
 */
import type {
  CloudProvider,
  Detection,
  Outcome,
  ProviderId,
  ResultKind,
  TransportKind,
} from "./types.ts";

export const CLOUD_OPS = [
  "describe",
  "detect",
  "dispatch",
  "status",
  "list",
  "cancel",
  "usage",
  "approve",
  "deny",
  "diff",
  "apply",
] as const;
export type CloudOp = (typeof CLOUD_OPS)[number];

/** What the hub says a provider is, once, so the other computer can draw the card without asking again. */
export interface Described {
  readonly id: ProviderId;
  readonly label: string;
  readonly driver: string;
  readonly accounts: ReadonlyArray<string>;
  readonly capabilities: CloudProvider["capabilities"];
  readonly resultKind: ResultKind;
  readonly detection: Detection;
}

const fail = <T>(error: string): Outcome<T> => ({ ok: false, error });

/** The hub's side: run one call on the hub's own providers. Never throws; unknown means a plain refusal. */
export const serveCloudCall = async (
  providers: ReadonlyMap<ProviderId, CloudProvider>,
  call: {
    readonly op: string;
    readonly provider?: string;
    readonly args?: Readonly<Record<string, unknown>>;
  },
): Promise<Outcome<unknown>> => {
  const a = call.args ?? {};
  const text = (k: string): string => (typeof a[k] === "string" ? (a[k] as string) : "");
  if (call.op === "describe") {
    const all: Described[] = [];
    for (const p of providers.values()) {
      all.push({
        id: p.id,
        label: p.label,
        driver: p.driver,
        accounts: p.accounts(),
        capabilities: p.capabilities,
        resultKind: p.capabilities.resultKind,
        detection: await p.detect(),
      });
    }
    return { ok: true, value: all };
  }
  const p = providers.get(call.provider as ProviderId);
  if (p === undefined)
    return fail("That cloud provider is not set up on the computer that runs cloud tasks.");
  try {
    switch (call.op) {
      case "detect":
        return { ok: true, value: await p.detect() };
      case "dispatch":
        return await p.dispatch({
          repo: text("repo"),
          branch: text("branch"),
          brief: text("brief"),
          ...(text("label") === "" ? {} : { label: text("label") }),
          ...(typeof a["expectedUsage"] === "number" ? { expectedUsage: a["expectedUsage"] } : {}),
          fromWeb: a["fromWeb"] === true,
        });
      case "status":
        return await p.status(text("id"));
      case "list":
        return await p.list({
          mine: a["mine"] === true,
          ...(text("label") === "" ? {} : { label: text("label") }),
        });
      case "cancel":
        return await p.cancel(text("id"));
      case "usage":
        return await p.usage();
      case "approve":
        return await p.approve(text("id"), text("account"), text("answerRef"));
      case "deny":
        return await p.deny(text("id"), text("reason"));
      case "diff":
        return p.diff === undefined
          ? fail("That provider cannot show a diff.")
          : await p.diff(text("id"));
      case "apply":
        return p.apply === undefined
          ? fail("That provider cannot apply a change.")
          : await p.apply(text("id"), text("dir"));
      default:
        return fail("The computer that runs cloud tasks does not know that request.");
    }
  } catch {
    return fail("The computer that runs cloud tasks failed on that request.");
  }
};

/** The other computers' side: a provider that asks the hub. `call` is the authenticated connection. */
export const hubProvider = (
  d: Described,
  call: (
    op: CloudOp,
    provider: ProviderId,
    args: Readonly<Record<string, unknown>>,
  ) => Promise<Outcome<unknown>>,
  transport: TransportKind = "hub",
): CloudProvider => {
  const ask = async <T>(
    op: CloudOp,
    args: Readonly<Record<string, unknown>> = {},
  ): Promise<Outcome<T>> => (await call(op, d.id, args)) as Outcome<T>;
  return {
    id: d.id,
    transport,
    label: d.label,
    driver: d.driver,
    capabilities: d.capabilities,
    approval: "local",
    setup: () => ({ state: "ready" }),
    detect: async () => {
      const r = await ask<Detection>("detect");
      return r.ok
        ? r.value
        : {
            ...d.detection,
            line: `${d.label}: the computer that runs cloud tasks did not answer.`,
          };
    },
    accounts: () => d.accounts,
    dispatch: (i) => ask("dispatch", { ...i }),
    status: (id) => ask("status", { id }),
    list: (f) => ask("list", { ...f }),
    cancel: (id) => ask("cancel", { id }),
    usage: () => ask("usage"),
    approve: (id, account, answerRef) => ask("approve", { id, account, answerRef }),
    deny: (id, reason) => ask("deny", { id, reason }),
    ...(d.capabilities.diff ? { diff: (id: string) => ask<string>("diff", { id }) } : {}),
    ...(d.capabilities.apply
      ? { apply: (id: string, dir: string) => ask<string>("apply", { id, dir }) }
      : {}),
  };
};
