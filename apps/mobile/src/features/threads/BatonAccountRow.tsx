/**
 * The account under each provider in the model sheet (T6, as web's BatonPickerAccount): who it runs as, its room left,
 * and on the thread's own Claude instance the "Keep on this account" pin, which automatic rotation respects.
 */
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { instanceAccount, type BatonAccount } from "@t3tools/baton-contracts";
import { accountRow } from "@t3tools/baton-shared/accountRoom";
import { isLiveThreadId, LIVE_INSTANCE } from "@t3tools/baton-shared/liveThread";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { ThemedSwitch } from "../../components/ui/ThemedSwitch";
import { batonWorkSessions } from "../../state/batonWorkSessions";
import { environmentServerConfigsAtom } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

function RunsAs({ account }: { readonly account: BatonAccount }) {
  // The sheet is short-lived: the reading's age as of opening it is enough.
  const [now] = useState(Date.now);
  return (
    <Text className="text-2xs text-foreground-muted" numberOfLines={1}>
      Runs as {account.label} · {accountRow(account, now)}
    </Text>
  );
}

export function BatonAccountRow(props: {
  readonly environmentId: EnvironmentId | null;
  readonly instanceId: string;
  /** The thread whose instance this is; it carries the pin. */
  readonly pinThreadId: ThreadId | null;
}) {
  const configs = useAtomValue(environmentServerConfigsAtom);
  const provider =
    props.environmentId === null
      ? undefined
      : configs
          .get(props.environmentId)
          ?.providers.find((entry) => entry.instanceId === props.instanceId);
  if (props.environmentId === null) return null;
  // A terminal session may run on its own login (LIVE-ACCOUNT), which this sheet does not read: say nothing.
  if (props.instanceId === LIVE_INSTANCE) return null;
  if (provider === undefined) return null;
  const email = provider.auth.email?.trim() ?? "";
  if (provider.usageLimits === undefined && email === "") return null;
  const account = instanceAccount(provider, true);
  const pinnable =
    props.pinThreadId !== null &&
    !isLiveThreadId(props.pinThreadId) &&
    provider.driver === "claudeAgent";
  return (
    <View className="mx-4 gap-1 px-1 pb-1">
      <RunsAs account={account} />
      {pinnable && props.pinThreadId !== null ? (
        <KeepSwitch environmentId={props.environmentId} threadId={props.pinThreadId} />
      ) : null}
    </View>
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
    <View className="min-h-9 flex-row items-center justify-between">
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
