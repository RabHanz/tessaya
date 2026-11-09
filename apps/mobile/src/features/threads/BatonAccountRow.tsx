/**
 * The accounts under each provider in the thread settings sheet, as web's BatonPickerAccount (ACCOUNTS-2): one row per
 * real login with its sign-in badges and % used, the "Keep on this account" pin, and on a terminal thread the
 * session's own login, a move to another while it runs, and the change queued for when its turn ends.
 */
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { accountForInstance, type BatonAccountRecord } from "@t3tools/baton-contracts";
import { keepsDraft, liveChangeRoute } from "@t3tools/baton-shared/liveModel";
import { accountTicks } from "@t3tools/baton-shared/accounts";
import {
  maskedEmail,
  queuedText,
  resetLabel,
  roomText,
  roomTone,
} from "@t3tools/baton-shared/accountRoom";
import {
  isLiveThreadId,
  LIVE_INSTANCE,
  liveSessionIdOf,
  liveThreadIdOf,
} from "@t3tools/baton-shared/liveThread";
import type { EnvironmentId, ModelSelection, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom, AsyncResult } from "effect/reactivity";
import { Fragment, useEffect, useState } from "react";
import { Pressable, View } from "react-native";

import * as Dialog from "../../components/ui/Dialog";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { ThemedSwitch } from "../../components/ui/ThemedSwitch";
import { cn } from "../../lib/cn";
import { useNowMinuteMs } from "../../lib/clock";
import type { ModelOption, ProviderGroup } from "../../lib/modelOptions";
import { batonWorkSessions } from "../../state/batonWorkSessions";
import { useAtomCommand } from "../../state/use-atom-command";
import { accountPickOption, loadedLoginKey, type SessionLogin } from "./batonCatalog";
import { useOpenLinkedThread } from "./useOpenLinkedThread";

const NOTHING = Atom.make(AsyncResult.initial<never, never>(false));

const METHOD_LABEL = { "setup-token": "token", browser: "browser", "api-key": "API key" } as const;
const TONE_CLASS = {
  ok: "text-foreground-muted",
  warn: "text-warning-foreground",
  limit: "text-danger-foreground",
} as const;

/** One record per real account on the environment (baton.accounts.list). */
export function useBatonAccounts(
  environmentId: EnvironmentId | null,
): ReadonlyArray<BatonAccountRecord> {
  const result = useAtomValue(
    environmentId === null
      ? NOTHING
      : batonWorkSessions.accountsQuery({ environmentId, input: {} }),
  );
  return Option.getOrNull(AsyncResult.value(result))?.accounts ?? [];
}

const liveStateAtom = (environmentId: EnvironmentId, sessionId: string | null) =>
  sessionId === null
    ? NOTHING
    : batonWorkSessions.liveStateQuery({ environmentId, input: { sessionId } });

/** Moves a terminal session to another login while it runs, or queues the move while it works. */
function useLiveAccountMove(
  environmentId: EnvironmentId,
  sessionId: string | null,
  onMoved: (accountKey: string) => void,
) {
  const setAccount = useAtomCommand(batonWorkSessions.liveSetAccount, { reportFailure: false });
  const refresh = useAtomRefresh(liveStateAtom(environmentId, sessionId));
  const moveTo = (accountKey: string, restart = false) => {
    if (sessionId === null) return;
    void setAccount({
      environmentId,
      input: { sessionId, accountKey, ...(restart ? { restart: true } : {}) },
    }).then((result) => {
      if (result._tag !== "Success") {
        Dialog.alert("Could not reach the session");
        return;
      }
      const { state: outcome, detail } = result.value;
      if (result.value.queued === true) refresh();
      else if (outcome === "switched" || outcome === "unchanged") onMoved(accountKey);
      else if (outcome === "needs_restart")
        Dialog.confirm({
          title: "Make this thread switchable",
          message: detail,
          confirmText: "Restart once and switch",
          onConfirm: () => moveTo(accountKey, true),
        });
      else Dialog.alert("Not switched", detail);
    });
  };
  return moveTo;
}

const effortOf = (selection: ModelSelection): string | null => {
  const value = selection.options?.find((option) => option.id === "effort")?.value;
  return typeof value === "string" ? value : null;
};

/**
 * A model or effort pick in the sheet on a terminal thread, sent the way web sends it (liveChangeRoute): into the
 * session, which answers or queues it while it works (shown as Next · Cancel), or a move to another login. Returns
 * false when the pick belongs in the draft as on any other thread; `keep` stores a pick the session confirmed.
 */
export function useLiveSheetChange(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  sessionEffort: string | null,
) {
  const sessionId = liveSessionIdOf(threadId);
  const pool = useAtomValue(
    sessionId === null ? NOTHING : batonWorkSessions.accountPoolQuery({ environmentId, input: {} }),
  );
  const loginKey = useSessionLoginKey(environmentId, threadId);
  const setModel = useAtomCommand(batonWorkSessions.liveSetModel, { reportFailure: false });
  const refresh = useAtomRefresh(liveStateAtom(environmentId, sessionId));
  const moveTo = useLiveAccountMove(environmentId, sessionId, () => undefined);
  return (
    current: ModelSelection,
    picked: ModelSelection,
    pickedDriver: string | null,
    keep: () => void,
  ): boolean => {
    if (sessionId === null) return false;
    const login = accountForInstance(
      picked.instanceId,
      Option.getOrNull(AsyncResult.value(pool))?.accounts ?? [],
    );
    const route = liveChangeRoute({
      threadId,
      currentInstance: current.instanceId,
      picked: {
        instance: picked.instanceId,
        driver: pickedDriver,
        model: picked.model,
        effort: effortOf(picked),
      },
      current: { model: current.model, effort: sessionEffort ?? effortOf(current) },
      account:
        login === undefined || loginKey === null
          ? { relation: "unknown", key: null }
          : { relation: login.key === loginKey ? "same" : "other", key: login.key },
    });
    if (keepsDraft(route)) {
      keep();
      return true;
    }
    if (route.kind === "account") moveTo(route.key);
    else if (route.kind === "continue-in")
      Dialog.alert(
        "Continue in a new thread",
        "A terminal session only runs Claude on a login this machine knows. Continuing in another provider opens a new thread: do that from web or desktop.",
      );
    else if (route.kind === "session")
      void setModel({ environmentId, input: { sessionId, ...route.change } }).then((result) => {
        if (result._tag !== "Success") {
          Dialog.alert("Could not reach the session");
          return;
        }
        const { state, detail } = result.value;
        if (result.value.queued === true) refresh();
        else if (state === "applied") keep();
        else Dialog.alert(state === "busy" ? "It is working" : "Not changed", detail);
      });
    return true;
  };
}

/** The effort a terminal thread's session really runs at, or null on any other thread. */
export function useSessionEffort(environmentId: EnvironmentId, threadId: string): string | null {
  const sessionId = liveSessionIdOf(threadId);
  const state = useAtomValue(
    sessionId === null
      ? NOTHING
      : batonWorkSessions.liveStateQuery({ environmentId, input: { sessionId } }),
  );
  return Option.getOrNull(AsyncResult.value(state))?.effort ?? null;
}

/**
 * The cswap key a terminal thread's session runs as, from the session catalog's login (read once per mount), else
 * the machine's active one. Null on any other thread.
 */
export function useSessionLoginKey(
  environmentId: EnvironmentId | null,
  threadId: string | null,
): string | null {
  const sessionId = threadId === null ? null : liveSessionIdOf(threadId);
  const live = environmentId !== null && sessionId !== null;
  const pool = useAtomValue(
    live ? batonWorkSessions.accountPoolQuery({ environmentId, input: {} }) : NOTHING,
  );
  const list = useAtomCommand(batonWorkSessions.sessionsList, { reportFailure: false });
  const [read, setRead] = useState<SessionLogin | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the server's session catalog for this session's login
  useEffect(() => {
    if (environmentId === null || sessionId === null) return;
    let cancelled = false;
    void list({ environmentId, input: { query: sessionId, limit: 10 } }).then((result) => {
      if (cancelled || result._tag !== "Success") return;
      setRead({
        sessionId,
        login: result.value.sessions.find((row) => row.id === sessionId)?.account ?? null,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [environmentId, list, sessionId]);
  if (!live) return null;
  return loadedLoginKey(read, sessionId, Option.getOrNull(AsyncResult.value(pool))?.accounts ?? []);
}

function Badge(props: { readonly label: string; readonly tone?: "info" | "warn" | "error" }) {
  return (
    <View
      className={cn(
        "rounded px-1",
        props.tone === "info"
          ? "bg-primary/10"
          : props.tone === "warn"
            ? "bg-warning/15"
            : props.tone === "error"
              ? "bg-danger/15"
              : "border border-border-subtle",
      )}
    >
      <Text
        className={cn(
          "text-[10px] font-t3-medium",
          props.tone === "info"
            ? "text-primary"
            : props.tone === "warn"
              ? "text-warning-foreground"
              : props.tone === "error"
                ? "text-danger-foreground"
                : "text-foreground-muted",
        )}
      >
        {props.label}
      </Text>
    </View>
  );
}

function AccountRow(props: {
  readonly account: BatonAccountRecord;
  readonly current: boolean;
  readonly next: boolean;
  readonly isLast: boolean;
  readonly onPick: (() => void) | null;
}) {
  const { account } = props;
  const now = useNowMinuteMs();
  const room = roomText(account, now);
  const paused = account.health === "paused";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[account.label, room].filter(Boolean).join(", ")}
      accessibilityState={{ selected: props.current, disabled: props.onPick === null || paused }}
      disabled={props.onPick === null || paused}
      onPress={props.onPick ?? undefined}
      className={cn(
        "min-h-11 flex-row items-center gap-2 px-4 py-1.5 active:opacity-60",
        !props.isLast && "border-b border-border-subtle",
      )}
    >
      <View className="min-w-0 flex-1 gap-0.5">
        <View className="flex-row flex-wrap items-center gap-1">
          <Text className="shrink text-sm font-t3-medium text-foreground" numberOfLines={1}>
            {account.label}
          </Text>
          {account.methods.map((method) => (
            <Badge key={method.kind} label={METHOD_LABEL[method.kind]} />
          ))}
          {props.next ? <Badge label="Next" tone="info" /> : null}
          {paused ? (
            <Badge label="Paused · resume in Settings" tone="warn" />
          ) : account.health === "signed-out" ? (
            <Badge label="Signed out" tone="error" />
          ) : null}
        </View>
        {account.email === null ? null : (
          <Text className="text-2xs text-foreground-muted" numberOfLines={1}>
            {maskedEmail(account.email)}
          </Text>
        )}
      </View>
      {room === null ? null : (
        <Text className={cn("text-xs tabular-nums", TONE_CLASS[roomTone(account)])}>{room}</Text>
      )}
      {props.current ? (
        <SymbolView
          name="checkmark"
          size={13}
          tintColorClassName="accent-primary"
          type="monochrome"
        />
      ) : null}
    </Pressable>
  );
}

function Card(props: { readonly title: string; readonly children: React.ReactNode }) {
  return (
    <View className="mx-4 mb-1 mt-1 gap-1">
      <Text className="px-1 text-2xs font-t3-medium text-foreground-muted">{props.title}</Text>
      <View className="overflow-hidden rounded-2xl bg-grouped-card">{props.children}</View>
    </View>
  );
}

type TerminalRow = {
  readonly id: string;
  readonly project: string;
  readonly title: string;
  readonly pane: string | null;
  readonly lastActivityAt: string | null;
};

/** The Terminal group's sessions running here now; a tap opens its thread. */
function TerminalSessions(props: { readonly environmentId: EnvironmentId }) {
  const list = useAtomCommand(batonWorkSessions.sessionsList, { reportFailure: false });
  const open = useOpenLinkedThread();
  const now = useNowMinuteMs();
  const [rows, setRows] = useState<ReadonlyArray<TerminalRow> | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the server's session catalog while the sheet shows Terminal
  useEffect(() => {
    let cancelled = false;
    void list({ environmentId: props.environmentId, input: { limit: 30 } }).then((result) => {
      if (cancelled || result._tag !== "Success") return;
      setRows(
        result.value.sessions
          .filter((session) => session.state === "running" && session.source === "live")
          .map((session) => ({
            id: session.id,
            project: session.project,
            title: session.title,
            pane: session.pane ?? null,
            lastActivityAt: session.lastActivityAt,
          })),
      );
    });
    return () => {
      cancelled = true;
    };
  }, [list, props.environmentId]);
  if (rows === null) return null;
  return (
    <Card title="Sessions running in a terminal. Tessaya types into them.">
      {rows.length === 0 ? (
        <Text className="px-4 py-3 text-sm text-foreground-muted">None running here now.</Text>
      ) : (
        rows.map((row, index) => (
          <Pressable
            key={row.id}
            accessibilityRole="button"
            onPress={() =>
              open({ environmentId: props.environmentId, threadId: liveThreadIdOf(row.id) })
            }
            className={cn(
              "min-h-11 flex-row items-center gap-2 px-4 py-1.5 active:opacity-60",
              index < rows.length - 1 && "border-b border-border-subtle",
            )}
          >
            <View className="min-w-0 flex-1">
              <Text className="text-sm font-t3-medium text-foreground" numberOfLines={1}>
                {row.project}
              </Text>
              <Text className="text-2xs text-foreground-muted" numberOfLines={1}>
                {row.title}
              </Text>
            </View>
            <Text className="text-2xs text-foreground-muted">
              {[
                row.pane?.split("~").at(-1),
                row.lastActivityAt === null ? null : resetLabel(row.lastActivityAt, now),
              ]
                .filter(Boolean)
                .join(" · ")}
            </Text>
          </Pressable>
        ))
      )}
    </Card>
  );
}

/** A terminal session's logins: its own is current, a tap moves it there while it runs, or queues the move. */
function LiveAccounts(props: {
  readonly environmentId: EnvironmentId;
  readonly sessionId: string;
  readonly loginKey: string | null;
  readonly accounts: ReadonlyArray<BatonAccountRecord>;
  /** The instance the sheet shows, which may be a pick not yet saved. */
  readonly shownInstanceId: string;
}) {
  const stateAtom = batonWorkSessions.liveStateQuery({
    environmentId: props.environmentId,
    input: { sessionId: props.sessionId },
  });
  const state = Option.getOrNull(AsyncResult.value(useAtomValue(stateAtom)));
  const refresh = useAtomRefresh(stateAtom);
  const cancelQueued = useAtomCommand(batonWorkSessions.liveCancelQueued, {
    reportFailure: false,
  });
  // Moved here, the catalog's login catches up later; the check should not wait for it.
  const [movedTo, setMovedTo] = useState<string | null>(null);
  const loginKey = movedTo ?? props.loginKey;
  const accounts = props.accounts.filter(
    (account) => account.driver === "claudeAgent" && account.liveSwitchKey !== null,
  );
  const moveTo = useLiveAccountMove(props.environmentId, props.sessionId, setMovedTo);
  const queued = state?.queued ?? null;
  const failure = state?.failure ?? null;
  // The tick is the login the session runs as, as the header chip says; a waiting pick is named apart.
  const { runsAs, setTo } = accountTicks(props.accounts, {
    storedInstanceId: LIVE_INSTANCE,
    shownInstanceId: props.shownInstanceId,
    loginKey,
  });
  if (accounts.length === 0 && queued === null && failure === null) return null;
  return (
    <Card title="Account · % used">
      {accounts.map((account, index) => {
        const current = runsAs?.id === account.id;
        return (
          <AccountRow
            key={account.id}
            account={account}
            current={current}
            next={queued?.accountKey !== undefined && queued.accountKey === account.liveSwitchKey}
            isLast={index === accounts.length - 1 && queued === null && failure === null}
            onPick={
              current || account.liveSwitchKey === null
                ? null
                : () => moveTo(account.liveSwitchKey!)
            }
          />
        );
      })}
      {setTo === undefined ? null : (
        <Text className="px-4 py-2 text-2xs text-foreground-muted">
          Thread set to {setTo.label}
        </Text>
      )}
      {failure === null ? null : (
        <Text className="px-4 py-2 text-2xs text-danger-foreground">
          Last queued change not applied: {failure}
        </Text>
      )}
      {queued === null ? null : (
        <View className="min-h-11 flex-row items-center gap-2 px-4">
          <Text className="min-w-0 flex-1 text-2xs text-foreground-muted">
            Next · {queuedText(queued, props.accounts)}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Cancel the queued change"
            className="min-h-9 justify-center px-2 active:opacity-60"
            onPress={() =>
              void cancelQueued({
                environmentId: props.environmentId,
                input: { sessionId: props.sessionId },
              }).then(refresh)
            }
          >
            <Text className="text-sm font-t3-medium text-primary">Cancel</Text>
          </Pressable>
        </View>
      )}
    </Card>
  );
}

/**
 * Under a provider's header: its accounts, one row per real login. A tap on another login makes it the pending pick,
 * which Save commits as the user's own choice (a provider change needs one); on a terminal thread the
 * Terminal group's rows move the session instead.
 */
export function BatonAccountRow(props: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
  readonly provider: { readonly key: string; readonly driver: string | undefined };
  /** Every login's models, before the sheet groups them by provider. */
  readonly groups: ReadonlyArray<ProviderGroup>;
  /** The thread's applied instance. */
  readonly appliedInstanceId: string | undefined;
  /** The pick shown: pending, else applied. */
  readonly displayed: ModelSelection | null;
  readonly onPick: (option: ModelOption) => void;
}) {
  const accounts = useBatonAccounts(props.environmentId);
  const loginKey = useSessionLoginKey(props.environmentId, props.threadId);
  if (props.environmentId === null) return null;
  const sessionId = props.threadId === null ? null : liveSessionIdOf(props.threadId);
  const terminal =
    props.provider.key === LIVE_INSTANCE ? (
      <TerminalSessions environmentId={props.environmentId} />
    ) : null;
  if (sessionId !== null && props.appliedInstanceId === LIVE_INSTANCE) {
    // Once, under Terminal: the session's logins are its own, not the Claude group's.
    if (props.provider.key !== LIVE_INSTANCE) return null;
    return (
      <>
        {terminal}
        <LiveAccounts
          environmentId={props.environmentId}
          sessionId={sessionId}
          loginKey={loginKey}
          accounts={accounts}
          shownInstanceId={props.displayed?.instanceId ?? LIVE_INSTANCE}
        />
      </>
    );
  }
  if (terminal !== null) return terminal;
  const mine = accounts.filter(
    (account) => account.driver === props.provider.driver && account.instanceIds.length > 0,
  );
  if (mine.length === 0) return null;
  const applied = props.appliedInstanceId ?? "";
  const shown = props.displayed?.instanceId ?? applied;
  const appliedGroup = props.groups.find((group) => group.providerKey === applied);
  const thread = {
    driver: appliedGroup?.models[0]?.providerDriver ?? "",
    model: props.displayed?.model ?? "",
  };
  const pinnable =
    props.threadId !== null &&
    !isLiveThreadId(props.threadId) &&
    props.provider.driver === "claudeAgent" &&
    mine.some((account) => account.instanceIds.includes(applied));
  return (
    <Card title="Account · % used">
      {mine.map((account, index) => {
        const current = account.instanceIds.includes(applied);
        const option = accountPickOption(account, props.groups, thread);
        return (
          <Fragment key={account.id}>
            <AccountRow
              account={account}
              current={current}
              next={!current && account.instanceIds.includes(shown)}
              isLast={index === mine.length - 1 && !pinnable && (current || option !== null)}
              onPick={current || option === null ? null : () => props.onPick(option)}
            />
            {/* Its instance lists no models (signed out or not probed), so a tap would land nowhere. */}
            {current || option !== null ? null : (
              <Text className="px-4 pb-2 text-2xs text-warning-foreground">
                Sign in to use {account.label}: Settings → Accounts & providers.
              </Text>
            )}
          </Fragment>
        );
      })}
      {pinnable && props.threadId !== null ? (
        <KeepSwitch environmentId={props.environmentId} threadId={props.threadId} />
      ) : null}
    </Card>
  );
}

function KeepSwitch(props: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId }) {
  const keptAtom = batonWorkSessions.threadKeptQuery({
    environmentId: props.environmentId,
    input: { threadId: props.threadId },
  });
  const query = useAtomValue(keptAtom);
  const refresh = useAtomRefresh(keptAtom);
  const setKeep = useAtomCommand(batonWorkSessions.threadKeep, "keep on this account");
  // Null on an older server, which has no such setting.
  const keep = Option.getOrNull(AsyncResult.value(query))?.keep ?? null;
  if (keep === null) return null;
  return (
    <View className="min-h-11 flex-row items-center justify-between px-4">
      <Text className="text-sm text-foreground">Keep on this account</Text>
      <ThemedSwitch
        accessibilityLabel="Keep on this account"
        value={keep}
        onValueChange={(next) =>
          void setKeep({
            environmentId: props.environmentId,
            input: { threadId: props.threadId, keep: next },
          }).then((result) => {
            if (result._tag === "Success") refresh();
          })
        }
      />
    </View>
  );
}
