/** Tolerant readers for what the harnesses and the central shell print. Pure. */
import type { CloudRequest, CloudState, ProviderId, Usage } from "./types.ts";

export const jsonLines = (text: string): ReadonlyArray<Record<string, unknown>> =>
  text.split("\n").flatMap((line) => {
    const t = line.trim();
    if (!t.startsWith("{")) return [];
    try {
      const v: unknown = JSON.parse(t);
      return typeof v === "object" && v !== null && !Array.isArray(v)
        ? [v as Record<string, unknown>]
        : [];
    } catch {
      return [];
    }
  });

/** The whole text as one JSON object (pretty-printed or not), else its first line that is one. */
export const jsonObject = (text: string): Record<string, unknown> | null => {
  try {
    const v: unknown = JSON.parse(text);
    if (typeof v === "object" && v !== null && !Array.isArray(v))
      return v as Record<string, unknown>;
  } catch {
    // fall through to lines
  }
  return jsonLines(text)[0] ?? null;
};

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== ""
    ? v.trim()
    : v == null || typeof v === "object"
      ? null
      : String(v);
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v)
    ? v
    : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))
      ? Number(v)
      : null;
const pick = (o: Record<string, unknown>, ...names: string[]): unknown =>
  names.map((n) => o[n]).find((v) => v !== undefined && v !== null);

const STATES: ReadonlySet<string> = new Set([
  "awaiting-director",
  "approved",
  "running",
  "done",
  "failed",
  "denied",
  "cancelled",
  "closed",
]);
export const cloudState = (v: unknown): CloudState => {
  const s = (str(v) ?? "").toLowerCase().replace(/[_\s]+/g, "-");
  return STATES.has(s)
    ? (s as CloudState)
    : s.includes("failed")
      ? "failed"
      : s === "awaiting" || s === "pending"
        ? "awaiting-director"
        : s === "complete" || s === "completed" || s === "ready"
          ? "done"
          : s === "error"
            ? "failed"
            : "unknown";
};

/** One request from the central shell (or a harness), whatever it calls its fields. */
export const requestFrom = (provider: ProviderId, o: Record<string, unknown>): CloudRequest => {
  const card =
    typeof o["card"] === "object" && o["card"] !== null
      ? (o["card"] as Record<string, unknown>)
      : {};
  const merged = { ...card, ...o };
  const prUrl = str(pick(merged, "pr", "prUrl", "pr_url"));
  const branch = str(pick(merged, "resultBranch", "result_branch"));
  return {
    provider,
    id: str(pick(merged, "id", "request", "requestId")) ?? "",
    state: cloudState(pick(merged, "state", "status")),
    task: str(pick(merged, "task", "title", "summary")),
    repo: str(merged["repo"]),
    branch: str(merged["branch"]),
    caller: str(pick(merged, "caller", "asked_by")),
    label: str(merged["label"]),
    account: str(merged["account"]),
    sessionLink: str(pick(merged, "session", "sessionLink", "session_link", "url")),
    error: str(merged["error"]),
    overCap: merged["over_cap"] === true,
    result:
      prUrl !== null
        ? { kind: "pr", url: prUrl }
        : branch !== null
          ? { kind: "branch", url: null }
          : null,
    expectedUsage: num(pick(merged, "expectedUsage", "expected_usage", "usage")),
    weeklyBefore: num(pick(merged, "weeklyBefore", "weekly_before")),
    weeklyAfter: num(pick(merged, "weeklyAfter", "weekly_after")),
    pointsUsed: num(pick(merged, "pointsUsed", "points_used")),
    fromWeb: merged["fromWeb"] === true || merged["from_web"] === true,
  };
};

/** The shell's `usage` answer: `providers.<id>.accounts.<name> = {available, pct, rejected, resets_pkt}` and `points_used_7d`. */
export const usageFromShell = (
  o: Record<string, unknown>,
): {
  readonly usage: ReadonlyArray<Usage>;
  readonly ready: ReadonlyMap<string, { readonly ready: boolean; readonly needs: string | null }>;
} => {
  const providers =
    typeof o["providers"] === "object" && o["providers"] !== null
      ? (o["providers"] as Record<string, Record<string, unknown>>)
      : {};
  const points =
    typeof o["points_used_7d"] === "object" && o["points_used_7d"] !== null
      ? (o["points_used_7d"] as Record<string, Record<string, unknown>>)
      : {};
  const usage: Usage[] = [];
  const ready = new Map<string, { ready: boolean; needs: string | null }>();
  for (const [id, p] of Object.entries(providers)) {
    ready.set(id, { ready: p["ready"] === true, needs: str(p["needs"]) });
    const accounts =
      typeof p["accounts"] === "object" && p["accounts"] !== null
        ? (p["accounts"] as Record<string, Record<string, unknown>>)
        : {};
    for (const [account, a] of Object.entries(accounts)) {
      usage.push({
        provider: id as ProviderId,
        account,
        weeklyPercent: num(a["pct"]),
        resetsAt: str(pick(a, "resets_pkt", "resets_at")),
        rejected: a["rejected"] === true,
        ...(typeof a["available"] === "boolean" ? { available: a["available"] } : {}),
        ...(["ok", "renew-soon", "expired", "not-logged-in"].includes(String(a["login"]))
          ? { login: a["login"] as "ok" }
          : {}),
        pointsThisWeek: num(points[id]?.[account]),
      });
    }
  }
  return { usage, ready };
};

export const usageFrom = (provider: ProviderId, o: Record<string, unknown>): Usage | null => {
  const account = str(o["account"]);
  if (account === null) return null;
  return {
    provider,
    account,
    weeklyPercent: num(pick(o, "weeklyPercent", "weekly_percent", "weekly")),
    resetsAt: str(pick(o, "resetsAt", "resets_at", "reset", "resetPkt")),
    rejected: o["rejected"] === true || str(o["status"]) === "rejected",
    pointsThisWeek: num(pick(o, "pointsThisWeek", "points_this_week", "points")),
  };
};

/** A value that can sit in a remote command line unquoted: letters, digits and . _ : / @ - only. */
const SAFE = /^[A-Za-z0-9._:/@-]{1,120}$/;
export const safeArg = (value: string, what: string): string => {
  if (!SAFE.test(value)) throw new Error(`${what} has a character that cannot be sent safely`);
  return value;
};
/** Free words made safe for a remote command line: anything else becomes a hyphen. */
export const safeWords = (value: string, max = 80): string =>
  value
    .replace(/[^A-Za-z0-9._:@-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max) || "none";
