/**
 * A Claude login on one machine, or on every paired machine that has it, as web's limits tile does: the machine's
 * login and every session with its own login move. The address names it, since cswap slots differ per machine.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import type { LimitAccount } from "@t3tools/shared/usageLimits";
import { useState } from "react";
import { Pressable, View } from "react-native";

import * as Dialog from "../../components/ui/Dialog";
import { AppText as Text } from "../../components/ui/AppText";
import { tessayaWorkSessions } from "../../state/tessayaWorkSessions";
import { useAtomCommand } from "../../state/use-atom-command";

type Machine = { readonly environmentId: EnvironmentId; readonly label: string };
type Login = { readonly key: string; readonly email?: string | null; readonly label: string };

/** A login on the named machines, each through its own environment's command, with one alert for all. */
export function useLoginOnMachines() {
  const use = useAtomCommand(tessayaWorkSessions.accountUse, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const switchOn = (machines: ReadonlyArray<Machine>, login: Login) => {
    setBusy(true);
    void Promise.all(
      machines.map((machine) =>
        use({
          environmentId: machine.environmentId,
          input: {
            key: login.key,
            reason: "manual",
            ...(login.email ? { email: login.email } : {}),
          },
        }).then((result) => (result._tag === "Success" ? null : machine.label)),
      ),
    ).then((missed) => {
      setBusy(false);
      const failed = missed.filter((name) => name !== null);
      if (failed.length === 0)
        Dialog.alert(
          machines.length === 1
            ? `${machines[0]!.label} now runs as ${login.label}`
            : `${machines.length} machines now run as ${login.label}`,
        );
      else Dialog.alert(`Not switched on ${failed.join(", ")}`);
    });
  };
  return { busy, switchOn };
}

export function AccountMachineSwitch({ account }: { readonly account: LimitAccount }) {
  const { busy, switchOn } = useLoginOnMachines();
  const key = account.limits.credentialFingerprint;
  if (account.driver !== "claudeAgent" || key === undefined || account.environments.length === 0)
    return null;
  const login = {
    key,
    email: account.email ?? null,
    label: account.displayName ?? account.email ?? "this login",
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
        row(`On ${environment.label}`, () => switchOn([environment], login)),
      )}
      {account.environments.length > 1
        ? row("On every machine", () => switchOn(account.environments, login))
        : null}
    </View>
  );
}
