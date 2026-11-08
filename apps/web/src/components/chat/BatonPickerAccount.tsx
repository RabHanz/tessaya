/**
 * The account side of T3's model picker (T6): which account an instance runs as, its room left, the thread's
 * "Keep on this account" pin, and on a live thread what a pick there does. Each account is a provider instance;
 * a mirrored terminal session runs on cswap's machine login, which the Usage page switches.
 */
import { useAtomValue } from "@effect/atom-react";
import { accountReturnsAt, instanceAccount, type BatonAccount } from "@t3tools/baton-contracts";
import { isLiveThreadId, LIVE_INSTANCE } from "@t3tools/baton-shared/liveThread";
import type { EnvironmentId, ProviderInstanceId, ScopedThreadRef } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { ChartNoAxesColumnIcon, HourglassIcon, LockIcon, LockOpenIcon } from "lucide-react";
import { useState } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { batonWorkSessions } from "../../state/batonWorkSessions";
import { useAtomCommand } from "../../state/use-atom-command";
import { RedactedSensitiveText } from "../settings/RedactedSensitiveText";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { limitsAge } from "./BatonLimitsAge";

const returnsLabel = (returnsAt: string) =>
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

/** An instance's account, when it reports a login or limits; null for one that reports neither. */
const accountOf = (entry: ProviderInstanceEntry): BatonAccount | null =>
  entry.snapshot.usageLimits !== undefined || (entry.snapshot.auth.email?.trim() ?? "") !== ""
    ? instanceAccount(entry.snapshot, true)
    : null;

const useNow = () => Date.parse(`${useNowMinute()}:00Z`);

function useLiveAccount(environmentId: EnvironmentId) {
  const pool = useAtomValue(batonWorkSessions.accountPoolQuery({ environmentId, input: {} }));
  return Option.getOrNull(AsyncResult.value(pool))?.accounts.find((entry) => entry.active);
}

function AccountLine(props: {
  readonly account: BatonAccount;
  readonly email: string;
  readonly children?: React.ReactNode;
}) {
  const now = useNow();
  return (
    <div
      data-testid="model-picker-account"
      className="flex min-h-8 min-w-0 items-center gap-1.5 border-t border-border/70 px-3 py-1 text-2xs leading-4 text-muted-foreground"
    >
      <span className="shrink-0">Runs as</span>
      <span className="min-w-0 truncate font-medium text-foreground/80">{props.account.label}</span>
      <RedactedSensitiveText
        value={props.email}
        ariaLabel="Toggle account email visibility"
        revealTooltip="Click to reveal the account this thread will run as"
        hideTooltip="Click to hide the account"
        className="min-w-0 truncate"
      />
      <span className="shrink-0">· {accountRow(props.account, now)}</span>
      {props.children}
    </div>
  );
}

function Note({ children }: { readonly children: React.ReactNode }) {
  return (
    <p
      data-testid="model-picker-live-note"
      className="border-t border-border/70 px-3 py-1.5 text-2xs leading-4 text-muted-foreground"
    >
      {children}
    </p>
  );
}

function LiveSessionAccount({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const account = useLiveAccount(environmentId);
  return account === undefined ? null : <AccountLine account={account} email="" />;
}

/** The row under the model list for the instance being browsed (or the thread's own, under Favorites). */
export function BatonPickerAccount(props: {
  readonly entry: ProviderInstanceEntry;
  readonly threadRef: ScopedThreadRef | null;
  readonly threadInstanceId: ProviderInstanceId;
}) {
  const { entry, threadRef } = props;
  if (threadRef !== null && isLiveThreadId(threadRef.threadId)) {
    if (entry.instanceId === LIVE_INSTANCE)
      return <LiveSessionAccount environmentId={threadRef.environmentId} />;
    return entry.driverKind === "claudeAgent" ? (
      <Note>A model picked here changes the terminal session's own model.</Note>
    ) : (
      <Note>
        <span className="font-medium text-foreground/80">Continue in {entry.displayName}</span>: a
        model picked here opens a new thread with this conversation. The terminal session stays as
        it is.
      </Note>
    );
  }
  const account = accountOf(entry);
  if (account === null) return null;
  const pinnable =
    threadRef !== null &&
    entry.instanceId === props.threadInstanceId &&
    entry.driverKind === "claudeAgent";
  return (
    <AccountLine account={account} email={entry.snapshot.auth.email?.trim() ?? ""}>
      {pinnable ? <KeepToggle threadRef={threadRef} /> : null}
    </AccountLine>
  );
}

/** "Keep on this account": automatic rotation leaves this thread where he put it. Pressed again, it unpins. */
function KeepToggle({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const query = useAtomValue(
    batonWorkSessions.threadKeptQuery({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    }),
  );
  const setKeep = useAtomCommand(batonWorkSessions.threadKeep, { reportFailure: false });
  const [chosen, setChosen] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const stored = Option.getOrNull(AsyncResult.value(query))?.keep ?? null;
  // An older server has no such setting.
  if (stored === null) return null;
  const keep = chosen ?? stored;
  const toggle = () => {
    setBusy(true);
    void setKeep({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, keep: !keep },
    }).then((result) => {
      setBusy(false);
      if (result._tag === "Success") setChosen(result.value.keep);
      else
        toastManager.add({
          type: "error",
          title: "Could not change this thread's account setting",
        });
    });
  };
  return (
    <span className="ms-auto shrink-0">
      <Button
        size="xs"
        variant="ghost"
        disabled={busy}
        aria-pressed={keep}
        data-testid="thread-account-keep"
        onClick={toggle}
      >
        {keep ? <LockIcon /> : <LockOpenIcon />}
        {keep ? "Kept on this account" : "Keep on this account"}
      </Button>
    </span>
  );
}

function Mark({ account }: { readonly account: BatonAccount | null | undefined }) {
  const returnsAt = account ? accountReturnsAt(account) : null;
  if (returnsAt === null) return null;
  const label = `${account?.label ?? "This account"} is on a limit until ${returnsLabel(returnsAt)}`;
  return (
    <HourglassIcon
      role="img"
      aria-label={label}
      data-testid="model-picker-limit-mark"
      className="size-3 shrink-0 text-warning-foreground"
    />
  );
}

function LiveMark({ environmentId }: { readonly environmentId: EnvironmentId }) {
  return <Mark account={useLiveAccount(environmentId)} />;
}

/** The picker trigger's one limit mark: shown only while the thread's account is on a limit. */
export function BatonLimitMark(props: {
  readonly entry: ProviderInstanceEntry | undefined;
  readonly threadRef: ScopedThreadRef | null;
}) {
  if (props.threadRef !== null && props.entry?.instanceId === LIVE_INSTANCE)
    return <LiveMark environmentId={props.threadRef.environmentId} />;
  return props.entry === undefined ? null : <Mark account={accountOf(props.entry)} />;
}

/** The picker rail's tooltip text for an instance's room left, or null when it reports none. */
export function instanceRoom(entry: ProviderInstanceEntry, now: number): string | null {
  if (entry.snapshot.usageLimits === undefined) return null;
  return accountRow(instanceAccount(entry.snapshot, true), now);
}

/** The picker footer's way to T3's own usage panel (the one /usage-limits opens). */
export function BatonUsageDetails({ onOpen }: { readonly onOpen: () => void }) {
  return (
    <span className="ms-auto">
      <Button size="xs" variant="ghost" data-testid="model-picker-usage-details" onClick={onOpen}>
        <ChartNoAxesColumnIcon />
        Usage details
      </Button>
    </span>
  );
}
