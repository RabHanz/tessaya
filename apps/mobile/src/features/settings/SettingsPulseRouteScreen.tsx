/**
 * Settings → Pulse, mirroring web's Brain › Pulse: whether she notices on her own, which kinds she may raise, what he
 * told her to stop raising, and her decision log with his reaction per row (`baton.pulse.react`, which she learns from).
 */
import type { EnvironmentId, ServerSettings } from "@t3tools/contracts";
import type { TessayaRecordEntry } from "@t3tools/tessaya-contracts";
import { PULSE_ROWS, pulseLog } from "@t3tools/tessaya-shared/pulseLog";
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { ControlPill } from "../../components/ui/ControlPill";
import { Menu } from "../../components/ui/Menu";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { serverEnvironment } from "../../state/server";
import { tessayaWorkSessions } from "../../state/tessayaWorkSessions";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSettingsEnvironmentMenu } from "./components/SettingsEnvironmentFilterHeader";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";

const REACTED = { liked: "Helpful", told_off: "Not helpful", stopped: "Stopped" } as const;

export function SettingsPulseRouteScreen() {
  const environmentMenu = useSettingsEnvironmentMenu();
  const { selectedTargets } = useSettingsEnvironmentFilter();
  const insets = useSafeAreaInsets();
  return (
    <SettingsScreen title="Pulse" menus={[environmentMenu]}>
      <ScreenScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {selectedTargets.length === 0 ? (
          <Text className="text-foreground-muted">Connect an environment to see her pulse.</Text>
        ) : (
          selectedTargets.map((environment) => (
            <PulseSections
              key={environment.environmentId}
              environmentId={environment.environmentId}
              pulse={environment.serverConfig.settings.tessayaPulse}
              label={selectedTargets.length > 1 ? environment.label : null}
            />
          ))
        )}
      </ScreenScrollView>
    </SettingsScreen>
  );
}

function PulseSections(props: {
  readonly environmentId: EnvironmentId;
  readonly pulse: ServerSettings["tessayaPulse"];
  readonly label: string | null;
}) {
  const { environmentId, pulse } = props;
  const update = useAtomCommand(serverEnvironment.updateSettings, {
    label: "pulse update",
    reportFailure: true,
  });
  const read = useAtomCommand(tessayaWorkSessions.recordList, { reportFailure: false });
  const react = useAtomCommand(tessayaWorkSessions.pulseReact);
  const mayReact = useAtomValue(tessayaWorkSessions.pulseReact.permissionAtom(environmentId));
  const [log, setLog] = useState<ReadonlyArray<TessayaRecordEntry>>([]);
  const load = () =>
    read({ environmentId, input: { kind: "pulse", limit: 60 } }).then((r) => {
      if (r._tag === "Success") setLog(r.value.entries);
    });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the server's decision log once per environment
  useEffect(() => {
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- one read per environment; load is remade each render
    void load();
  }, [environmentId]);
  const patch = (tessayaPulse: Parameters<typeof update>[0]["input"]["patch"]["tessayaPulse"]) =>
    void update({ environmentId, input: { patch: { tessayaPulse } } });
  const reactTo = (row: number, reaction: "liked" | "told_off" | "stop") =>
    void react({ environmentId, input: { row, reaction } }).then(load);
  const prefix = props.label === null ? "" : `${props.label} · `;
  return (
    <>
      <SettingsSection title={`${prefix}What she raises`}>
        <SettingsSwitchRow
          label="Notice on her own"
          subtitle="She reviews what happened since last time and decides whether to say anything. Usually she stays quiet."
          value={pulse.enabled}
          onValueChange={(on) => patch({ enabled: on })}
        />
        {PULSE_ROWS.map((row) => (
          <SettingsSwitchRow
            key={row.key}
            label={row.title}
            subtitle={row.description}
            value={pulse.categories[row.key]}
            disabled={!pulse.enabled}
            onValueChange={(on) => patch({ categories: { [row.key]: on } })}
          />
        ))}
        {pulse.muted.map((words) => (
          <View key={words} className="flex-row items-center gap-2 px-4 py-3">
            <Text textRole="body" className="flex-1 text-foreground">
              {`Stopped: ${words}`}
            </Text>
            <Menu
              accessible
              accessibilityRole="button"
              accessibilityLabel={`Allow ${words} again`}
              title="Allow again?"
              actions={[{ id: "go", title: "Allow again" }]}
              onPressAction={() => patch({ muted: pulse.muted.filter((m) => m !== words) })}
            >
              <ControlPill variant="pill" label="Allow again" />
            </Menu>
          </View>
        ))}
      </SettingsSection>
      <SettingsSection title={`${prefix}What she noticed`}>
        {pulseLog(log)
          .slice(0, 12)
          .map((r, i) => (
            <View
              key={r.id}
              className={`gap-2 px-4 py-3${i > 0 ? " border-t border-border-subtle" : ""}`}
            >
              <Text textRole="body" className="text-foreground">
                {r.event}
              </Text>
              <Text textRole="footnote" className="text-foreground-muted">
                {`${new Date(r.at).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })} · ${r.decision}${r.reason === "" ? "" : ` · ${r.reason}`}`}
              </Text>
              {mayReact ? (
                <Menu
                  accessible
                  accessibilityRole="button"
                  accessibilityLabel={`React to: ${r.event}`}
                  title="Was this helpful?"
                  actions={[
                    { id: "liked", title: "Helpful" },
                    { id: "told_off", title: "Not helpful" },
                    ...(r.category === null || !pulse.categories[r.category]
                      ? []
                      : [{ id: "stop", title: "Stop this kind" }]),
                  ]}
                  onPressAction={({ nativeEvent }) =>
                    reactTo(r.id, nativeEvent.event as "liked" | "told_off" | "stop")
                  }
                >
                  <ControlPill
                    variant="pill"
                    label={r.reaction === null ? "React" : REACTED[r.reaction]}
                  />
                </Menu>
              ) : null}
            </View>
          ))}
        {log.length === 0 ? (
          <Text textRole="footnote" className="px-4 py-3 text-foreground-muted">
            Nothing yet. Each review she makes, and why she spoke or stayed quiet, shows here.
          </Text>
        ) : null}
      </SettingsSection>
    </>
  );
}
