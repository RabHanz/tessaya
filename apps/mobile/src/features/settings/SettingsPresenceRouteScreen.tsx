/**
 * Settings → Presence: your own presence opt-ins (B-043), as the household keeps them. Your phone saying home or away
 * (never where), a camera noticing you at a computer, and which phones, laptops and headphones are yours. Each is off
 * until you turn it on, and each turns off here, in the Tessaya window's Household, or by voice ("turn my location on").
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { optedIn } from "@t3tools/tessaya-shared/household";
import { useEffect, useState } from "react";
import { TextInput } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { ControlPill } from "../../components/ui/ControlPill";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { tessayaWorkSessions } from "../../state/tessayaWorkSessions";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSettingsEnvironmentMenu } from "./components/SettingsEnvironmentFilterHeader";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { SettingsTextRow } from "./components/SettingsTextRow";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";

const INPUT_CLASS =
  "min-w-40 flex-1 rounded-lg border border-border-subtle px-3 py-2 text-base text-foreground";
const OPT_INS = [
  [
    "location",
    "Home or away from this phone",
    "Your phone tells her when you arrive home or leave. Never where you are.",
  ],
  [
    "camera",
    "A camera may notice you",
    "A camera may notice you're at a computer. She says when it is on and keeps no picture.",
  ],
] as const;
type Prefs = Readonly<Record<string, string>>;

export function SettingsPresenceRouteScreen() {
  const environmentMenu = useSettingsEnvironmentMenu();
  const { selectedTargets } = useSettingsEnvironmentFilter();
  const insets = useSafeAreaInsets();
  return (
    <SettingsScreen title="Presence" menus={[environmentMenu]}>
      <ScreenScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {selectedTargets.length === 0 ? (
          <Text className="text-foreground-muted">
            Connect an environment to choose how she knows you're around.
          </Text>
        ) : (
          selectedTargets.map((environment) => (
            <PresenceSections
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

function PresenceSections(props: {
  readonly environmentId: EnvironmentId;
  readonly label: string | null;
}) {
  const { environmentId } = props;
  const devicesCall = useAtomCommand(tessayaWorkSessions.devicesCall, { reportFailure: false });
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [note, setNote] = useState("");
  const [devices, setDevices] = useState("");
  const ask = (op: "preferences" | "setPreference", args: Record<string, unknown> = {}) =>
    devicesCall({ environmentId, input: { kind: "vessel", op, args } }).then((r) => {
      if (r._tag !== "Success" || !r.value.ok) {
        setNote(
          r._tag === "Success"
            ? (r.value.error ?? "That wasn't saved.")
            : "Couldn't reach this server.",
        );
        return;
      }
      const value = r.value.value as { line: string; preferences: Prefs };
      setPrefs(value.preferences);
      setDevices(value.preferences["devices"] ?? "");
      setNote(value.line);
    });
  const set = (key: string, value: string | null) => void ask("setPreference", { key, value });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads this member's preferences once per environment
  useEffect(() => {
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- one read per environment; ask is remade each render
    void ask("preferences");
  }, [environmentId]);
  const prefix = props.label === null ? "" : `${props.label} · `;

  return (
    <SettingsSection title={`${prefix}How she knows you're around`} footer={note || undefined}>
      {prefs === null ? (
        <SettingsTextRow title={note === "" ? "Reading…" : note} />
      ) : (
        <>
          {OPT_INS.map(([key, label, subtitle]) => (
            <SettingsSwitchRow
              key={key}
              label={label}
              subtitle={subtitle}
              value={optedIn(prefs[key])}
              onValueChange={(on) => set(key, on ? "on" : "off")}
            />
          ))}
          <SettingsTextRow
            divider
            title="Your devices"
            description="Your phones, laptops and headphones by name or network (MAC) address, comma-separated, so she knows when you're on the home Wi-Fi and whose headphones are on."
          >
            <TextInput
              accessibilityLabel="Your devices"
              className={INPUT_CLASS}
              placeholderTextColorClassName="accent-foreground-muted"
              placeholder="My iPhone, AirPods"
              maxLength={120}
              value={devices}
              onChangeText={setDevices}
            />
            <ControlPill
              variant="pill"
              label="Save"
              disabled={devices.trim() === (prefs["devices"] ?? "")}
              onPress={() => set("devices", devices.trim() === "" ? null : devices.trim())}
            />
            {prefs["devices"] === undefined ? null : (
              <ControlPill variant="pill" label="Clear" onPress={() => set("devices", null)} />
            )}
          </SettingsTextRow>
        </>
      )}
    </SettingsSection>
  );
}
