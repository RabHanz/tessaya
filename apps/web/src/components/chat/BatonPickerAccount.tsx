/**
 * The account side of T3's model picker (T6, ACCOUNTS-2): one row per real account above the models, with % used,
 * the thread's "Keep on this account" pin, and on a terminal thread the session's own login and a queued change.
 */
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import {
  accountReturnsAt,
  instanceAccount,
  type BatonAccount,
  type BatonAccountRecord,
  type BatonLiveQueued,
} from "@t3tools/baton-contracts";
import { oneEntryPerProvider } from "@t3tools/baton-shared/accounts";
import {
  accountRow,
  maskedEmail,
  returnsLabel,
  roomDetail,
  roomText,
  roomTone,
} from "@t3tools/baton-shared/accountRoom";
import { isLiveThreadId, LIVE_INSTANCE } from "@t3tools/baton-shared/liveThread";
import { type EnvironmentId, ProviderInstanceId, type ScopedThreadRef } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom, AsyncResult } from "effect/reactivity";
import {
  ChartNoAxesColumnIcon,
  CheckIcon,
  HourglassIcon,
  LockIcon,
  LockOpenIcon,
} from "lucide-react";
import { useState } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { batonWorkSessions } from "../../state/batonWorkSessions";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useLiveAccounts, useLiveAccountSwitch, useLiveState } from "./BatonLiveModel";

/** An instance's account, when it reports a login or limits; null for one that reports neither. */
const accountOf = (entry: ProviderInstanceEntry): BatonAccount | null =>
  entry.snapshot.usageLimits !== undefined || (entry.snapshot.auth.email?.trim() ?? "") !== ""
    ? instanceAccount(entry.snapshot, true)
    : null;

const useNow = () => Date.parse(`${useNowMinute()}:00Z`);

const useLiveAccount = (threadRef: ScopedThreadRef) =>
  useLiveAccounts(threadRef).find((entry) => entry.active);

const NO_ACCOUNTS = Atom.make(AsyncResult.initial<never, never>(false));

/** One record per real account on the thread's environment (baton.accounts.list). */
export function useBatonAccounts(
  environmentId: EnvironmentId | null,
): ReadonlyArray<BatonAccountRecord> {
  const result = useAtomValue(
    environmentId === null
      ? NO_ACCOUNTS
      : batonWorkSessions.accountsQuery({ environmentId, input: {} }),
  );
  return Option.getOrNull(AsyncResult.value(result))?.accounts ?? [];
}

/** The rail's one entry per provider, with Terminal its own group. */
export const batonRailEntries = (
  entries: ReadonlyArray<ProviderInstanceEntry>,
  selectedInstanceId: ProviderInstanceId,
) => oneEntryPerProvider(entries, selectedInstanceId);

const METHOD_LABEL = { "setup-token": "token", browser: "browser", "api-key": "API key" } as const;

const TONE_CLASS = {
  ok: "text-muted-foreground",
  warn: "text-warning-foreground",
  limit: "text-destructive-foreground",
} as const;

/** "5h 34% · wk 62%" in its tone, with the resets in a tooltip; nothing without a reading. */
export function BatonRoom(props: {
  readonly account: BatonAccountRecord;
  readonly prefix?: string;
}) {
  const now = useNow();
  const text = roomText(props.account, now);
  if (text === null) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            data-testid="account-room"
            className={`shrink-0 tabular-nums ${TONE_CLASS[roomTone(props.account)]}`}
          />
        }
      >
        {props.prefix}
        {text}
      </TooltipTrigger>
      <TooltipPopup side="top">
        {roomDetail(props.account, now).map((line) => (
          <div key={line}>{line}</div>
        ))}
      </TooltipPopup>
    </Tooltip>
  );
}

function AccountRow(props: {
  readonly account: BatonAccountRecord;
  readonly current: boolean;
  readonly next: boolean;
  readonly onPick: (() => void) | null;
}) {
  const { account } = props;
  const paused = account.health === "paused";
  const signedOut = account.health === "signed-out";
  return (
    <button
      type="button"
      data-testid="model-picker-account"
      aria-pressed={props.current}
      disabled={props.onPick === null || paused}
      onClick={props.onPick ?? undefined}
      className="flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-start text-xs hover:bg-accent disabled:cursor-default disabled:hover:bg-transparent aria-pressed:bg-accent/60"
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-1">
          <span className="truncate font-medium text-foreground">{account.label}</span>
          {account.methods.map((method) => (
            <Badge key={method.kind} size="sm" variant="outline">
              {METHOD_LABEL[method.kind]}
            </Badge>
          ))}
          {props.next ? (
            <Badge size="sm" variant="info">
              Next
            </Badge>
          ) : null}
          {paused ? (
            <Badge size="sm" variant="warning">
              Paused · resume in Settings
            </Badge>
          ) : signedOut ? (
            <Badge size="sm" variant="error">
              Signed out
            </Badge>
          ) : null}
        </span>
        {account.email === null ? null : (
          <span className="truncate text-2xs text-muted-foreground">
            {props.current && props.next ? "Current · " : ""}
            {maskedEmail(account.email)}
          </span>
        )}
      </span>
      <BatonRoom account={account} />
      {props.current ? (
        <CheckIcon aria-hidden className="size-3.5 shrink-0 text-foreground" />
      ) : null}
    </button>
  );
}

function Section(props: { readonly children: React.ReactNode }) {
  return (
    <div data-testid="model-picker-accounts" className="border-b border-border/70 px-1.5 py-1.5">
      <div className="flex items-center justify-between px-1.5 pb-1 text-2xs font-medium text-muted-foreground">
        <span>Account</span>
        <span>used</span>
      </div>
      {props.children}
    </div>
  );
}

function Note({ children }: { readonly children: React.ReactNode }) {
  return (
    <p
      data-testid="model-picker-live-note"
      className="border-b border-border/70 px-3 py-1.5 text-2xs leading-4 text-muted-foreground"
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

const queuedText = (
  queued: BatonLiveQueued,
  accounts: ReadonlyArray<BatonAccountRecord>,
): string => {
  const parts = [
    queued.accountKey === undefined
      ? null
      : `switches to ${accounts.find((account) => account.liveSwitchKey === queued.accountKey)?.label ?? "another account"}`,
    queued.model === undefined ? null : `model ${queued.model}`,
    queued.effort === undefined ? null : `effort ${queued.effort}`,
  ].filter((part) => part !== null);
  const text = `${parts.join(", ")} when this turn ends`;
  return text.charAt(0).toUpperCase() + text.slice(1);
};

/** A terminal session's accounts: its own login is current, a pick moves it there while it runs (LIVE-ACCOUNT). */
function LiveAccounts(props: {
  readonly threadRef: ScopedThreadRef;
  readonly accounts: ReadonlyArray<BatonAccountRecord>;
}) {
  const logins = useLiveAccounts(props.threadRef);
  const switchTo = useLiveAccountSwitch(props.threadRef);
  const { queued, cancel } = useLiveState(props.threadRef);
  const active = logins.find((login) => login.active);
  const accounts = props.accounts.filter(
    (account) => account.driver === "claudeAgent" && account.liveSwitchKey !== null,
  );
  if (accounts.length === 0) return null;
  return (
    <Section>
      {accounts.map((account) => {
        const login = logins.find((candidate) => candidate.key === account.liveSwitchKey);
        const current = active !== undefined && active.key === account.liveSwitchKey;
        return (
          <AccountRow
            key={account.id}
            account={account}
            current={current}
            next={queued?.accountKey !== undefined && queued.accountKey === account.liveSwitchKey}
            onPick={current || login === undefined ? null : () => switchTo(login)}
          />
        );
      })}
      {queued === null ? null : (
        <div className="flex items-center gap-2 px-1.5 pt-1 text-2xs text-muted-foreground">
          <span className="min-w-0 flex-1">{queuedText(queued, props.accounts)}</span>
          <Button size="xs" variant="ghost" data-testid="live-queued-cancel" onClick={cancel}>
            Cancel
          </Button>
        </div>
      )}
    </Section>
  );
}

/**
 * Above the models: the accounts of the provider being browsed, one row per real login, with % used. On a terminal
 * thread a pick moves the session; elsewhere it puts the thread on that account from the next message.
 */
export function BatonPickerAccount(props: {
  readonly entry: ProviderInstanceEntry;
  readonly threadRef: ScopedThreadRef | null;
  readonly environmentId: EnvironmentId | null;
  readonly threadInstanceId: ProviderInstanceId;
  readonly onPickInstance: (instanceId: ProviderInstanceId) => void;
}) {
  const { entry, threadRef } = props;
  const accounts = useBatonAccounts(props.environmentId);
  const onLiveThread =
    threadRef !== null &&
    isLiveThreadId(threadRef.threadId) &&
    props.threadInstanceId === LIVE_INSTANCE;
  if (onLiveThread) {
    if (entry.instanceId === LIVE_INSTANCE || entry.driverKind === "claudeAgent")
      return <LiveAccounts threadRef={threadRef} accounts={accounts} />;
    return <ContinueInNote name={entry.displayName} />;
  }
  const mine = accounts.filter(
    (account) => account.driver === entry.driverKind && account.instanceIds.length > 0,
  );
  if (mine.length === 0) return null;
  const pinnable =
    threadRef !== null &&
    entry.driverKind === "claudeAgent" &&
    mine.some((account) => account.instanceIds.includes(props.threadInstanceId));
  return (
    <Section>
      {mine.map((account) => {
        const current = account.instanceIds.includes(props.threadInstanceId);
        const target =
          account.methods.find((method) => method.liveSwitch)?.instanceId ??
          account.instanceIds[0] ??
          null;
        return (
          <AccountRow
            key={account.id}
            account={account}
            current={current}
            next={false}
            onPick={
              current || target === null
                ? null
                : () => props.onPickInstance(ProviderInstanceId.make(target))
            }
          />
        );
      })}
      {pinnable ? (
        <div className="flex justify-end">
          <KeepToggle threadRef={threadRef} />
        </div>
      ) : null}
    </Section>
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
