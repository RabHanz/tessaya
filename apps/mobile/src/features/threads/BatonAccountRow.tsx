/**
 * The account under each provider in the model sheet (T6, as web's BatonPickerAccount): who it runs as, its room left,
 * and on the thread's own Claude instance the "Keep on this account" pin, which automatic rotation respects.
 */
import { useAtomValue } from "@effect/atom-react";
import { accountReturnsAt, instanceAccount, type BatonAccount } from "@t3tools/baton-contracts";
import { isLiveThreadId } from "@t3tools/baton-shared/liveThread";
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

export function accountRoom(account: BatonAccount): string {
  const returnsAt = accountReturnsAt(account);
  if (returnsAt !== null) {
    const when = new Date(returnsAt).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
    return `out until ${when}`;
  }
  return account.headroomPercent === null ? "limits unknown" : `${account.headroomPercent}% left`;
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
  if (provider === undefined || props.environmentId === null) return null;
  const email = provider.auth.email?.trim() ?? "";
  if (provider.usageLimits === undefined && email === "") return null;
  const account = instanceAccount(provider, true);
  const pinnable =
    props.pinThreadId !== null &&
    !isLiveThreadId(props.pinThreadId) &&
    provider.driver === "claudeAgent";
  return (
    <View className="mx-4 gap-1 px-1 pb-1">
      <Text className="text-2xs text-foreground-muted" numberOfLines={1}>
        Runs as {account.label} · {accountRoom(account)}
      </Text>
      {pinnable && props.pinThreadId !== null ? (
        <KeepSwitch environmentId={props.environmentId} threadId={props.pinThreadId} />
      ) : null}
    </View>
  );
}

function KeepSwitch(props: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId }) {
  const query = useAtomValue(
    batonWorkSessions.threadKeptQuery({
      environmentId: props.environmentId,
      input: { threadId: props.threadId },
    }),
  );
  const setKeep = useAtomCommand(batonWorkSessions.threadKeep, "keep on this account");
  const [chosen, setChosen] = useState<boolean | null>(null);
  const stored = Option.getOrNull(AsyncResult.value(query))?.keep ?? null;
  // An older server has no such setting.
  if (stored === null) return null;
  const keep = chosen ?? stored;
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
            if (result._tag === "Success") setChosen(result.value.keep);
          })
        }
      />
    </View>
  );
}
