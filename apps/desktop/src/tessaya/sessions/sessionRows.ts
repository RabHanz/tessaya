/**
 * The Sessions area of Baton's window (D138): the sidebar's own project rows, ordered and turned
 * into window rows. Pure: no new source of sessions, only the one the sidebar already holds.
 */
import type { TessayaSessionSummary } from "@t3tools/tessaya-contracts";

import type { HomeControl } from "../home/tessayaHome.ts";

export const SESSIONS_SHOWN = 5;

const rank = (s: TessayaSessionSummary): number => (s.urgent ? 0 : s.state === "working" ? 1 : 2);

/** What needs him first, then what is working, then the most recently touched. */
export const orderSessions = (
  rows: ReadonlyArray<TessayaSessionSummary>,
): ReadonlyArray<TessayaSessionSummary> =>
  rows.toSorted(
    (a, b) =>
      rank(a) - rank(b) ||
      (Date.parse(b.updatedAt ?? "") || 0) - (Date.parse(a.updatedAt ?? "") || 0) ||
      a.key.localeCompare(b.key),
  );

/** `alex@example.com` as `a•••@example.com`; a plain name as `a•••`. */
export const maskAccount = (account: string): string => {
  const at = account.indexOf("@");
  return at > 0 ? `${account[0]}•••${account.slice(at)}` : `${account[0] ?? ""}•••`;
};

const STATE_WORDS = { working: "Working", waiting: "Needs you", idle: "Idle" } as const;

export const sessionControls = (
  rows: ReadonlyArray<TessayaSessionSummary>,
): ReadonlyArray<HomeControl> =>
  orderSessions(rows).map((s, i) => ({
    id: `n:${s.key}`,
    section: "Sessions",
    label: s.session,
    kind: "session" as const,
    project: s.project,
    box: s.box,
    state: s.state,
    stateLabel: STATE_WORDS[s.state],
    urgent: s.urgent,
    ...(s.account === null ? {} : { masked: maskAccount(s.account), revealed: s.account }),
    canOpen: s.thread !== null,
    canSend: s.pane !== null,
    ...(i >= SESSIONS_SHOWN ? { more: true, moreLabel: "Show all" } : {}),
  }));

/** Which request a window row's action makes: the row's own key tells which session. */
export const requestFor = (
  rows: ReadonlyArray<TessayaSessionSummary>,
  id: string,
  text: string | null,
) => {
  const row = rows.find((s) => id === `n:${s.key}`);
  if (row === undefined) return null;
  if (text === null) {
    return row.thread === null ? null : ({ kind: "open", ...row.thread } as const);
  }
  const body = text.trim();
  return row.pane === null || body.length === 0
    ? null
    : ({
        kind: "send",
        environmentId: row.pane.environmentId,
        pane: row.pane.pane,
        text: body,
      } as const);
};

/** A session by the id the assistant was given, or by its name. */
export const findSession = (
  rows: ReadonlyArray<TessayaSessionSummary>,
  idOrName: string,
): TessayaSessionSummary | null => {
  const wanted = idOrName.trim().toLowerCase();
  return rows.find((r) => r.key === idOrName || r.session.toLowerCase() === wanted) ?? null;
};

/** One session's state in a sentence, for the assistant: read from the row, never by asking the session. */
export const describeSession = (row: TessayaSessionSummary, now: number): string => {
  const doing = row.urgent
    ? "is waiting for him (a question or an approval)"
    : row.state === "working"
      ? "is working"
      : row.state === "waiting"
        ? "is waiting for his next message"
        : "is idle";
  const at = Date.parse(row.updatedAt ?? "");
  const minutes = Number.isNaN(at) ? null : Math.max(0, Math.round((now - at) / 60_000));
  const since =
    minutes === null
      ? ""
      : minutes < 1
        ? ", active just now"
        : minutes < 120
          ? `, last active ${minutes} min ago`
          : `, last active ${Math.round(minutes / 60)} h ago`;
  return `${row.session} (${row.project}, on ${row.box}) ${doing}${since}.`;
};

/**
 * Why a message must not be typed into this row's pane now, or null. A session waiting on him shows a question or
 * an approval, and keys typed there answer it; Herdr's own refusal only covers panes it knows run an agent.
 */
export const sendRefusal = (row: TessayaSessionSummary): string | null =>
  row.urgent
    ? `${row.session} is waiting on a question or an approval in its terminal, so nothing was sent. Answer it there first, then send again.`
    : null;

/**
 * Typing into a row's pane through this machine's server, or why not. His words reach another machine's session only
 * over a real client session to it (T3's window), never over a link, where they would arrive as another agent's.
 */
export const doorSend = (
  row: TessayaSessionSummary,
  text: string,
): { readonly method: string; readonly input: unknown } | string => {
  if (row.pane === null) return "Nothing to send.";
  if (row.access !== null)
    return `Open T3 to send to ${row.box}; with its window closed, only this computer's sessions can be typed into.`;
  return { method: "baton.live.herdrSend", input: { pane: row.pane.pane, text } };
};
