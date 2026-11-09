// @effect-diagnostics globalDate:off
/**
 * Baton's self-update, as pure rules (D137). The download and install belong to upstream's
 * updater, pointed at this repository's releases; these decide what Baton's window shows, when to
 * fetch in the background, and when an install must wait because Baton is in the middle of a turn.
 */
import type { DesktopUpdateState } from "@t3tools/contracts";

import type { HomeControl } from "../home/batonHome.ts";

const parts = (version: string) => {
  const [core = "", pre] = version.replace(/^v/, "").split("-", 2) as [string, string?];
  return { core: core.split(".").map((n) => Number.parseInt(n, 10) || 0), pre: pre?.split(".") };
};

/** Semver precedence: `0.1.2-tessaya.41` is older than `0.1.2` and newer than `0.1.2-tessaya.9` or any `-baton.N`. */
export const compareVersions = (a: string, b: string): number => {
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.core.length, y.core.length); i += 1) {
    const d = (x.core[i] ?? 0) - (y.core[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  if (x.pre === undefined || y.pre === undefined) {
    return x.pre === y.pre ? 0 : x.pre === undefined ? 1 : -1;
  }
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i += 1) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn && Number(p) !== Number(q)) return Math.sign(Number(p) - Number(q));
    if (pn !== qn) return pn ? -1 : 1;
    if (!pn && p !== q) return p < q ? -1 : 1;
  }
  return 0;
};

export const isNewer = (candidate: string, current: string): boolean =>
  compareVersions(candidate, current) > 0;

/** The version the feed offers, only when it really is newer than this one. */
export const offeredVersion = (state: DesktopUpdateState): string | null => {
  const version = state.downloadedVersion ?? state.availableVersion;
  return version !== null && isNewer(version, state.currentVersion) ? version : null;
};

export const isReady = (state: DesktopUpdateState): boolean =>
  state.downloadedVersion !== null && isNewer(state.downloadedVersion, state.currentVersion);

/** Fetch in the background as soon as one is offered; a failed fetch is left for him to retry. */
export const shouldDownload = (state: DesktopUpdateState): boolean =>
  state.enabled &&
  state.status === "available" &&
  offeredVersion(state) !== null &&
  state.downloadedVersion === null;

export interface UpdateBusy {
  readonly voiceBusy: boolean;
  readonly assistantBusy: boolean;
  /** A session turn running on this machine, which the restart would cut off (SESS-SURVIVE); null when none. */
  readonly inFlight: string | null;
}

/** Never in the middle of a turn: speaking, listening for a command, dictating, driving, or a session's turn. */
export const canInstallNow = (busy: UpdateBusy): boolean =>
  !busy.voiceBusy && !busy.assistantBusy && busy.inFlight === null;

const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/** The window's "Updates" rows. Ready to install is shown up front; the rest is behind More options. */
export const updateControls = (
  state: DesktopUpdateState,
  pending: boolean,
  countdown: {
    readonly restartAt: number;
    readonly waiting: boolean;
    /** What it waits for, when a session is mid-turn. */
    readonly inFlight?: string | null;
  } | null = null,
  backAfter: string | null = null,
): ReadonlyArray<HomeControl> => {
  const base = { id: "u.act", section: "Updates", label: "Tessaya updates" } as const;
  if (!state.enabled) {
    return [
      {
        ...base,
        hint: `Version ${state.currentVersion}. Updates run in the installed app.`,
        kind: "action",
        button: "Check now",
        disabled: true,
        more: true,
      },
    ];
  }
  if (isReady(state) && countdown !== null) {
    const at = new Date(countdown.restartAt).toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
    });
    return [
      {
        ...base,
        hint: countdown.waiting
          ? `Tessaya is updating to ${state.downloadedVersion}. It restarts as soon as the current turns finish.${countdown.inFlight == null ? "" : ` ${countdown.inFlight}`}`
          : `Tessaya is updating to ${state.downloadedVersion} and restarts at ${at}. It reopens this window.`,
        kind: "action",
        button: "Restart now",
        secondary: "Later",
        lead: true,
      },
    ];
  }
  if (isReady(state)) {
    return [
      {
        ...base,
        hint: pending
          ? `${state.downloadedVersion} installs when Tessaya is not mid-conversation.`
          : `Version ${state.downloadedVersion} is downloaded and waits. You are on ${state.currentVersion}.`,
        kind: "action",
        button: pending ? "Waiting…" : "Install and restart",
        disabled: pending,
        lead: true,
      },
    ];
  }
  const offered = offeredVersion(state);
  const hint =
    state.status === "downloading" && offered !== null
      ? `Version ${offered} is downloading${state.downloadPercent === null ? "" : `, ${Math.round(state.downloadPercent)}%`}.`
      : state.status === "available" && offered !== null
        ? `Version ${offered} is available.`
        : state.status === "checking"
          ? "Checking."
          : state.status === "error"
            ? "Could not check for updates. Try again in a moment."
            : `${backAfter === null ? "" : `${backAfter} `}Version ${state.currentVersion}. Up to date${state.checkedAt === null ? "" : `, checked ${clock(state.checkedAt)}`}.`;
  const retry = state.status === "available" || (state.status === "error" && state.canRetry);
  return [
    {
      ...base,
      hint,
      kind: "action",
      button: retry && offered !== null ? "Download" : "Check now",
      disabled: state.status === "checking" || state.status === "downloading",
      more: true,
    },
  ];
};
