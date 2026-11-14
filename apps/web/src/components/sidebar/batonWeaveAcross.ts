/**
 * Weave across the computers this window is connected to (his own machines): a name is looked up in every one's
 * sessions together, exact first, and a name that fits sessions on two computers is refused, never guessed. Each
 * environment's own server types into its own panes, so no machine reaches another over ssh.
 */
import type { BatonFleet, BatonWeave, BatonWeaveBridgeRequest } from "@t3tools/tessaya-contracts";

/** The names weave knows a computer's sessions by: its Herdr panes, and Claude sessions outside Herdr. */
export const weaveSessionsOf = (fleet: BatonFleet | null): ReadonlyArray<string> | null =>
  fleet === null
    ? null
    : [
        ...(fleet.herdr ?? []).map((pane) => pane.label),
        ...(fleet.claudeSessions ?? [])
          .filter((session) => session.herdrPane === null)
          .map((session) => session.name ?? session.cwd.split(/[\\/]/).at(-1) ?? session.cwd),
      ];

export type WeaveReply =
  | { readonly ok: true; readonly value: unknown }
  | {
      readonly ok: false;
      readonly reason: string;
      /** "missing": no session by that name there. "unreachable": refused before anything was sent (not permitted). */
      readonly kind: "missing" | "unreachable" | "other";
    };

export interface WeaveEnvironment {
  readonly id: string;
  readonly label: string;
  /** The session names it shows now; null while it is not connected. */
  readonly sessions: ReadonlyArray<string> | null;
}

interface Found {
  readonly environment: WeaveEnvironment;
  readonly name: string;
}

/** Exact names first, then a part of exactly one; more than one is said, with the computers, so he can name one. */
const choose = (
  to: string,
  environments: ReadonlyArray<WeaveEnvironment>,
): { readonly found: Found } | { readonly why: string } | null => {
  const want = to.trim().toLowerCase();
  const all = environments.flatMap((environment) =>
    (environment.sessions ?? []).map((name) => ({ environment, name })),
  );
  const exact = all.filter((f) => f.name.toLowerCase() === want);
  const fits = exact.length > 0 ? exact : all.filter((f) => f.name.toLowerCase().includes(want));
  if (fits.length === 1) return { found: fits[0]! };
  if (fits.length === 0) return null;
  return {
    why: `"${to}" fits more than one session (${fits
      .slice(0, 5)
      .map((f) => `${f.environment.label}:${f.name}`)
      .join(", ")}); say which`,
  };
};

const named = (
  environment: WeaveEnvironment,
  first: WeaveEnvironment | undefined,
  value: unknown,
) => {
  const weave = (value as { weave?: BatonWeave }).weave;
  return environment.id === first?.id || weave === undefined
    ? value
    : {
        ...(value as object),
        weave: { ...weave, toLabel: `${environment.label}:${weave.toLabel}` },
      };
};

/**
 * Where a send goes. A session name on any connected computer is that session, even when it looks like
 * `computer:name`. Otherwise a known computer's name in front picks that computer, sent as named even if its list
 * has not caught up. Anything else must be in a list; a name is never tried on each computer in turn.
 */
const targetOf = (
  to: string,
  environments: ReadonlyArray<WeaveEnvironment>,
  connected: ReadonlyArray<WeaveEnvironment>,
): { readonly found: Found } | { readonly why: string } => {
  const want = to.toLowerCase();
  const isSession = connected.some((e) => (e.sessions ?? []).some((n) => n.toLowerCase() === want));
  const computers = isSession
    ? []
    : environments.filter((e) => want.startsWith(`${e.label.toLowerCase()}:`));
  if (computers.length > 1)
    return { why: `More than one computer is called "${computers[0]!.label}". Nothing was sent.` };
  const computer = computers[0];
  if (computer !== undefined) {
    if (computer.sessions === null)
      return { why: `${computer.label} isn't connected. Nothing was sent.` };
    return { found: { environment: computer, name: to.slice(computer.label.length + 1).trim() } };
  }
  return (
    choose(to, connected) ?? {
      why: `"${to}" isn't in any session list yet. Say computer:name.`,
    }
  );
};

export const weaveAcross = async (
  request: BatonWeaveBridgeRequest,
  /** This computer first. */
  environments: ReadonlyArray<WeaveEnvironment>,
  call: (
    environmentId: string,
    op: BatonWeaveBridgeRequest["op"],
    args: unknown,
  ) => Promise<WeaveReply>,
): Promise<unknown> => {
  const connected = environments.filter((e) => e.sessions !== null);
  const first = environments[0];
  if (request.op === "send") {
    const to = String((request.args as { to?: unknown }).to ?? "").trim();
    const target = targetOf(to, environments, connected);
    if ("why" in target) throw new Error(target.why);
    const { environment, name } = target.found;
    const reply = await call(environment.id, "send", { ...request.args, to: name });
    if (reply.ok) return named(environment, first, reply.value);
    throw new Error(reply.reason);
  }
  const replies = await Promise.all(
    connected.map(async (environment) => ({
      environment,
      reply: await call(environment.id, request.op, request.args),
    })),
  );
  if (request.op === "tick") {
    let delivered = 0;
    let replied = 0;
    for (const { reply } of replies) {
      if (!reply.ok) continue;
      const counts = reply.value as { delivered?: number; replied?: number };
      delivered += counts.delivered ?? 0;
      replied += counts.replied ?? 0;
    }
    return { delivered, replied };
  }
  const answered = replies.filter((r) => r.reply.ok);
  if (answered.length === 0) {
    const firstReply = replies[0]?.reply;
    throw new Error(
      firstReply !== undefined && !firstReply.ok ? firstReply.reason : "Weaving did not answer.",
    );
  }
  const items = answered
    .flatMap(({ environment, reply }) =>
      ((reply as { value: { items?: ReadonlyArray<BatonWeave> } }).value.items ?? []).map((w) =>
        // A session on another computer is named with that computer.
        environment.id === first?.id ? w : { ...w, toLabel: `${environment.label}:${w.toLabel}` },
      ),
    )
    .toSorted((a, b) => b.createdAt - a.createdAt);
  const limit = (request.args as { limit?: unknown }).limit;
  return { items: typeof limit === "number" ? items.slice(0, limit) : items };
};
