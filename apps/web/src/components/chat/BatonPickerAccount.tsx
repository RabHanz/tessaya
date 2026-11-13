/**
 * The account side of T3's model picker (T6, ACCOUNTS-2): one row per real account above the models, with % used,
 * the thread's "Keep on this account" pin, and on a terminal thread the session's own login and a queued change.
 */
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import {
  accountReturnsAt,
  instanceAccount,
  type BatonAccount,
  type BatonAccountRecord,
} from "@t3tools/baton-contracts";
import {
  accountPickHint,
  accountPickTarget,
  accountTicks,
  oneEntryPerProvider,
  pickModelFor,
  withProviderModels,
} from "@t3tools/baton-shared/accounts";
import {
  accountRow,
  maskedEmail,
  queuedText,
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
import { useEffect, useRef, useState } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { batonWorkSessions } from "../../state/batonWorkSessions";
import { useBatonAccounts } from "../../state/batonAccounts";
import { useQuietThreadShell } from "../../state/entities";
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

/** Set by the header's chip: the picker opens on it, at that account's row. Cleared when the picker closes. */
export const batonPickerFocusAtom = Atom.make<{
  readonly anchor: HTMLElement;
  readonly accountId: string;
} | null>(null);

const accountRowElement = (accountId: string) =>
  document.querySelector<HTMLElement>(
    `[data-testid="model-picker-account"][data-account-id="${CSS.escape(accountId)}"]`,
  );

/** The picker popup's placement while the header chip opened it: under the chip, not over the composer. */
export function useBatonPickerAnchor(open: boolean) {
  const focus = useAtomValue(batonPickerFocusAtom);
  const setFocus = useAtomSet(batonPickerFocusAtom);
  const wasOpen = useRef(open);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- forgets the chip's request held outside React when the picker closes
  useEffect(() => {
    if (wasOpen.current && !open) setFocus(null);
    wasOpen.current = open;
  }, [open, setFocus]);
  return focus === null
    ? {}
    : {
        anchor: focus.anchor,
        side: "bottom" as const,
        align: "end" as const,
        collisionAvoidance: { side: "flip", align: "shift" } as const,
      };
}

/** Scrolls to the chip's account row once the picker shows it, and forgets the request on close. */
function useFocusRequestedRow(accountIds: ReadonlyArray<string>) {
  const focus = useAtomValue(batonPickerFocusAtom);
  const accountId = focus?.accountId ?? null;
  const shown = accountId !== null && accountIds.includes(accountId);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls the requested row into view once the popup lays it out
  useEffect(() => {
    if (!shown || accountId === null) return;
    const timer = setTimeout(() => {
      const row = accountRowElement(accountId);
      // The thread's own row is disabled (it is already current), so it is shown, not focused.
      row?.scrollIntoView({ block: "nearest" });
    }, 0);
    return () => clearTimeout(timer);
  }, [accountId, shown]);
}

/** The rail's one entry per provider, with Terminal its own group. */
export const batonPickModel = pickModelFor;

/** Each login's models, a login with none of its own showing its provider's (withProviderModels). */
export const batonModelOptions = <M,>(
  byInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<M>>,
  entries: ReadonlyArray<ProviderInstanceEntry>,
) =>
  withProviderModels(
    byInstance,
    (instanceId) => entries.find((entry) => entry.instanceId === instanceId)?.driverKind,
  );

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
  readonly hint: string | null;
  readonly onPick: (() => void) | null;
}) {
  const { account } = props;
  const paused = account.health === "paused";
  const signedOut = account.health === "signed-out";
  return (
    <button
      type="button"
      data-testid="model-picker-account"
      data-account-id={account.id}
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
        {props.hint === null ? null : (
          <span className="truncate text-2xs text-muted-foreground">{props.hint}</span>
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
    <div
      data-testid="model-picker-accounts"
      className="border-b border-border/70 px-1.5 py-1.5 [contain:inline-size]"
    >
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
      className="border-b border-border/70 px-3 py-1.5 text-2xs leading-4 text-muted-foreground [contain:inline-size]"
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

/** Terminal on the rail: what it is. Its sessions are reached from the sidebar, not listed here. */
function TerminalNote() {
  return (
    <Note>
      <span className="font-medium text-foreground/80">Terminal</span>: Claude sessions running in a
      terminal. Open one from the sidebar.
    </Note>
  );
}

/** A terminal session's accounts: its own login is current, a pick moves it there while it runs (LIVE-ACCOUNT). */
function LiveAccounts(props: {
  readonly threadRef: ScopedThreadRef;
  readonly accounts: ReadonlyArray<BatonAccountRecord>;
  /** The instance the composer shows, which may be a pick not yet sent. */
  readonly shownInstanceId: string;
}) {
  const logins = useLiveAccounts(props.threadRef);
  const switchTo = useLiveAccountSwitch(props.threadRef);
  const { queued, failure, cancel } = useLiveState(props.threadRef);
  const active = logins.find((login) => login.active);
  // The tick is the login the session runs as, as the header chip says (accountTicks).
  useFocusRequestedRow(props.accounts.map((account) => account.id));
  const { runsAs, setTo } = accountTicks(props.accounts, {
    storedInstanceId: LIVE_INSTANCE,
    shownInstanceId: props.shownInstanceId,
    loginKey: active?.key ?? null,
  });
  const accounts = props.accounts.filter(
    (account) => account.driver === "claudeAgent" && account.liveSwitchKey !== null,
  );
  if (accounts.length === 0) return null;
  return (
    <Section>
      {accounts.map((account) => {
        const login = logins.find((candidate) => candidate.key === account.liveSwitchKey);
        const current = runsAs?.id === account.id;
        return (
          <AccountRow
            key={account.id}
            account={account}
            current={current}
            next={queued?.accountKey !== undefined && queued.accountKey === account.liveSwitchKey}
            hint={null}
            onPick={current || login === undefined ? null : () => switchTo(login)}
          />
        );
      })}
      {setTo === undefined ? null : (
        <p className="px-1.5 pt-1 text-2xs text-muted-foreground" data-testid="thread-set-to">
          Thread set to {setTo.label}
        </p>
      )}
      {failure === null ? null : (
        <p
          className="px-1.5 pt-1 text-2xs text-destructive-foreground"
          data-testid="live-queued-failure"
        >
          Last queued change not applied: {failure}
        </p>
      )}
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
  // The thread's own instance decides, not a pick waiting in the composer: the header chip reads the same.
  const storedInstanceId = useQuietThreadShell(threadRef)?.modelSelection.instanceId;
  const onLiveThread =
    threadRef !== null &&
    isLiveThreadId(threadRef.threadId) &&
    (storedInstanceId ?? props.threadInstanceId) === LIVE_INSTANCE;
  const terminal = entry.instanceId === LIVE_INSTANCE ? <TerminalNote /> : null;
  if (onLiveThread) {
    if (entry.instanceId === LIVE_INSTANCE || entry.driverKind === "claudeAgent")
      return (
        <>
          {terminal}
          <LiveAccounts
            threadRef={threadRef}
            accounts={accounts}
            shownInstanceId={props.threadInstanceId}
          />
        </>
      );
    return <ContinueInNote name={entry.displayName} />;
  }
  if (terminal !== null) return terminal;
  // cswap-only logins too, so he sees them and how to add one.
  const mine = accounts.filter((account) => account.driver === entry.driverKind);
  if (mine.length === 0) return null;
  return <InstanceAccounts {...props} mine={mine} />;
}

function InstanceAccounts(props: {
  readonly entry: ProviderInstanceEntry;
  readonly threadRef: ScopedThreadRef | null;
  readonly threadInstanceId: ProviderInstanceId;
  readonly onPickInstance: (instanceId: ProviderInstanceId) => void;
  readonly mine: ReadonlyArray<BatonAccountRecord>;
}) {
  const { entry, threadRef, mine } = props;
  useFocusRequestedRow(mine.map((account) => account.id));
  const browsed = mine.find((account) => account.instanceIds.includes(entry.instanceId));
  // Its models are the provider's until it signs in (batonModelOptions); a send would fail, so it says so.
  const signIn =
    browsed !== undefined && (browsed.health === "signed-out" || entry.models.length === 0)
      ? browsed.label
      : null;
  const pinnable =
    threadRef !== null &&
    entry.driverKind === "claudeAgent" &&
    mine.some((account) => account.instanceIds.includes(props.threadInstanceId));
  return (
    <Section>
      {mine.map((account) => {
        const current = account.instanceIds.includes(props.threadInstanceId);
        const target = accountPickTarget(account);
        return (
          <AccountRow
            key={account.id}
            account={account}
            current={current}
            next={false}
            hint={accountPickHint(target, current)}
            onPick={
              current || target === null
                ? null
                : () => props.onPickInstance(ProviderInstanceId.make(target.instanceId))
            }
          />
        );
      })}
      {signIn === null ? null : (
        <p className="px-1.5 pt-1 text-2xs text-warning-foreground" data-testid="account-sign-in">
          Sign in to use {signIn}: Settings → Accounts & providers.
        </p>
      )}
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
