/**
 * Settings → Health, mirroring web's Tessaya › Health: her diagnosis of why she is slow, choppy or not waking, then each
 * machine, service and Tessel, from the same `baton.health.get` her `tessaya_health` tool reads.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { healthLines } from "@t3tools/tessaya-shared/healthView";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { ControlPill } from "../../components/ui/ControlPill";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { useEnvironmentQuery } from "../../state/query";
import { tessayaWorkSessions } from "../../state/tessayaWorkSessions";
import { useSettingsEnvironmentMenu } from "./components/SettingsEnvironmentFilterHeader";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";

export function SettingsHealthRouteScreen() {
  const environmentMenu = useSettingsEnvironmentMenu();
  const { selectedTargets } = useSettingsEnvironmentFilter();
  const insets = useSafeAreaInsets();
  return (
    <SettingsScreen title="Health" menus={[environmentMenu]}>
      <ScreenScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {selectedTargets.length === 0 ? (
          <Text className="text-foreground-muted">Connect an environment to see her health.</Text>
        ) : (
          selectedTargets.map((environment) => (
            <HealthSections
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

function Line(props: { readonly title: string; readonly detail: string; readonly first: boolean }) {
  return (
    <View className={`gap-1 px-4 py-3${props.first ? "" : " border-t border-border-subtle"}`}>
      <Text textRole="body" className="text-foreground">
        {props.title}
      </Text>
      {props.detail === "" ? null : (
        <Text textRole="footnote" className="text-foreground-muted">
          {props.detail}
        </Text>
      )}
    </View>
  );
}

function HealthSections(props: {
  readonly environmentId: EnvironmentId;
  readonly label: string | null;
}) {
  const query = useEnvironmentQuery(
    tessayaWorkSessions.healthQuery({ environmentId: props.environmentId, input: {} }),
  );
  const view = query.data === null ? null : healthLines(query.data);
  const prefix = props.label === null ? "" : `${props.label} · `;
  return (
    <>
      <SettingsSection title={`${prefix}Health`}>
        <Line
          title={view?.summary ?? (query.isPending ? "Checking…" : "No reading yet")}
          detail={query.error ?? view?.checked ?? ""}
          first
        />
        {view?.findings.map((f) => (
          <Line key={f.key} title={`${f.title} (${f.severity})`} detail={f.detail} first={false} />
        ))}
        <View className="flex-row px-4 py-3">
          <ControlPill
            variant="pill"
            label="Check again"
            accessibilityLabel="Check her health again"
            onPress={() => query.refresh()}
          />
        </View>
      </SettingsSection>
      {view?.groups.map((g) => (
        <SettingsSection key={g.title} title={`${prefix}${g.title}`}>
          {g.rows.map((r, i) => (
            <Line key={r.key} title={r.title} detail={r.detail} first={i === 0} />
          ))}
        </SettingsSection>
      ))}
    </>
  );
}
