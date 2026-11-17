/**
 * Settings → Recently forgotten, mirroring web's and the desktop's: people and facts from her understanding, restorable
 * for the bin's days (`baton.household.call`). The household service decides who may restore or delete; a refusal
 * shows its line.
 */
import type { TessayaHouseholdCallInput } from "@t3tools/tessaya-contracts";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  BIN_DAY_CHOICES,
  FORGOTTEN_COPY,
  type Forgotten,
  forgottenRow,
  purgeTap,
} from "@t3tools/tessaya-shared/recentlyForgotten";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { ControlPill } from "../../components/ui/ControlPill";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { Menu } from "../../components/ui/Menu";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { tessayaWorkSessions } from "../../state/tessayaWorkSessions";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSettingsEnvironmentMenu } from "./components/SettingsEnvironmentFilterHeader";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";

const UNREACHABLE = "Couldn't reach this environment. Try again.";

export function SettingsForgottenRouteScreen() {
  const environmentMenu = useSettingsEnvironmentMenu();
  const { selectedTargets } = useSettingsEnvironmentFilter();
  const insets = useSafeAreaInsets();
  return (
    <SettingsScreen title={FORGOTTEN_COPY.section} menus={[environmentMenu]}>
      <ScreenScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {selectedTargets.length === 0 ? (
          <Text className="text-foreground-muted">
            Connect an environment to see what she forgot.
          </Text>
        ) : (
          selectedTargets.map((environment) => (
            <ForgottenSection
              key={environment.environmentId}
              environmentId={environment.environmentId}
              label={selectedTargets.length > 1 ? environment.label : null}
            />
          ))
        )}
      </ScreenScrollView>
    </SettingsScreen>
  );
}

function ForgottenSection(props: {
  readonly environmentId: EnvironmentId;
  readonly label: string | null;
}) {
  const { environmentId } = props;
  const call = useAtomCommand(tessayaWorkSessions.householdCall, { reportFailure: false });
  const [bin, setBin] = useState<{
    readonly forgotten: ReadonlyArray<Forgotten>;
    readonly days: number;
  } | null>(null);
  const [line, setLine] = useState("");
  const [confirming, setConfirming] = useState<string | null>(null);

  const read = async () => {
    const result = await call({ environmentId, input: { op: "peopleList" } });
    if (result._tag !== "Success") return setLine(UNREACHABLE);
    if (result.value.status !== "done") return setLine(result.value.line);
    setBin({ forgotten: result.value.forgotten ?? [], days: result.value.binDays ?? 30 });
  };
  const send = async (input: TessayaHouseholdCallInput) => {
    setConfirming(null);
    const result = await call({ environmentId, input });
    setLine(result._tag === "Success" ? result.value.line : UNREACHABLE);
    await read();
  };
  const purge = (id?: string) => {
    const tap = purgeTap(confirming, id);
    if ("confirm" in tap) setConfirming(tap.confirm);
    else void send(tap.send);
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the environment's bin once per environment
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect, react/exhaustive-effect-dependencies -- one read per environment
    void read();
  }, [environmentId]);

  return (
    <SettingsSection
      title={`${props.label === null ? "" : `${props.label} · `}${FORGOTTEN_COPY.section}`}
      trailing={
        bin === null ? undefined : (
          <Menu
            accessible
            accessibilityRole="button"
            accessibilityLabel={FORGOTTEN_COPY.days}
            title={FORGOTTEN_COPY.days}
            actions={BIN_DAY_CHOICES.map((n) => ({ id: String(n), title: `${n} days` }))}
            onPressAction={({ nativeEvent }) =>
              void send({ op: "peopleManage", action: "bin", days: Number(nativeEvent.event) })
            }
          >
            <ControlPill variant="pill" label={`${bin.days} days`} />
          </Menu>
        )
      }
    >
      {bin === null ? (
        line === "" ? (
          <Muted>Reading…</Muted>
        ) : null
      ) : (
        <>
          <Muted>{FORGOTTEN_COPY.hint}</Muted>
          {bin.forgotten.map((f) => {
            const row = forgottenRow(f);
            return (
              <View key={f.id} className="border-t border-border-subtle">
                <ListRowLayout
                  label={confirming === f.id ? row.confirm : row.label}
                  description={row.hint}
                />
                <View className="flex-row flex-wrap gap-2 px-4 pb-3">
                  <ControlPill
                    variant="pill"
                    label={FORGOTTEN_COPY.restore}
                    accessibilityLabel={`${FORGOTTEN_COPY.restore} ${row.label}`}
                    onPress={() => void send({ op: "peopleManage", action: "restore", id: f.id })}
                  />
                  <ControlPill
                    variant="pill"
                    label={FORGOTTEN_COPY.purge}
                    accessibilityLabel={`${FORGOTTEN_COPY.purge}: ${row.label}`}
                    onPress={() => purge(f.id)}
                  />
                </View>
              </View>
            );
          })}
          {bin.forgotten.length === 0 ? (
            <Muted>{FORGOTTEN_COPY.empty}</Muted>
          ) : (
            <View className="gap-2 border-t border-border-subtle px-4 py-3">
              <Text textRole="footnote" className="text-foreground-muted">
                {confirming === "all"
                  ? FORGOTTEN_COPY.purgeAllConfirm
                  : FORGOTTEN_COPY.purgeAllLabel}
              </Text>
              <View className="flex-row">
                <ControlPill
                  variant="pill"
                  label={FORGOTTEN_COPY.purgeAll}
                  accessibilityLabel={FORGOTTEN_COPY.purgeAllLabel}
                  onPress={() => purge()}
                />
              </View>
            </View>
          )}
        </>
      )}
      {line === "" ? null : <Muted>{line}</Muted>}
    </SettingsSection>
  );
}

function Muted(props: { readonly children: string }) {
  return (
    <Text textRole="footnote" className="px-4 py-3 text-foreground-muted">
      {props.children}
    </Text>
  );
}
