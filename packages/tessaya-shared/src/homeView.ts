// @effect-diagnostics globalDate:off - display strings in his own locale, not Effect code.
/**
 * Settings → Home's words, shared by web and mobile: one line per automation and per action, and the status line.
 * Pure; the screens only lay them out.
 */
import type { HomeActionRow, HomeAutomationRow, HomeStatus } from "@t3tools/tessaya-contracts";

const when = (iso: string): string =>
  new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

export const homeStatusLine = (status: HomeStatus | null): string =>
  status === null
    ? "Reading…"
    : status.state === "connected"
      ? `Connected to ${status.host ?? "Home Assistant"}${status.version === null ? "" : ` (${status.version})`}, ${status.entities} devices.`
      : status.line;

export const automationLine = (row: HomeAutomationRow): string =>
  [
    row.kind ?? "his own",
    row.once ? "runs once" : null,
    row.expiresAt === null ? null : `ends ${when(row.expiresAt)}`,
    row.paused ? "paused" : null,
    row.status === "active" ? null : row.status,
  ]
    .filter((part) => part !== null)
    .join(" · ");

export const actionLine = (row: HomeActionRow): string =>
  `${when(row.at)} · ${row.actor} (${row.surface}) · ${row.status}`;

/** Which buttons a row of hers shows: only ways out that apply now. */
export const automationActions = (
  row: HomeAutomationRow,
): ReadonlyArray<"pause" | "resume" | "delete" | "undo"> =>
  row.status === "active"
    ? [row.paused ? "resume" : "pause", "delete"]
    : row.status === "deleted"
      ? ["undo"]
      : [];
