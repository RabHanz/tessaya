/**
 * The thread header's Tessaya parts, as web's BatonThreadHeader (ACCOUNTS-3): "Terminal" on a terminal thread and the
 * thread's own account's % used in the subtitle, and a limit chip (a header button tinted amber from 80% used, red at
 * the limit) that opens the thread settings sheet on its accounts. The native header carries text and icons only.
 */
import { threadAccount } from "@t3tools/baton-shared/accounts";
import { roomDetail, roomTone } from "@t3tools/baton-shared/accountRoom";
import { isLiveThreadId, LIVE_INSTANCE } from "@t3tools/baton-shared/liveThread";
import type { EnvironmentId, ModelSelection, ThreadId } from "@t3tools/contracts";
import { StackActions, useNavigation } from "@react-navigation/native";

import type { AppBarAction } from "../../components/ui/AppBar.types";
import { useNowMinuteMs } from "../../lib/clock";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { useBatonAccounts, useSessionLoginKey } from "./BatonAccountRow";

const TONE_COLOR = {
  ok: "--color-icon",
  warn: "--color-warning-foreground",
  limit: "--color-danger-foreground",
} as const;

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
  const navigation = useNavigation();
  if (thread === null) return { subtitle: null, action: null };
  const terminal = isLiveThreadId(thread.id) && thread.providerInstanceId === LIVE_INSTANCE;
  const account = threadAccount(accounts, thread.modelSelection.instanceId, loginKey);
  const used =
    account === undefined || (account.fiveHour === null && account.weekly === null)
      ? null
      : Math.round(Math.max(account.fiveHour?.usedPercent ?? 0, account.weekly?.usedPercent ?? 0));
  const subtitle =
    [terminal ? "Terminal" : null, used === null ? null : `${used}% used`]
      .filter(Boolean)
      .join(" · ") || null;
  if (account === undefined) return { subtitle, action: null };
  return {
    subtitle,
    action: {
      accessibilityLabel: [account.label, ...roomDetail(account, now)].join(". "),
      icon: terminal ? "terminal" : "chart.bar.xaxis",
      tintColor: theme[TONE_COLOR[roomTone(account)]],
      separateBackground: false,
      onPress: () =>
        navigation.dispatch(
          StackActions.push("ThreadSettingsSheet", {
            environmentId: thread.environmentId,
            threadId: thread.id,
            draftKey: scopedThreadKey(thread.environmentId, thread.id),
          }),
        ),
    },
  };
}
