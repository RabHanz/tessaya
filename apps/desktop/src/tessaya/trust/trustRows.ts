// @effect-diagnostics globalDate:off
/**
 * The Trust page: every permission Tessaya has right now in plain words, when each was last used, a
 * one-click revoke for each, and one log of what it did on his behalf. Pure: the logs go in as text.
 */
import type { HomeControl } from "../home/tessayaHome.ts";

export type TrustKind = "action" | "social" | "vault" | "weave" | "playbook";
export type TrustFilter = "all" | TrustKind;

export interface TrustEntry {
  readonly at: string;
  readonly kind: TrustKind;
  readonly text: string;
  readonly outcome: string;
}

const obj = (raw: string): Record<string, unknown> | null => {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};
const s = (v: unknown, max = 140): string => (typeof v === "string" ? v.slice(0, max) : "");
const lines = (raw: string) => raw.split("\n").filter((l) => l.trim() !== "");

/** Newest first. Never reads a typed or dictated word: action names, hosts and secret names only. */
export const parseTrustLogs = (files: {
  readonly turns: string;
  readonly social: string;
  readonly vault: string;
}): ReadonlyArray<TrustEntry> => {
  const out: TrustEntry[] = [];
  for (const l of lines(files.turns)) {
    const o = obj(l);
    if (o !== null && o["kind"] === "playbook" && s(o["at"]) !== "") {
      out.push({
        at: s(o["at"]),
        kind: "playbook",
        text: s(o["text"], 200) || s(o["playbook"]),
        outcome: s(o["text"]).startsWith("Failed") ? "failed" : "ran",
      });
      continue;
    }
    if (o === null || o["kind"] !== "action" || s(o["at"]) === "" || s(o["tool"]) === "") continue;
    const tool = s(o["tool"]);
    out.push({
      at: s(o["at"]),
      kind: tool === "weave_send" ? "weave" : "action",
      text: `${o["by"] === "remote-hands" ? "remote: " : ""}${tool.replace(/^mcp__/, "")}${s(o["action"]) === "" ? "" : `: ${s(o["action"])}`}`,
      outcome: s(o["outcome"]) || "ran",
    });
  }
  for (const l of lines(files.social)) {
    const o = obj(l);
    if (o === null || s(o["at"]) === "") continue;
    out.push({
      at: s(o["at"]),
      kind: "social",
      text: `${s(o["action"]) || s(o["tool"])} on ${s(o["host"])}`,
      outcome: s(o["outcome"]) || "ran",
    });
  }
  for (const l of lines(files.vault)) {
    const o = obj(l);
    if (o === null || s(o["at"]) === "") continue;
    out.push({
      at: s(o["at"]),
      kind: "vault",
      text: `${s(o["name"])} for ${s(o["purpose"]) || "a task"}${s(o["target"]) === "" ? "" : ` at ${s(o["target"])}`}`,
      outcome: s(o["outcome"]) || "used",
    });
  }
  return out.toSorted((a, b) => Date.parse(b.at) - Date.parse(a.at));
};

export type Permission = "screen" | "chrome" | "social" | "vault" | "act" | "remote";

/** The newest time each permission was exercised, from the same logs. */
export const lastUsed = (
  entries: ReadonlyArray<TrustEntry>,
): Readonly<Partial<Record<Permission | "weave", string>>> => {
  const seen: Partial<Record<Permission | "weave", string>> = {};
  const note = (key: Permission | "weave", at: string) => {
    if (seen[key] === undefined) seen[key] = at;
  };
  for (const e of entries) {
    if (e.outcome === "refused" || e.outcome === "declined") continue;
    if (e.kind === "social") note("social", e.at);
    else if (e.kind === "vault") note("vault", e.at);
    else if (e.kind === "weave") note("weave", e.at);
    else if (e.text.startsWith("remote: ")) note("remote", e.at);
    else if (/screen_capture/.test(e.text)) note("screen", e.at);
    else if (/chrome/i.test(e.text)) note("chrome", e.at);
  }
  return seen;
};

export interface TrustData {
  readonly screenAlways: boolean;
  readonly chrome: boolean;
  readonly social: boolean;
  readonly act: boolean;
  readonly remote: boolean;
  readonly vault: "none" | "locked" | "unlocked";
  readonly grants: ReadonlyArray<{
    readonly jobId: string;
    readonly title: string;
    readonly channel: string;
    readonly since: string;
  }>;
  /** Every standing job: the built-in ones that run here, his rules, and jobs on a schedule. */
  readonly standing: ReadonlyArray<StandingRow>;
  readonly entries: ReadonlyArray<TrustEntry>;
  readonly filter: TrustFilter;
}

const PERMS = "What Tessaya may do";
const STANDING = "Standing permissions on jobs";
const LOG = "What it did for you";
const PLAYS = "Standing jobs";

export interface StandingRow {
  /** "user": one of his own (KIRO-1), editable and removable here. */
  readonly kind: "built_in" | "rule" | "schedule" | "user";
  /** A built-in job's id, a rule's id, or a scheduled job's id. */
  readonly id: string;
  readonly title: string;
  readonly what: string;
  /** The persona it runs as, by name. */
  readonly owner: string;
  /** Null for a schedule, which is taken off rather than switched. */
  readonly on: boolean | null;
  /** Runs so far; for a schedule, its worker's turns so far. */
  readonly count: number;
  /** A timed built-in job: what happens when its hour passed while Tessaya was off. */
  readonly missed?: "once" | "skip";
  /** A built-in event job: stays quiet unless what it would report changed. */
  readonly quiet?: boolean;
  /** His own job: what it does each time, editable here. */
  readonly instruction?: string;
  /** His own job a device or another agent proposed: off until he switches it on. */
  readonly proposed?: boolean;
  /** Who wrote its words; a device's are run as data until he rewrites them. */
  readonly from?: "him" | "device";
  /** His own job's last run: an error or a time-out gets "Ask why". */
  readonly lastRun?: {
    readonly status: "ok" | "error" | "timeout" | "cancelled";
    readonly at: number;
  };
}

const ranLine = (n: number) => `Ran ${n === 1 ? "once" : `${n} times`}.`;

export const FILTERS: ReadonlyArray<{ value: TrustFilter; label: string }> = [
  { value: "all", label: "Everything" },
  { value: "action", label: "Actions on this computer" },
  { value: "social", label: "Social accounts" },
  { value: "vault", label: "Vault" },
  { value: "weave", label: "Messages to other sessions" },
  { value: "playbook", label: "Things it did by itself" },
];

const CHANNEL_WORDS: Readonly<Record<string, string>> = {
  start: "start without waiting for your OK",
  retry: "retry a failed worker by itself",
  email: "send email",
  social: "post on social accounts",
  chat: "send chat messages",
  pr_comment: "comment on pull requests",
  other_public: "send other public messages",
};

export const ago = (iso: string | undefined, now: number): string => {
  if (iso === undefined) return "never used that I can see";
  const m = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  return m < 1
    ? "last used just now"
    : m < 120
      ? `last used ${m} min ago`
      : m < 2880
        ? `last used ${Math.round(m / 60)} h ago`
        : `last used ${Math.round(m / 1440)} days ago`;
};

/** One of his own jobs: on or off (switching on approves a proposal), what it does, and a way to remove it. */
const userJobRows = (j: StandingRow): ReadonlyArray<HomeControl> => [
  {
    id: `trust.userjob:${j.id}`,
    section: PLAYS,
    label: j.proposed === true ? `${j.title} (proposed, not yet yours)` : j.title,
    hint:
      j.proposed === true
        ? `A paired device or another agent proposed this. ${j.what} Switch it on to set it up; it runs as ${j.owner}.`
        : `${j.what} ${j.owner}'s standing job${j.from === "device" ? ", in words a device wrote (run as data, not as yours, until you rewrite them)" : ", yours"}. ${ranLine(j.count)} It only reads and reports.`,
    kind: "toggle",
    on: j.on === true,
  },
  {
    id: `trust.userjobtext:${j.id}`,
    section: PLAYS,
    label: "What it does each time",
    kind: "editor",
    text: j.instruction ?? "",
    // Nothing to go back to: his own words are the only version.
    mine: false,
  },
  ...(j.lastRun !== undefined && (j.lastRun.status === "error" || j.lastRun.status === "timeout")
    ? [
        {
          id: `trust.userjobwhy:${j.id}`,
          section: PLAYS,
          label: `Its last run ${j.lastRun.status === "error" ? "failed" : "ran out of time"}`,
          kind: "action" as const,
          button: "Ask why",
        },
      ]
    : []),
  {
    id: `trust.userjobdel:${j.id}`,
    section: PLAYS,
    label: "Remove this job",
    kind: "action",
    button: "Remove",
  },
];

const standingRow = (j: StandingRow): HomeControl => {
  const counted = j.kind === "schedule" ? `Used ${j.count} turns so far.` : ranLine(j.count);
  const hint = `${j.what} ${j.owner}'s standing job. ${counted}`.trim();
  return j.on === null
    ? {
        id: `trust.schedule:${j.id}`,
        section: PLAYS,
        label: j.title,
        hint,
        kind: "action",
        button: "Take off",
      }
    : {
        id: `trust.${j.kind === "rule" ? "rule" : "standing"}:${j.id}`,
        section: PLAYS,
        label: j.title,
        hint: `${hint}${j.kind === "built_in" ? " Never sends, posts or spends." : ""}`,
        kind: "toggle",
        on: j.on,
      };
};

export const trustControls = (data: TrustData, now: number): ReadonlyArray<HomeControl> => {
  const used = lastUsed(data.entries);
  const row = (
    key: Permission,
    label: string,
    on: boolean,
    onText: string,
    offText: string,
    button: string,
  ): HomeControl =>
    on
      ? {
          id: `trust.revoke:${key}`,
          section: PERMS,
          label,
          hint: `${onText} (${ago(used[key], now)}).`,
          kind: "action",
          button,
        }
      : {
          id: `trust.off:${key}`,
          section: PERMS,
          label,
          kind: "check",
          status: "ok",
          detail: offText,
        };
  const rows: HomeControl[] = [
    row(
      "screen",
      "Look at your screen without asking",
      data.screenAlways,
      "It may take a screenshot whenever it needs to",
      "Off: it asks before it looks at your screen.",
      "Ask first again",
    ),
    row(
      "chrome",
      "Use your Chrome",
      data.chrome,
      "It may read and use pages in your own Chrome; a send, purchase or delete still asks aloud",
      "Off: it does not touch your browser.",
      "Turn off",
    ),
    row(
      "social",
      "Use social accounts in Chrome",
      data.social,
      "It may work on social sites you are signed in to; every post asks aloud",
      "Off: social sites are refused.",
      "Turn off",
    ),
    row(
      "act",
      "Do routine steps without asking",
      data.act,
      "Routine steps run on their own; anything that deletes, sends, pays or publishes still asks",
      "Off: it asks before each step that changes something.",
      "Ask every time",
    ),
    row(
      "remote",
      "Let a remote session drive this computer",
      data.remote,
      "A session you gave remote hands may read windows and use their controls; anything risky still asks",
      "Off: no remote session can act here.",
      "Turn off",
    ),
    data.vault === "unlocked"
      ? {
          id: "trust.revoke:vault",
          section: PERMS,
          label: "Vault is open",
          hint: `It can use a secret you allow, without seeing it (${ago(used.vault, now)}).`,
          kind: "action",
          button: "Lock now",
        }
      : {
          id: "trust.off:vault",
          section: PERMS,
          label: "Vault",
          kind: "check",
          status: "ok",
          detail: data.vault === "none" ? "There is no vault." : "Locked: nothing can be used.",
        },
    {
      id: "trust.off:weave",
      section: PERMS,
      label: "Messages to your other machines",
      kind: "check",
      status: "ok",
      detail: `May message sessions on every computer this app is connected to (${ago(used.weave, now)}). Remove a computer in Settings → Environments to stop it.`,
    },
  ];
  rows.push(
    ...(data.grants.length === 0
      ? [
          {
            id: "trust.off:grants",
            section: STANDING,
            label: "None given",
            kind: "check" as const,
            status: "ok" as const,
            detail: "Every job asks before it sends anything public.",
          },
        ]
      : data.grants.map((g): HomeControl => ({
          id: `trust.revoke:grant:${g.jobId}:${g.channel}`,
          section: STANDING,
          label: `${g.title}: ${CHANNEL_WORDS[g.channel] ?? g.channel}`,
          hint: `Given ${g.since.slice(0, 10)}. Stays until you take it back.`,
          kind: "action",
          button: "Revoke",
        }))),
  );
  rows.push(
    ...data.standing.flatMap((j): ReadonlyArray<HomeControl> => [
      ...(j.kind === "user" ? userJobRows(j) : [standingRow(j)]),
      ...(j.missed === undefined
        ? []
        : [
            {
              id: `trust.missed:${j.id}`,
              section: PLAYS,
              label: "If Tessaya was off at that hour",
              hint:
                j.missed === "once"
                  ? "It runs once when she is back, the same day."
                  : "It skips that day.",
              kind: "choice" as const,
              value: j.missed,
              options: [
                { value: "once", label: "Run once when back" },
                { value: "skip", label: "Skip that day" },
              ],
            },
          ]),
      ...(j.quiet === undefined
        ? []
        : [
            {
              id: `trust.quiet:${j.id}`,
              section: PLAYS,
              label: "Quiet unless it changed",
              hint: "When what it would report is the same as last time, it keeps the run and says nothing.",
              kind: "toggle" as const,
              on: j.quiet,
            },
          ]),
    ]),
  );
  rows.push({
    id: "trust.filter",
    section: LOG,
    label: "Show",
    kind: "choice",
    value: data.filter,
    options: FILTERS.map((f) => ({ value: f.value, label: f.label })),
  });
  const shown = data.entries
    .filter((e) => data.filter === "all" || e.kind === data.filter)
    .slice(0, 60);
  rows.push(
    ...(shown.length === 0
      ? [
          {
            id: "trust.log.empty",
            section: LOG,
            label: "Nothing here yet",
            kind: "check" as const,
            status: "ok" as const,
            detail: "Nothing it did on your behalf matches.",
          },
        ]
      : shown.map((e, i): HomeControl => ({
          id: `trust.log:${i}`,
          section: LOG,
          label: e.text,
          kind: "check",
          status: e.outcome === "refused" || e.outcome === "failed" ? "warn" : "ok",
          detail: `${new Date(e.at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}, ${e.outcome}`,
        }))),
  );
  return rows;
};

export type TrustAction =
  | { readonly kind: "revoke"; readonly what: Permission }
  | { readonly kind: "grant"; readonly jobId: string; readonly channel: string }
  | { readonly kind: "filter"; readonly filter: TrustFilter }
  | {
      readonly kind: "standing" | "rule";
      readonly id: string;
      readonly on: boolean;
    }
  | { readonly kind: "unschedule"; readonly jobId: string }
  | { readonly kind: "missed"; readonly id: string; readonly missed: "once" | "skip" }
  | { readonly kind: "quiet"; readonly id: string; readonly on: boolean }
  | { readonly kind: "userJob"; readonly id: string; readonly on: boolean }
  | { readonly kind: "userJobText"; readonly id: string; readonly text: string }
  | { readonly kind: "userJobDelete"; readonly id: string }
  | { readonly kind: "userJobWhy"; readonly id: string };

export const trustAction = (id: string, value: unknown): TrustAction | null => {
  if (id === "trust.filter") {
    const f = FILTERS.find((x) => x.value === value);
    return f === undefined ? null : { kind: "filter", filter: f.value };
  }
  const uj = /^trust\.userjob:(user:\d+)$/.exec(id);
  if (uj !== null) return { kind: "userJob", id: uj[1]!, on: value === true };
  const ut = /^trust\.userjobtext:(user:\d+):save$/.exec(id);
  if (ut !== null)
    return typeof value === "string" && value.trim() !== ""
      ? { kind: "userJobText", id: ut[1]!, text: value.trim().slice(0, 1_000) }
      : null;
  const uw = /^trust\.userjobwhy:(user:\d+)$/.exec(id);
  if (uw !== null) return { kind: "userJobWhy", id: uw[1]! };
  const ud = /^trust\.userjobdel:(user:\d+)$/.exec(id);
  if (ud !== null) return { kind: "userJobDelete", id: ud[1]! };
  const sj = /^trust\.(standing|rule):(.+)$/.exec(id);
  if (sj !== null) return { kind: sj[1] as "standing" | "rule", id: sj[2]!, on: value === true };
  const mr = /^trust\.missed:(.+)$/.exec(id);
  if (mr !== null)
    return value === "once" || value === "skip"
      ? { kind: "missed", id: mr[1]!, missed: value }
      : null;
  const qu = /^trust\.quiet:(.+)$/.exec(id);
  if (qu !== null) return { kind: "quiet", id: qu[1]!, on: value === true };
  const un = /^trust\.schedule:(.+)$/.exec(id);
  if (un !== null) return { kind: "unschedule", jobId: un[1]! };
  const m = /^trust\.revoke:(screen|chrome|social|vault|act|remote)$/.exec(id);
  if (m !== null) return { kind: "revoke", what: m[1] as Permission };
  const g = /^trust\.revoke:grant:(.+):([a-z_]+)$/.exec(id);
  return g === null ? null : { kind: "grant", jobId: g[1]!, channel: g[2]! };
};

/** The permissions in plain sentences, for 'show me what you can access'. */
export const describeTrust = (data: TrustData, now: number): string => {
  const used = lastUsed(data.entries);
  const line = (on: boolean, name: string, key: Permission | "weave") =>
    `${name}: ${on ? "on" : "off"}${on ? ` (${ago(used[key], now)})` : ""}.`;
  return [
    line(data.screenAlways, "Looking at your screen without asking", "screen"),
    line(data.chrome, "Your Chrome", "chrome"),
    line(data.social, "Social accounts in Chrome", "social"),
    line(data.act, "Routine steps without asking", "act"),
    line(data.remote, "Remote hands", "remote"),
    `Vault: ${data.vault === "unlocked" ? "open" : data.vault === "locked" ? "locked" : "none"}.`,
    "Messages may go to every computer this app is connected to.",
    data.grants.length === 0
      ? "No job holds a standing permission."
      : `Standing permissions: ${data.grants.map((g) => `${g.title} (${CHANNEL_WORDS[g.channel] ?? g.channel})`).join("; ")}.`,
    `Standing jobs: ${
      data.standing
        // His own are all named, with their ids, so he can switch one on, off or remove it by voice.
        .filter((j) => j.on !== false || j.kind === "user")
        .map(
          (j) =>
            `${j.title} (${j.owner}, ${j.kind === "schedule" ? `${j.count} turns` : `ran ${j.count}`}${j.kind === "user" ? `, his own, id ${j.id}${j.proposed === true ? ", proposed" : j.on === false ? ", off" : ""}` : ""})`,
        )
        .join("; ") || "none on"
    }.`,
  ].join(" ");
};

/** What it did since local midnight, newest first, in a few sentences. */
export const describeToday = (entries: ReadonlyArray<TrustEntry>, now: Date): string => {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const today = entries.filter((e) => Date.parse(e.at) >= start.getTime());
  if (today.length === 0) return "Nothing yet today that I did on your behalf.";
  const count = (k: TrustKind) => today.filter((e) => e.kind === k).length;
  const parts = [
    ["action", "actions on this computer"],
    ["social", "social actions"],
    ["vault", "vault uses"],
    ["weave", "messages to other sessions"],
    ["playbook", "things I did by myself"],
  ] as const;
  const counts = parts.filter(([k]) => count(k) > 0).map(([k, w]) => `${count(k)} ${w}`);
  const latest = today.slice(0, 6).map((e) => `${e.text} (${e.outcome})`);
  return `Today: ${counts.join(", ")}. Latest: ${latest.join("; ")}.`;
};

export const PERMISSION_WORDS: Readonly<Record<string, Permission>> = {
  screen: "screen",
  "screen capture": "screen",
  chrome: "chrome",
  browser: "chrome",
  social: "social",
  vault: "vault",
  act: "act",
  "act without asking": "act",
  remote: "remote",
};

/** 'turn off Chrome' -> the permission, or null when the words match none. */
export const permissionFromWords = (words: string): Permission | null => {
  const w = words.toLowerCase().trim();
  return (
    PERMISSION_WORDS[w] ??
    Object.entries(PERMISSION_WORDS).find(([k]) => w.includes(k))?.[1] ??
    null
  );
};
