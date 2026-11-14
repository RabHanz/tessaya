/**
 * The thread header's Tessaya parts, as web's BatonThreadHeader (ACCOUNTS-3): "Terminal" on a terminal thread and the
 * thread's own account's % used in the subtitle, and a limit chip (a header button tinted amber from 80% used, red at
 * the limit) that opens the thread settings sheet on its accounts. The native header carries text and icons only.
 */
import { threadAccount } from "@t3tools/tessaya-shared/accounts";
import { roomDetail, roomTone } from "@t3tools/tessaya-shared/accountRoom";
import { isLiveThreadId, LIVE_INSTANCE } from "@t3tools/tessaya-shared/liveThread";
import type { EnvironmentId, ModelSelection, ThreadId } from "@t3tools/contracts";

import type { AppBarAction } from "../../components/ui/AppBar.types";
import { useNowMinuteMs } from "../../lib/clock";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { useEffect, useEffectEvent } from "react";
import type { ProviderGroup } from "../../lib/modelOptions";
import { useBatonAccounts, useSessionLoginKey } from "./BatonAccountRow";
import { accountsFilterKey } from "./batonCatalog";

const TONE_COLOR = {
  ok: "--color-icon",
  warn: "--color-warning-foreground",
  limit: "--color-danger-foreground",
} as const;

const settingsOpeners = new Map<string, () => void>();

// The instance whose accounts the next sheet for a thread opens on, set by the header's limit chip.
const accountsFocus = new Map<string, string>();

/** Read once by the sheet as it opens: the provider filter that puts the thread's accounts first, or null. */
export const takeAccountsFilter = (
  threadId: string | null | undefined,
  groups: ReadonlyArray<ProviderGroup>,
): string | null => {
  if (threadId == null) return null;
  const instanceId = accountsFocus.get(threadId);
  accountsFocus.delete(threadId);
  return instanceId === undefined ? null : accountsFilterKey(groups, instanceId);
};

/** The thread composer registers its settings opener here, for the header's limit chip. */
export function useBatonSettingsOpener(threadKey: string, open: () => void) {
  const run = useEffectEvent(open);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers the mounted composer's opener for the header chip
  useEffect(() => {
    const opener = () => run();
    settingsOpeners.set(threadKey, opener);
    return () => {
      if (settingsOpeners.get(threadKey) === opener) settingsOpeners.delete(threadKey);
    };
  }, [threadKey]);
}

export function useBatonThreadHeader(
  thread: {
    readonly environmentId: EnvironmentId;
    readonly id: ThreadId;
    readonly providerInstanceId: string;
    readonly modelSelection: ModelSelection;
  } | null,
): { readonly subtitle: string | null; readonly action: AppBarAction | null } {
  const accounts = useBatonAccounts(thread?.environmentId ?? null);
  const loginKey = useSessionLoginKey(thread?.environmentId ?? null, thread?.id ?? null);
  const now = useNowMinuteMs();
  const theme = useUniwindTheme();
  if (thread === null) return { subtitle: null, action: null };
  const terminal = isLiveThreadId(thread.id) && thread.providerInstanceId === LIVE_INSTANCE;
  const account = threadAccount(accounts, thread.modelSelection.instanceId, loginKey);
  const used =
    account === undefined || (account.fiveHour === null && account.weekly === null)
      ? null
      : Math.round(Math.max(account.fiveHour?.usedPercent ?? 0, account.weekly?.usedPercent ?? 0));
  const parts = [terminal ? "Terminal" : null, used === null ? null : `${used}% used`].filter(
    (part) => part !== null,
  );
  const subtitle = parts.length === 0 ? null : parts.join(" · ");
  if (account === undefined) return { subtitle, action: null };
  return {
    subtitle,
    action: {
      accessibilityLabel: [account.label, ...roomDetail(account, now)].join(". "),
      icon: terminal ? "terminal" : "chart.bar.xaxis",
      tintColor: theme[TONE_COLOR[roomTone(account)]],
      separateBackground: false,
      // Through the composer's own opener, so its presented-route guard holds against a double tap.
      onPress: () => {
        accountsFocus.set(thread.id, thread.modelSelection.instanceId);
        settingsOpeners.get(scopedThreadKey(thread.environmentId, thread.id))?.();
      },
    },
  };
}
