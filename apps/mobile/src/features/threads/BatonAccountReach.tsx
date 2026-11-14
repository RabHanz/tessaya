/**
 * One level under an account row in the thread sheet, as web's BatonAccountReach (B-032): the row's tap is this
 * thread; this moves every session on this machine, on the machines he ticks, or on every one with the login.
 */
import { useAtomValue } from "@effect/atom-react";
import type { BatonAccountRecord } from "@t3tools/tessaya-contracts";
import { machinesWithLogin } from "@t3tools/tessaya-shared/accounts";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom, AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { ThemedSwitch } from "../../components/ui/ThemedSwitch";
import { batonWorkSessions } from "../../state/batonWorkSessions";
import { useEnvironments } from "../../state/environments";
import { useLoginOnMachines } from "../usage/AccountMachineSwitch";

/** Each machine's logins, read only while the panel is open. */
const machineLoginsAtom = Atom.family((ids: string) =>
  Atom.make((get) =>
    (JSON.parse(ids) as ReadonlyArray<EnvironmentId>).map(
      (environmentId) =>
        [
          environmentId,
          Option.getOrNull(
            AsyncResult.value(get(batonWorkSessions.accountsQuery({ environmentId, input: {} }))),
          )?.accounts ?? [],
        ] as const,
    ),
  ).pipe(Atom.withLabel(`baton-machine-logins:${ids}`)),
);

function Choice(props: {
  readonly label: string;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={props.disabled}
      onPress={props.onPress}
      className="min-h-11 justify-center px-2 active:opacity-60"
    >
      <Text
        className={
          props.disabled
            ? "text-sm font-t3-medium text-foreground-muted"
            : "text-sm font-t3-medium text-primary"
        }
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

function ReachPanel(props: {
  readonly account: BatonAccountRecord;
  readonly loginKey: string;
  readonly environmentId: EnvironmentId;
}) {
  const { environments } = useEnvironments();
  const all = environments.map(({ environmentId, label }) => ({ environmentId, label }));
  const others = all.filter((machine) => machine.environmentId !== props.environmentId);
  const logins = new Map(
    useAtomValue(machineLoginsAtom(JSON.stringify(others.map((machine) => machine.environmentId)))),
  );
  const machines = machinesWithLogin(
    all.find((machine) => machine.environmentId === props.environmentId) ?? {
      environmentId: props.environmentId,
      label: "This machine",
    },
    others,
    (machine) => logins.get(machine.environmentId) ?? [],
    props.account.email,
  );
  const { busy, switchOn } = useLoginOnMachines();
  const [chosen, setChosen] = useState<ReadonlySet<EnvironmentId> | null>(null);
  const login = { key: props.loginKey, email: props.account.email, label: props.account.label };
  const picked = machines.filter((machine) => chosen?.has(machine.environmentId));
  const here = props.account.active === true;
  return (
    <View className="px-4 pb-2">
      <Text className="text-2xs text-foreground-muted">Every session on</Text>
      <View className="flex-row flex-wrap">
        <Choice
          label={here ? "This machine ✓" : "This machine"}
          disabled={busy || here}
          onPress={() => switchOn(machines.slice(0, 1), login)}
        />
        {machines.length > 1 ? (
          <>
            <Choice
              label={`All ${machines.length}`}
              disabled={busy}
              onPress={() => switchOn(machines, login)}
            />
            <Choice
              label={chosen === null ? "Choose" : "Done choosing"}
              disabled={false}
              onPress={() => setChosen(chosen === null ? new Set() : null)}
            />
          </>
        ) : null}
      </View>
      {chosen === null ? null : (
        <View>
          {machines.map((machine) => (
            <View key={machine.environmentId} className="min-h-11 flex-row items-center gap-2 px-2">
              <Text className="flex-1 text-sm text-foreground" numberOfLines={1}>
                {machine.label}
              </Text>
              <ThemedSwitch
                accessibilityLabel={machine.label}
                value={chosen.has(machine.environmentId)}
                onValueChange={(on) => {
                  const next = new Set(chosen);
                  if (on) next.add(machine.environmentId);
                  else next.delete(machine.environmentId);
                  setChosen(next);
                }}
              />
            </View>
          ))}
          <Choice
            label={picked.length === 0 ? "Tick a machine" : `Switch ${picked.length}`}
            disabled={busy || picked.length === 0}
            onPress={() => switchOn(picked, login)}
          />
        </View>
      )}
    </View>
  );
}

/** The row's trailing chevron; nothing for a login that can't move machines. */
export function BatonAccountReachToggle(props: {
  readonly account: BatonAccountRecord;
  readonly open: boolean;
  readonly onToggle: () => void;
}) {
  if (props.account.driver !== "claudeAgent" || props.account.liveSwitchKey === null) return null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Use ${props.account.label} on this machine or others`}
      accessibilityState={{ expanded: props.open }}
      hitSlop={8}
      onPress={props.onToggle}
      className="size-8 items-center justify-center active:opacity-60"
    >
      <SymbolView
        name={props.open ? "chevron.up" : "chevron.down"}
        size={12}
        tintColorClassName="accent-foreground-muted"
        type="monochrome"
      />
    </Pressable>
  );
}

export function BatonAccountReach(props: {
  readonly account: BatonAccountRecord;
  readonly environmentId: EnvironmentId;
}) {
  if (props.account.liveSwitchKey === null) return null;
  return (
    <ReachPanel
      account={props.account}
      loginKey={props.account.liveSwitchKey}
      environmentId={props.environmentId}
    />
  );
}
