/**
 * The account side of T3's model picker (T6): which account an instance runs as, its room left, the thread's
 * "Keep on this account" pin, and on a live thread what a pick there does. Each account is a provider instance;
 * a mirrored terminal session runs on cswap's machine login, which the Usage page switches.
 */
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { accountReturnsAt, instanceAccount, type BatonAccount } from "@t3tools/baton-contracts";
import { accountRow, returnsLabel } from "@t3tools/baton-shared/accountRoom";
import { isLiveThreadId, LIVE_INSTANCE } from "@t3tools/baton-shared/liveThread";
import type { ProviderInstanceId, ScopedThreadRef } from "@t3tools/contracts";
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
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { liveLoginOf, useLiveAccounts } from "./BatonLiveModel";

/** An instance's account, when it reports a login or limits; null for one that reports neither. */
const accountOf = (entry: ProviderInstanceEntry): BatonAccount | null =>
  entry.snapshot.usageLimits !== undefined || (entry.snapshot.auth.email?.trim() ?? "") !== ""
    ? instanceAccount(entry.snapshot, true)
    : null;

const useNow = () => Date.parse(`${useNowMinute()}:00Z`);

const useLiveAccount = (threadRef: ScopedThreadRef) =>
  useLiveAccounts(threadRef).find((entry) => entry.active);

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

function ContinueInNote({ name }: { readonly name: string }) {
  return (
    <Note>
      <span className="font-medium text-foreground/80">Continue in {name}</span>: a model picked
      here opens a new thread with this conversation. The terminal session stays as it is.
    </Note>
  );
}

function LiveSessionAccount({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const account = useLiveAccount(threadRef);
  return account === undefined ? null : (
    <AccountLine account={account} email="">
      <KeepToggle threadRef={threadRef} />
    </AccountLine>
  );
}

/** A Claude instance on a live thread: /model on the session's own login, a live move to another known one. */
function LiveClaudeNote(props: {
  readonly entry: ProviderInstanceEntry;
  readonly threadRef: ScopedThreadRef;
}) {
  const relation = liveLoginOf(props.entry.instanceId, useLiveAccounts(props.threadRef)).relation;
  if (relation === "same")
    return <Note>A model picked here changes the terminal session's own model.</Note>;
  if (relation === "other")
    return (
      <Note>
        <span className="font-medium text-foreground/80">Move to {props.entry.displayName}</span>: a
        model picked here moves the terminal session to this account while it runs. Its sub-agents
        keep working.
      </Note>
    );
  return <ContinueInNote name={props.entry.displayName} />;
}

/** The row under the model list for the instance being browsed (or the thread's own, under Favorites). */
export function BatonPickerAccount(props: {
  readonly entry: ProviderInstanceEntry;
  readonly threadRef: ScopedThreadRef | null;
  readonly threadInstanceId: ProviderInstanceId;
}) {
  const { entry, threadRef } = props;
  // A handed-off live thread is ordinary (livePick); only the Terminal session entry stays special.
  if (
    threadRef !== null &&
    isLiveThreadId(threadRef.threadId) &&
    (props.threadInstanceId === LIVE_INSTANCE || entry.instanceId === LIVE_INSTANCE)
  ) {
    if (entry.instanceId === LIVE_INSTANCE) return <LiveSessionAccount threadRef={threadRef} />;
    return entry.driverKind === "claudeAgent" ? (
      <LiveClaudeNote entry={entry} threadRef={threadRef} />
    ) : (
      <ContinueInNote name={entry.displayName} />
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
  const keptAtom = batonWorkSessions.threadKeptQuery({
    environmentId: threadRef.environmentId,
    input: { threadId: threadRef.threadId },
  });
  const query = useAtomValue(keptAtom);
  const refresh = useAtomRefresh(keptAtom);
  const setKeep = useAtomCommand(batonWorkSessions.threadKeep, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  // Null on an older server, which has no such setting.
  const keep = Option.getOrNull(AsyncResult.value(query))?.keep ?? null;
  if (keep === null) return null;
  const toggle = () => {
    setBusy(true);
    void setKeep({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, keep: !keep },
    }).then((result) => {
      setBusy(false);
      if (result._tag === "Success") refresh();
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

function LiveMark({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  return <Mark account={useLiveAccount(threadRef)} />;
}

/** The picker trigger's one limit mark: shown only while the thread's account is on a limit. */
export function BatonLimitMark(props: {
  readonly entry: ProviderInstanceEntry | undefined;
  readonly threadRef: ScopedThreadRef | null;
}) {
  if (props.threadRef !== null && props.entry?.instanceId === LIVE_INSTANCE)
    return <LiveMark threadRef={props.threadRef} />;
  return props.entry === undefined ? null : <Mark account={accountOf(props.entry)} />;
}

/** The picker rail's room left for an instance: its tooltip line, and whether the account is on a limit. */
export function instanceRoom(
  entry: ProviderInstanceEntry,
  now: number,
): { readonly text: string; readonly onLimit: boolean } | null {
  if (entry.snapshot.usageLimits === undefined) return null;
  const account = instanceAccount(entry.snapshot, true);
  return { text: accountRow(account, now), onLimit: accountReturnsAt(account) !== null };
}

/** The rail button's limit mark, in its corner. */
export function RailLimitMark() {
  return (
    <HourglassIcon
      aria-hidden
      data-testid="model-picker-rail-limit-mark"
      className="pointer-events-none absolute right-0.5 bottom-0.5 z-40 size-2.5 text-warning-foreground"
    />
  );
}

/** The picker footer's way to T3's own usage panel (the one /usage-limits opens); disabled with a reason. */
export function BatonUsageDetails({ onOpen }: { readonly onOpen: (() => void) | null }) {
  const button = (
    <Button
      size="xs"
      variant="ghost"
      disabled={onOpen === null}
      data-testid="model-picker-usage-details"
      onClick={onOpen ?? undefined}
    >
      <ChartNoAxesColumnIcon />
      Usage details
    </Button>
  );
  return (
    <span className="ms-auto">
      {onOpen === null ? (
        <Tooltip>
          <TooltipTrigger render={<span />}>{button}</TooltipTrigger>
          <TooltipPopup side="top">
            No usage reading for this provider, or the message has attachments
          </TooltipPopup>
        </Tooltip>
      ) : (
        button
      )}
    </span>
  );
}
