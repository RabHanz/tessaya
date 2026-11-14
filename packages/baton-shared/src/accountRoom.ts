/**
 * How an account reads in the model picker, on web and mobile: room left, or when it returns, and how old the
 * reading is (D92). A setup token's windows come from Baton's five-minute probe, so they lag the account.
 */
import {
  accountReturnsAt,
  type BatonAccount,
  type BatonAccountRecord,
  type BatonLiveQueued,
} from "@t3tools/baton-contracts";

/** Three missed five-minute ticks: the same point at which cswap's hold on the reading lapses. */
const STALE_AFTER_MS = 15 * 60_000;

export function limitsAge(
  checkedAt: string,
  now: number,
): { readonly text: string; readonly stale: boolean } | null {
  const age = now - Date.parse(checkedAt);
  if (!Number.isFinite(age)) return null;
  const minutes = Math.max(0, Math.floor(age / 60_000));
  const ago =
    minutes < 1
      ? "just now"
      : minutes < 60
        ? `${minutes} min ago`
        : minutes < 1440
          ? `${Math.floor(minutes / 60)} h ago`
          : `${Math.floor(minutes / 1440)} d ago`;
  return age > STALE_AFTER_MS
    ? { text: `Stale: last read ${ago}`, stale: true }
    : { text: `Read ${ago}`, stale: false };
}

export const returnsLabel = (returnsAt: string) =>
  // @effect-diagnostics-next-line globalDate:off -- a display label, not a date value
  new Date(returnsAt).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

export function accountRow(account: BatonAccount, now: number): string {
  const returnsAt = accountReturnsAt(account);
  if (returnsAt !== null) return `out until ${returnsLabel(returnsAt)}`;
  const room =
    account.headroomPercent === null ? "limits unknown" : `${account.headroomPercent}% left`;
  const age = account.usageCheckedAt === null ? null : limitsAge(account.usageCheckedAt, now);
  return age === null ? room : `${room} · ${age.text.toLowerCase()}`;
}

/** The owner reads every time in GMT+5 (POSIX zone names flip the sign). */
const OWNER_TIME_ZONE = "Etc/GMT-5";

/** "18:00 (GMT+5)" today, "Thu 09:00 (GMT+5)" on another day. */
export function resetLabel(resetsAt: string, now: number): string {
  const at = Date.parse(resetsAt);
  if (!Number.isFinite(at)) return "";
  const day = (ms: number) =>
    new Intl.DateTimeFormat("en-GB", { timeZone: OWNER_TIME_ZONE, dateStyle: "short" }).format(ms);
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: OWNER_TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    ...(day(at) === day(now) ? {} : { weekday: "short" }),
  }).format(at);
  return `${time} (GMT+5)`;
}

type Room = Pick<BatonAccountRecord, "fiveHour" | "weekly">;

/** Amber from 80% used, red at the limit. */
export function roomTone(room: Room): "ok" | "warn" | "limit" {
  const used = Math.max(room.fiveHour?.usedPercent ?? 0, room.weekly?.usedPercent ?? 0);
  return used >= 100 ? "limit" : used >= 80 ? "warn" : "ok";
}

/** "5h 34% · wk 62%", "wk 14%", or "at limit · back 18:00 (GMT+5)"; null with no reading. */
export function roomText(room: Room, now: number): string | null {
  if (roomTone(room) === "limit") {
    const back = [room.fiveHour, room.weekly]
      .filter((limit) => limit !== null && limit.usedPercent >= 100 && limit.resetsAt !== null)
      .map((limit) => limit!.resetsAt!)
      .toSorted()
      .at(-1);
    return back === undefined ? "at limit" : `at limit · back ${resetLabel(back, now)}`;
  }
  const parts = [
    room.fiveHour === null ? null : `5h ${Math.round(room.fiveHour.usedPercent)}%`,
    room.weekly === null ? null : `wk ${Math.round(room.weekly.usedPercent)}%`,
  ].filter((part) => part !== null);
  return parts.length === 0 ? null : parts.join(" · ");
}

/** Tooltip lines: "5-hour: 34% used · resets 18:00 (GMT+5)". */
export function roomDetail(room: Room, now: number): ReadonlyArray<string> {
  const line = (name: string, limit: Room["fiveHour"]) =>
    limit === null
      ? []
      : [
          `${name}: ${Math.round(limit.usedPercent)}% used${
            limit.resetsAt === null ? "" : ` · resets ${resetLabel(limit.resetsAt, now)}`
          }`,
        ];
  return [...line("5-hour", room.fiveHour), ...line("Weekly", room.weekly)];
}

/** "si•••••@gmail.com": enough to tell two logins apart on a shared screen. */
export const maskedEmail = (email: string): string => {
  const [local = "", domain = ""] = email.split("@");
  return `${local.slice(0, 2)}${"•".repeat(Math.min(5, Math.max(3, local.length - 2)))}@${domain}`;
};

/**
 * "Switches to Work, effort high when this turn ends": a terminal session's change waiting for it to go idle, or
 * "…now" while it is applied (an account move may restart the session once in its pane first).
 */
export const queuedText = (
  queued: BatonLiveQueued,
  accounts: ReadonlyArray<Pick<BatonAccountRecord, "label" | "liveSwitchKey">>,
  applying = false,
): string => {
  const parts = [
    queued.accountKey === undefined
      ? null
      : `switches to ${accounts.find((account) => account.liveSwitchKey === queued.accountKey)?.label ?? "another account"}`,
    queued.model === undefined ? null : `model ${queued.model}`,
    queued.effort === undefined ? null : `effort ${queued.effort}`,
  ].filter((part) => part !== null);
  const text = `${parts.join(", ")} ${applying ? "now" : "when this turn ends"}`;
  return text.charAt(0).toUpperCase() + text.slice(1);
};

/**
 * The login his words name ("the rabee account", an address): an exact address, else the one login whose address or
 * label contains the words. Null when none or several do, so a vague name never switches the wrong login.
 */
export const accountByWords = <A extends { readonly label: string; readonly email: string | null }>(
  accounts: ReadonlyArray<A>,
  words: string,
): A | null => {
  const said = words
    .trim()
    .toLowerCase()
    .replace(/\b(the|account|login)\b/g, "")
    .trim();
  if (said === "") return null;
  const exact = accounts.find((account) => account.email?.toLowerCase() === said);
  if (exact !== undefined) return exact;
  const named = accounts.filter((account) =>
    [account.email?.split("@")[0], account.label].some((name) =>
      name?.toLowerCase().includes(said),
    ),
  );
  return named.length === 1 ? named[0]! : null;
};
