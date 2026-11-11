/**
 * Health of the Claude cloud logins, from the file the box's daily check writes
 * (scripts/tessaya/cloud-logins.sh -> ~/.t3/baton/cloud-logins.json). These logins are cloud-only: this
 * only reads the report, and nothing here uses the credentials behind it. Pure.
 */
import type { NeedItem } from "./needsMe.ts";

export type CloudLoginState = "ok" | "renew-soon" | "expired" | "not-logged-in";

export interface CloudLogins {
  /** Epoch milliseconds (the file holds seconds). */
  readonly checkedAt: number;
  readonly accounts: ReadonlyArray<{
    readonly account: string;
    readonly state: CloudLoginState;
    /** Days until the login (the refresh token) lapses; the access token is refreshed by use and does not count. */
    readonly loginExpiresInDays: number | null;
  }>;
}

const STATES: ReadonlySet<string> = new Set(["ok", "renew-soon", "expired", "not-logged-in"]);
export const CLOUD_CHECK_STALE_MS = 2 * 86_400_000;
/** A login with fewer days than this left is about to lapse. */
export const CLOUD_RENEW_DAYS = 5;

/** The state to act on: a good login with under five days left is renew-soon whatever the file says. */
const stateOf = (state: CloudLoginState, days: number | null): CloudLoginState =>
  state === "ok" && days !== null && days < CLOUD_RENEW_DAYS ? "renew-soon" : state;

export const parseCloudLogins = (text: string): CloudLogins | null => {
  try {
    const v = JSON.parse(text) as { checkedAt?: unknown; accounts?: unknown };
    if (typeof v.checkedAt !== "number" || !Array.isArray(v.accounts)) return null;
    const accounts = v.accounts.flatMap((a: unknown) => {
      const o = (typeof a === "object" && a !== null ? a : {}) as Record<string, unknown>;
      return typeof o["account"] === "string" &&
        typeof o["state"] === "string" &&
        STATES.has(o["state"])
        ? [
            {
              account: o["account"],
              loginExpiresInDays:
                typeof o["loginExpiresInDays"] === "number" ? o["loginExpiresInDays"] : null,
              state: stateOf(
                o["state"] as CloudLoginState,
                typeof o["loginExpiresInDays"] === "number" ? o["loginExpiresInDays"] : null,
              ),
            },
          ]
        : [];
    });
    // A seconds timestamp is far below any millisecond one from this century.
    return { checkedAt: v.checkedAt < 1e11 ? v.checkedAt * 1000 : v.checkedAt, accounts };
  } catch {
    return null;
  }
};

const ago = (ms: number): string => {
  const m = Math.max(0, Math.round(ms / 60_000));
  return m < 120
    ? `${m} min ago`
    : m < 2880
      ? `${Math.round(m / 60)} h ago`
      : `${Math.round(m / 1440)} days ago`;
};

/** The 'what works right now' row. Unknown when there is no report. */
export const cloudLoginsRow = (
  s: CloudLogins | null,
  now: number,
): {
  readonly name: string;
  readonly state: "works" | "limited" | "unknown";
  readonly why: string;
} => {
  const name = "Claude cloud logins";
  if (s === null)
    return {
      name,
      state: "unknown",
      why: "Unknown: no report of the cloud logins could be read here.",
    };
  const when = ago(now - s.checkedAt);
  if (s.accounts.length === 0)
    return { name, state: "unknown", why: `Checked ${when}; no cloud accounts are set up.` };
  const bad = s.accounts.filter((a) => a.state !== "ok");
  if (bad.length > 0) {
    return {
      name,
      state: "limited",
      why: `Checked ${when}. ${bad.map((a) => `${a.account}: ${a.state === "renew-soon" ? "renew soon" : a.state === "expired" ? "expired" : "not logged in"}`).join("; ")}.`,
    };
  }
  if (now - s.checkedAt > CLOUD_CHECK_STALE_MS) {
    return { name, state: "limited", why: `The last check was ${when}; it should run every day.` };
  }
  return {
    name,
    state: "works",
    why: `All ${s.accounts.length} logins are good (checked ${when}).`,
  };
};

/** One 'needs you' row per login that is about to lapse or has: renewing one takes a browser. */
export const cloudLoginsNeeds = (s: CloudLogins | null, now: number): ReadonlyArray<NeedItem> =>
  (s?.accounts ?? [])
    .filter((a) => a.state === "renew-soon" || a.state === "expired")
    .map((a) => ({
      id: `cloudlogin:${a.account}`,
      source: "ledger" as const,
      title: `Renew the cloud login for ${a.account}: it needs you at a browser`,
      why:
        a.state === "expired"
          ? `It has expired (checked ${ago(now - (s?.checkedAt ?? now))}).`
          : `It lapses in ${a.loginExpiresInDays ?? "a few"} days.`,
      weight: a.state === "expired" ? 80 : 65,
    }));
