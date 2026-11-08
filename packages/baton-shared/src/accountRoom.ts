/**
 * How an account reads in the model picker, on web and mobile: room left, or when it returns, and how old the
 * reading is (D92). A setup token's windows come from Baton's five-minute probe, so they lag the account.
 */
import { accountReturnsAt, type BatonAccount } from "@t3tools/baton-contracts";

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
