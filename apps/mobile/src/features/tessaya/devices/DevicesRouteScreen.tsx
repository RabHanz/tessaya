/**
 * Devices (phone redesign v2): every body she lives in, one line each, then the house. Each Tessel's controls and
 * diagnostics stay one tap in, on the Tessels page, so the list is the first thing he sees.
 */
import { useAtomValue } from "@effect/atom-react";
import type { DevicesOverview } from "@t3tools/tessaya-contracts";
import { phoneManifest } from "@t3tools/tessaya-shared/phoneDevice";
import * as Device from "expo-device";
import { useEffect, useState } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../../components/ui/AppText";
import { ScreenScrollView } from "../../../components/ui/ScreenScrollView";
import { tessayaEnvironmentIdAtom } from "../../../state/tessayaHousehold";
import { tessayaWorkSessions } from "../../../state/tessayaWorkSessions";
import { useAtomCommand } from "../../../state/use-atom-command";
import { SettingsRow } from "../../settings/components/SettingsRow";
import { SettingsScreen } from "../../settings/components/SettingsScreen";
import { SettingsSection } from "../../settings/components/SettingsSection";
import { deviceRows } from "./devicesList.logic";

const REFRESH_MS = 15_000;

/** This phone's id in the device registry, as its Talk tab and Tessels page publish it. */
export const thisPhoneId = () =>
  phoneManifest({
    installId: `${Device.modelName ?? ""}${Device.deviceName ?? ""}`,
    model: Device.modelName ?? null,
    os: null,
    motion: Device.isDevice,
  }).deviceId;

export function DevicesRouteScreen() {
  const environmentId = useAtomValue(tessayaEnvironmentIdAtom);
  const insets = useSafeAreaInsets();
  const devicesCall = useAtomCommand(tessayaWorkSessions.devicesCall, { reportFailure: false });
  const [view, setView] = useState<DevicesOverview | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- follows the registry's online states while the list shows
  useEffect(() => {
    if (environmentId === null) return;
    const read = () =>
      void devicesCall({ environmentId, input: { kind: "read", op: "list", args: {} } }).then(
        (r) => {
          if (r._tag === "Success" && r.value.ok) setView(r.value.value as DevicesOverview);
        },
      );
    read();
    const timer = setInterval(read, REFRESH_MS);
    return () => clearInterval(timer);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- once per environment; the command is stable
  }, [environmentId]);
  const rows = deviceRows(view?.registry ?? [], thisPhoneId());
  return (
    <SettingsScreen title="Devices">
      <ScreenScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <Text className="text-sm text-foreground-muted">
          Where she lives, and what each body is doing.
        </Text>
        {environmentId === null ? (
          <Text className="text-foreground-muted">Pair a computer to see her devices.</Text>
        ) : (
          <>
            <SettingsSection>
              {view === null ? (
                <Text className="px-4 py-3 text-foreground-muted">Reading…</Text>
              ) : (
                rows.map((r) => (
                  <SettingsRow
                    key={r.id}
                    icon={
                      r.kind === "tessel"
                        ? "face.smiling"
                        : r.kind === "desktop"
                          ? "desktopcomputer"
                          : "iphone"
                    }
                    label={r.name}
                    value={r.line}
                    valuePosition="below"
                    {...(r.kind === "tessel" ? { target: "SettingsHardware" as const } : {})}
                  />
                ))
              )}
              <SettingsRow icon="plus" label="Add a Tessel" target="SettingsHardware" />
            </SettingsSection>
            <SettingsSection title="The house">
              <SettingsRow icon="house" label="Home Assistant" target="SettingsHome" />
              <SettingsRow
                icon="person.fill.checkmark"
                label="Presence"
                target="SettingsPresence"
              />
              <SettingsRow icon="waveform.path.ecg" label="Health" target="SettingsHealth" />
            </SettingsSection>
          </>
        )}
      </ScreenScrollView>
    </SettingsScreen>
  );
}
