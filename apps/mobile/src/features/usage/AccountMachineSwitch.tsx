/**
 * A Claude login on one machine, or on every paired machine that has it, as web's limits tile does: the machine's
 * login and every session with its own login move. The address names it, since cswap slots differ per machine.
 */
import type { LimitAccount } from "@t3tools/shared/usageLimits";
import { useState } from "react";
import { Pressable, View } from "react-native";

import * as Dialog from "../../components/ui/Dialog";
import { AppText as Text } from "../../components/ui/AppText";
import { tessayaWorkSessions } from "../../state/tessayaWorkSessions";
import { useAtomCommand } from "../../state/use-atom-command";

export function AccountMachineSwitch({ account }: { readonly account: LimitAccount }) {
  const use = useAtomCommand(tessayaWorkSessions.accountUse, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const key = account.limits.credentialFingerprint;
  if (account.driver !== "claudeAgent" || key === undefined || account.environments.length === 0)
    return null;
  const label = account.displayName ?? account.email ?? "this login";
  const switchOn = (environments: LimitAccount["environments"]) => {
    setBusy(true);
    void Promise.all(
      environments.map((environment) =>
        use({
          environmentId: environment.environmentId,
          input: {
            key,
            reason: "manual",
            ...(account.email === undefined ? {} : { email: account.email }),
          },
        }).then((result) => (result._tag === "Success" ? null : environment.label)),
      ),
    ).then((missed) => {
      setBusy(false);
      const failed = missed.filter((name) => name !== null);
      if (failed.length === 0)
        Dialog.alert(
          environments.length === 1
            ? `${environments[0]!.label} now runs as ${label}`
            : `Every machine now runs as ${label}`,
        );
      else Dialog.alert(`Not switched on ${failed.join(", ")}`);
    });
  };
  const row = (text: string, onPress: () => void) => (
    <Pressable
      key={text}
      accessibilityRole="button"
      disabled={busy}
      onPress={onPress}
      className="min-h-11 justify-center active:opacity-60"
    >
      <Text className="text-sm font-t3-medium text-primary">{text}</Text>
    </Pressable>
  );
  return (
    <View className="gap-1 rounded-[24px] border-continuous bg-grouped-card p-4">
      <Text className="text-sm font-t3-medium text-foreground">Use this login</Text>
      {account.environments.map((environment) =>
        row(`On ${environment.label}`, () => switchOn([environment])),
      )}
      {account.environments.length > 1
        ? row("On every machine", () => switchOn(account.environments))
        : null}
    </View>
  );
}
