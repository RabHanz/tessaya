/**
 * Cloud tasks in the desktop: picks the providers for the transport chosen (this computer, a hub, or the
 * shared-computer way), keeps what the window shows (requests, usage, what each harness can do) and runs
 * the approval card's clicks. The rules are in `@t3tools/tessaya-shared/cloud`; this holds state and I/O.
 */
import { buildLocalProviders } from "@t3tools/tessaya-shared/cloud/build";
import type { LocalSettings } from "@t3tools/tessaya-shared/cloud/local";
import {
  CARD_START,
  fromSpoken,
  offerQuestion,
  reduceCard,
  type CardEvent,
  type CardState,
} from "@t3tools/tessaya-shared/cloud/card";
import { sshProviders } from "@t3tools/tessaya-shared/cloud/sshShell";
import { hubProvider, type CloudOp, type Described } from "@t3tools/tessaya-shared/cloud/hub";
import { providerChoices, type ProviderChoice } from "@t3tools/tessaya-shared/cloud/registry";
import { STUBS } from "@t3tools/tessaya-shared/cloud/stubs";
import {
  BRIEF_MAX,
  type CloudProvider,
  type CloudRequest,
  type Detection,
  type Exec,
  type Outcome,
  type ProviderId,
  type TransportKind,
  type Usage,
} from "@t3tools/tessaya-shared/cloud/types";
import { fileStores } from "@t3tools/tessaya-shared/cloud/nodeExec";
import { text } from "../home/strings.ts";

export interface CloudSettings {
  readonly on: boolean;
  readonly transport: TransportKind;
  /** Codex needs the environment its task runs in. */
  readonly codexEnv: string;
  readonly sshHost: string;
  readonly sshUser: string;
  /** Key file paths, never keys. */
  readonly machineKey: string;
  readonly approverKey: string;
  /** Names of vault items holding the keys instead of files; the vault wins when both are set. */
  readonly machineKeyVault: string;
  readonly approverKeyVault: string;
  /** Which connected computer runs cloud tasks (transport 2); empty is the one this window is on. */
  readonly hubEnv: string;
  /** A run that uses more than this many points of its own provider's weekly figure is flagged. */
  readonly capPoints: number;
  /** Also ask with a pop-up (mirrored to a paired phone) for each waiting task. */
  readonly askPopup: boolean;
}

export const DEFAULT_CLOUD: CloudSettings = {
  on: false,
  transport: "local",
  codexEnv: "",
  sshHost: "",
  sshUser: "",
  machineKey: "",
  approverKey: "",
  machineKeyVault: "",
  approverKeyVault: "",
  hubEnv: "",
  capPoints: 2,
  askPopup: false,
};

export type HubCall = (
  op: CloudOp,
  provider: ProviderId | "",
  args: Readonly<Record<string, unknown>>,
) => Promise<Outcome<unknown>>;

export interface CloudDeps {
  readonly settings: () => CloudSettings;
  /** T3's instances with their weekly figures, read from this machine's server (D2). */
  readonly weekly?: LocalSettings["weekly"];
  readonly exec: Exec;
  /** Where the local transport keeps its small files. */
  readonly dir: string;
  /** The connection to the computer that runs cloud tasks (transport 2); null when there is none. */
  readonly hub: HubCall | null;
  /** The computers this window is connected to, for the picker. */
  readonly environments?: () => Promise<
    ReadonlyArray<{ readonly id: string; readonly label: string }>
  >;
  /** The Director's yes, on a dialog the assistant cannot click: the index of the button he pressed. */
  readonly ask: (input: {
    title: string;
    detail: string;
    buttons: ReadonlyArray<string>;
    cancel: number;
    armMs: number;
    everywhere?: boolean;
  }) => Promise<number>;
  readonly changed: () => void;
  readonly now: () => number;
  /** A key from the vault for one call (Hello-gated), or null when no vault key is named. */
  readonly vaultKey?: (
    name: string,
    why: string,
  ) => Promise<
    | { readonly ok: true; readonly path: string; readonly done: () => void }
    | { readonly ok: false; readonly error: string }
  >;
}

export const NOT_SET_UP = "Cloud tasks are not set up on this computer. Turn them on under Cloud.";

export interface CloudView {
  readonly on: boolean;
  readonly transport: TransportKind;
  readonly providers: ReadonlyArray<CloudProvider>;
  readonly choices: ReadonlyArray<ProviderChoice>;
  readonly requests: ReadonlyArray<CloudRequest>;
  readonly usage: ReadonlyArray<Usage>;
  readonly detections: Readonly<Partial<Record<ProviderId, Detection>>>;
  readonly error: string | null;
  readonly loadedAt: number | null;
  readonly cards: ReadonlyMap<string, CardState>;
  readonly environments: ReadonlyArray<{ readonly id: string; readonly label: string }>;
  /** The last connection test, in lines for a person; null before one is run. */
  readonly tested: ReadonlyArray<{ readonly ok: boolean; readonly line: string }> | null;
}

export const requestKey = (r: Pick<CloudRequest, "provider" | "id">): string =>
  `${r.provider}:${r.id}`;

export const createCloud = (deps: CloudDeps) => {
  let usage: ReadonlyArray<Usage> = [];
  let requests: ReadonlyArray<CloudRequest> = [];
  let detections: Partial<Record<ProviderId, Detection>> = {};
  let error: string | null = null;
  let loadedAt: number | null = null;
  const cards = new Map<string, CardState>();
  let hubProviders: ReadonlyArray<CloudProvider> = [];
  let environments: ReadonlyArray<{ readonly id: string; readonly label: string }> = [];
  let tested: ReadonlyArray<{ readonly ok: boolean; readonly line: string }> | null = null;

  // Built once per set of settings, because a harness remembers who is signed in between calls.
  let built: { readonly sig: string; readonly list: ReadonlyArray<CloudProvider> } | null = null;
  const providers = (): ReadonlyArray<CloudProvider> => {
    const s = deps.settings();
    if (s.transport === "hub") return hubProviders;
    const sig = JSON.stringify([
      s.transport,
      s.hubEnv,
      s.codexEnv,
      s.sshHost,
      s.sshUser,
      s.machineKey,
      s.approverKey,
      s.machineKeyVault,
      s.approverKeyVault,
    ]);
    if (built?.sig === sig) return built.list;
    const list =
      s.transport === "ssh"
        ? sshProviders(
            {
              host: s.sshHost,
              user: s.sshUser,
              machineKey: s.machineKey,
              approverKey: s.approverKey,
              ...(deps.vaultKey === undefined ||
              (s.machineKeyVault === "" && s.approverKeyVault === "")
                ? {}
                : {
                    keyFor: async (role: "machine" | "approver") => {
                      const name = role === "machine" ? s.machineKeyVault : s.approverKeyVault;
                      if (name === "") return null;
                      const used = await deps.vaultKey!(
                        name,
                        role === "approver" ? "Approve a cloud task" : "Send a cloud task",
                      );
                      return used.ok ? { path: used.path, done: used.done } : { error: used.error };
                    },
                  }),
            },
            deps.exec,
          )
        : [
            ...buildLocalProviders(deps.exec, fileStores(deps.dir), {
              codexEnv: s.codexEnv,
              ...(deps.weekly === undefined ? {} : { weekly: deps.weekly }),
            }).values(),
            ...STUBS,
          ];
    built = { sig, list };
    return list;
  };

  const find = (id: ProviderId): CloudProvider | undefined => providers().find((p) => p.id === id);

  const ready = (): ReadonlySet<ProviderId> =>
    new Set(
      providers().flatMap((p) =>
        p.setup().state === "ready" &&
        detections[p.id]?.installed === true &&
        detections[p.id]?.signedIn === true
          ? [p.id]
          : [],
      ),
    );

  const view = (): CloudView => {
    const s = deps.settings();
    const list = providers();
    return {
      on: s.on,
      transport: s.transport,
      providers: list,
      choices: providerChoices(list, usage, ready()),
      requests,
      usage,
      detections,
      error,
      loadedAt,
      cards,
      environments,
      tested,
    };
  };

  const refresh = async (): Promise<void> => {
    const s = deps.settings();
    if (!s.on) return;
    error = null;
    if (s.transport === "hub") {
      environments = (await deps.environments?.().catch(() => [])) ?? [];
      if (deps.hub === null) {
        error = "There is no connection to a computer that runs cloud tasks.";
        hubProviders = [];
      } else {
        const hub = deps.hub;
        const d = await hub("describe", "", {});
        if (!d.ok) {
          error = d.error;
          hubProviders = [];
        } else {
          hubProviders = (d.value as ReadonlyArray<Described>).map((x) => hubProvider(x, hub));
        }
      }
    }
    const list = providers();
    const found: Partial<Record<ProviderId, Detection>> = {};
    const reqs: CloudRequest[] = [];
    const uses: Usage[] = [];
    // Every assistant of one transport shares one list of requests: ask for it once.
    let askedShared = false;
    for (const p of list) {
      found[p.id] = await p.detect();
      if (p.setup().state !== "ready" || found[p.id]?.signedIn !== true) continue;
      // One transport, one list of requests, whichever assistant is asked.
      if (askedShared) {
        const u = await p.usage();
        if (u.ok)
          uses.push(
            ...u.value.filter(
              (x) => !uses.some((y) => y.provider === x.provider && y.account === x.account),
            ),
          );
        continue;
      }
      askedShared = true;
      const l = await p.list({});
      if (l.ok)
        reqs.push(
          ...l.value.filter((r) => !reqs.some((x) => x.id === r.id && x.provider === r.provider)),
        );
      else error = error ?? l.error;
      const u = await p.usage();
      if (u.ok)
        uses.push(
          ...u.value.filter(
            (x) => !uses.some((y) => y.provider === x.provider && y.account === x.account),
          ),
        );
    }
    detections = found;
    requests = reqs;
    usage = uses;
    loadedAt = deps.now();
    offerNew();
    // A card whose request is gone or answered forgets its state.
    for (const k of cards.keys())
      if (!reqs.some((r) => requestKey(r) === k && r.state === "awaiting-director"))
        cards.delete(k);
    deps.changed();
  };

  const cardEvent = (key: string, e: CardEvent): CardState => {
    const next = reduceCard(cards.get(key) ?? CARD_START, e, view().choices);
    cards.set(key, next);
    return next;
  };

  const runApprove = async (key: string): Promise<Outcome<null>> => {
    const state = cards.get(key);
    if (state?.phase !== "confirm") return { ok: false, error: "Left as it was." };
    const id = key.slice(key.indexOf(":") + 1);
    // The assistant he chose on the card runs it, which for a shared list need not be the one that made the request.
    const p = find(state.provider);
    if (p === undefined) return { ok: false, error: "Left as it was." };
    cardEvent(key, { type: "confirm" });
    deps.changed();
    const done = await p.approve(id, state.account, `card-${id}`);
    if (done.ok) cardEvent(key, { type: "approved" });
    else cardEvent(key, { type: "failed", message: done.error });
    await refresh();
    return done.ok ? { ok: true, value: null } : { ok: false, error: done.error };
  };

  /** The ones already put to him as a question, so each is asked once. */
  const offered = new Set<string>();
  /**
   * One question with a button for each open assistant and account; choosing one asks to confirm; only
   * then does anything start. The question is also mirrored to a paired phone, which never holds a key.
   */
  const offer = async (r: CloudRequest): Promise<void> => {
    const key = requestKey(r);
    for (let round = 0; round < 5; round += 1) {
      const q = offerQuestion(view().choices, {
        pick: (label, account, usage) => text("cloud.offer.pick", { label, account, usage }),
        deny: text("cloud.offer.deny"),
        later: text("cloud.offer.later"),
      });
      if (q.picks.length === 2) return;
      const pressed = await deps.ask({
        title: text("cloud.offer.title", { task: r.task ?? r.id }),
        detail: describeRequest(r) + (r.fromWeb ? `\n\n${text("cloud.fromweb")}` : ""),
        buttons: q.buttons,
        cancel: q.cancel,
        armMs: 1_500,
        everywhere: true,
      });
      const pick = q.picks[pressed] ?? { kind: "later" as const };
      if (pick.kind === "later") return;
      if (pick.kind === "deny") {
        const p = find(r.provider);
        if ((await p?.deny(r.id, "denied in Tessaya"))?.ok === true)
          cardEvent(key, { type: "deny" });
        await refresh();
        return;
      }
      cardEvent(key, { type: "provider", provider: pick.provider });
      cardEvent(key, { type: "account", account: pick.account });
      const yes = await deps.ask({
        title: text("cloud.offer.confirmTitle", { account: pick.account }),
        detail: describeRequest(r),
        buttons: [text("cloud.offer.approve"), text("cloud.offer.back")],
        cancel: 1,
        armMs: 1_500,
        everywhere: true,
      });
      if (yes === 0) {
        await runApprove(key);
        return;
      }
      cards.delete(key);
    }
  };
  const inflight: Promise<void>[] = [];
  const offerNew = (): void => {
    if (!deps.settings().askPopup) return;
    for (const r of requests) {
      const key = requestKey(r);
      if (r.state !== "awaiting-director" || offered.has(key)) continue;
      offered.add(key);
      inflight.push(offer(r).catch(() => undefined));
    }
  };

  /** Asks every assistant for its accounts and use. Starts nothing. */
  const test = async (): Promise<void> => {
    tested = null;
    deps.changed();
    await refresh();
    const lines: Array<{ ok: boolean; line: string }> = [];
    if (error !== null) lines.push({ ok: false, line: text("cloud.test.none", { why: error }) });
    for (const p of providers()) {
      if (detections[p.id]?.signedIn !== true) continue;
      for (const u of usage.filter((x) => x.provider === p.id)) {
        const usageText = u.rejected
          ? "rejected"
          : u.weeklyPercent === null
            ? "usage unknown"
            : `${u.weeklyPercent}% used${u.resetsAt === null ? "" : `, resets ${u.resetsAt}`}`;
        lines.push({
          ok: !u.rejected && u.login !== "expired" && u.login !== "not-logged-in",
          line: text("cloud.test.account", {
            provider: p.label,
            account: u.account,
            usage: usageText,
            login: u.login === undefined ? "" : text("cloud.test.login", { login: u.login }),
          }),
        });
      }
    }
    if (lines.length === 0)
      lines.push({
        ok: false,
        line: text("cloud.test.none", {
          why: Object.values(detections)
            .map((d) => d?.line)
            .filter(Boolean)
            .join(" "),
        }),
      });
    else if (lines.every((l) => l.ok)) lines.unshift({ ok: true, line: text("cloud.test.ok") });
    tested = lines;
    deps.changed();
  };

  const guard = (): string | null => (deps.settings().on ? null : NOT_SET_UP);

  return {
    view,
    refresh,
    test,
    /** Resolves when every question put to him has been answered or left. */
    settled: async (): Promise<void> => void (await Promise.all(inflight.splice(0))),
    /** A click on the card: ids are `cl.p|a|ok|deny:<provider>:<id>[:<provider or account>]`. */
    click: async (cardId: string): Promise<void> => {
      const m = /^cl\.(p|a|ok|deny)\.([a-z]+):([^:]+)(?::(.+))?$/.exec(cardId);
      if (m === null) return;
      const [, verb, provider, id, rest] = m as unknown as [
        string,
        string,
        ProviderId,
        string,
        string | undefined,
      ];
      const key = `${provider}:${id}`;
      if (verb === "p")
        cardEvent(key, { type: "provider", provider: (rest ?? provider) as ProviderId });
      else if (verb === "a") cardEvent(key, { type: "account", account: rest ?? "" });
      else if (verb === "ok") {
        if (rest === "later") cardEvent(key, { type: "back" });
        else await runApprove(key);
      } else if (verb === "deny") {
        const p = find(provider);
        const out = p === undefined ? null : await p.deny(id, "denied in Tessaya");
        if (out?.ok === true) cardEvent(key, { type: "deny" });
        await refresh();
      }
      deps.changed();
    },
    /** Assistant tools. Each returns a sentence for the assistant to say. */
    tool: {
      dispatch: async (a: {
        provider?: string;
        repo: string;
        branch: string;
        brief: string;
        label?: string;
        fromWeb?: boolean;
        expectedUsage?: number;
      }): Promise<string> => {
        const no = guard();
        if (no !== null) return no;
        await refresh();
        const choices = view().choices.filter((c) => c.enabled);
        const pid = (a.provider as ProviderId | undefined) ?? choices[0]?.id;
        const p = pid === undefined ? undefined : find(pid);
        if (p === undefined)
          return "No cloud provider is ready here. Turn one on and sign in under Cloud.";
        if (a.brief.length > BRIEF_MAX) return `A cloud brief is at most ${BRIEF_MAX} characters.`;
        const cap = deps.settings().capPoints;
        if (a.expectedUsage !== undefined && a.expectedUsage > cap)
          return `That is expected to use ${a.expectedUsage} points of the week, over his cap of ${cap}. Split it into smaller tasks, or ask him to raise the cap under Cloud.`;
        const out = await p.dispatch({
          repo: a.repo,
          branch: a.branch,
          brief: a.brief,
          ...(a.label === undefined ? {} : { label: a.label }),
          ...(a.expectedUsage === undefined ? {} : { expectedUsage: a.expectedUsage }),
          fromWeb: a.fromWeb === true,
        });
        if (!out.ok) return out.error;
        await refresh();
        return `Request ${out.value.id} is waiting for his answer on ${p.label}. Nothing runs until he picks an account on the card in Approvals.`;
      },
      status: async (id: string, provider?: string): Promise<string> => {
        const no = guard();
        if (no !== null) return no;
        const p =
          provider === undefined
            ? providers().find((x) => x.setup().state === "ready")
            : find(provider as ProviderId);
        if (p === undefined) return "No cloud provider is ready here.";
        const out = await p.status(id);
        return out.ok ? describeRequest(out.value) : out.error;
      },
      list: async (mine: boolean, label?: string): Promise<string> => {
        const no = guard();
        if (no !== null) return no;
        const rows: string[] = [];
        for (const p of providers()) {
          if (p.setup().state !== "ready") continue;
          const out = await p.list({ mine, ...(label === undefined ? {} : { label }) });
          if (out.ok) rows.push(...out.value.map(describeRequest));
        }
        return rows.length === 0 ? "No cloud requests." : rows.join("\n");
      },
      cancel: async (id: string, provider?: string): Promise<string> => {
        const no = guard();
        if (no !== null) return no;
        const p =
          provider === undefined
            ? providers().find((x) => x.setup().state === "ready")
            : find(provider as ProviderId);
        if (p === undefined) return "No cloud provider is ready here.";
        const out = await p.cancel(id);
        await refresh();
        return out.ok ? "Withdrawn." : out.error;
      },
      usage: async (): Promise<string> => {
        const no = guard();
        if (no !== null) return no;
        await refresh();
        return usage.length === 0
          ? "No cloud usage figures are available."
          : usage
              .map(
                (u) =>
                  `${u.provider} ${u.account}: ${u.rejected ? "rejected" : u.weeklyPercent === null ? "usage unknown" : `${u.weeklyPercent}% used this week`}${u.resetsAt === null ? "" : `, resets ${u.resetsAt}`}`,
              )
              .join("\n");
      },
      /**
       * 'approve cloud request 3 on <account>': only reads the card back and asks him on a dialog the assistant
       * cannot press. The account must be named. Nothing is approved without his button.
       */
      approve: async (id: string, account: string, provider?: string): Promise<string> => {
        const no = guard();
        if (no !== null) return no;
        await refresh();
        const request = requests.find(
          (r) =>
            r.id === id &&
            (provider === undefined || r.provider === provider) &&
            r.state === "awaiting-director",
        );
        if (request === undefined) return "That cloud request is not waiting for an answer.";
        const spoken = fromSpoken(view().choices, { provider: request.provider, account });
        if ("refused" in spoken) return spoken.refused;
        const key = requestKey(request);
        cards.set(key, spoken.state);
        deps.changed();
        const pressed = await deps.ask({
          title: "Approve a cloud task?",
          detail: `${describeRequest(request)}\n\n${spoken.readBack}`,
          buttons: ["Approve", "Not now"],
          cancel: 1,
          armMs: 1_500,
        });
        if (pressed !== 0) return "Left as it was. Nothing was approved.";
        const done = await runApprove(key);
        return done.ok ? `Approved on ${account}.` : done.error;
      },
    },
  };
};

export const describeRequest = (r: CloudRequest): string =>
  `${r.provider} request ${r.id} (${r.state}): ${r.task ?? "no title"}${r.repo === null ? "" : `, ${r.repo}`}${r.branch === null ? "" : `@${r.branch}`}${r.account === null ? "" : `, on ${r.account}`}${r.result?.url == null ? "" : `, ${r.result.url}`}${r.sessionLink === null ? "" : `, ${r.sessionLink}`}`;
