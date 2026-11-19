/**
 * Settings → Coming up, mirroring web's and the Tessaya window's: everything Tessaya will do later, soonest first, with
 * a countdown, and each item cancelled, paused or moved where its owner allows (`baton.upcoming.*`).
 */
import type { EnvironmentId } from "@t3tools/contracts";
import type { UpcomingListResult, UpcomingOp } from "@t3tools/tessaya-contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  countdownText,
  nextTickMs,
  UPCOMING_GROUP_LABEL,
  UPCOMING_SOURCE_LABEL,
  upcomingClock,
  upcomingGroup,
  type UpcomingGroup,
} from "@t3tools/tessaya-shared/upcoming";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { ControlPill } from "../../components/ui/ControlPill";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { tessayaWorkSessions } from "../../state/tessayaWorkSessions";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSettingsEnvironmentMenu } from "./components/SettingsEnvironmentFilterHeader";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";

const UNREACHABLE = "Couldn't reach this environment. Try again.";
const REFRESH_MS = 60_000;
const GROUPS: ReadonlyArray<UpcomingGroup> = ["soon", "today", "week", "waiting"];

export function SettingsUpcomingRouteScreen() {
  const environmentMenu = useSettingsEnvironmentMenu();
  const { selectedTargets } = useSettingsEnvironmentFilter();
  const insets = useSafeAreaInsets();
  return (
    <SettingsScreen title="Coming up" menus={[environmentMenu]}>
      <ScreenScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {selectedTargets.length === 0 ? (
          <Text className="text-foreground-muted">
            Connect an environment to see what is coming up.
          </Text>
        ) : (
          selectedTargets.map((environment) => (
            <UpcomingSections
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

function UpcomingSections(props: {
  readonly environmentId: EnvironmentId;
  readonly label: string | null;
}) {
  const { environmentId } = props;
  const quiet = { reportFailure: false } as const;
  const listCall = useAtomCommand(tessayaWorkSessions.upcomingList, quiet);
  const changeCall = useAtomCommand(tessayaWorkSessions.upcomingChange, quiet);
  const [view, setView] = useState<UpcomingListResult | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [line, setLine] = useState("");
  const [busy, setBusy] = useState(false);
  const [undo, setUndo] = useState<string | null>(null);

  const read = async () => {
    const result = await listCall({ environmentId, input: {} });
    if (result._tag === "Success") setView(result.value);
    else setLine(UNREACHABLE);
    setNow(Date.now());
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the server's list now and each minute, as new items appear there
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect, react/exhaustive-effect-dependencies -- read closes over this environment
    void read();
    const timer = setInterval(() => void read(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [environmentId]);

  const items = view?.items ?? [];
  // The countdown ticks on the minute, and each second only while something is in its last minute.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- follows the wall clock, which React cannot derive
  useEffect(() => {
    const timer = setTimeout(() => setNow(Date.now()), nextTickMs(items, now));
    return () => clearTimeout(timer);
  }, [items, now]);

  const change = async (id: string, op: UpcomingOp, at?: number) => {
    if (busy) return;
    setBusy(true);
    setUndo(null);
    const result = await changeCall({
      environmentId,
      input: { id, op, ...(at === undefined ? {} : { at }) },
    });
    // A cancel that can come back keeps an Undo beside its sentence.
    if (result._tag === "Success" && result.value.undoable === true) setUndo(id);
    const reason =
      result._tag === "Success"
        ? null
        : (squashAtomCommandFailure(result) as { readonly reason?: unknown } | null)?.reason;
    setLine(
      result._tag === "Success"
        ? result.value.line
        : typeof reason === "string"
          ? reason
          : UNREACHABLE,
    );
    setBusy(false);
    await read();
  };

  const prefix = props.label === null ? "" : `${props.label} · `;
  if (view === null)
    return (
      <SettingsSection title={`${prefix}Coming up`}>
        <Muted>{line === "" ? "Reading…" : line}</Muted>
      </SettingsSection>
    );
  return (
    <View className="gap-6">
      {line === "" ? null : <Muted>{line}</Muted>}
      {undo === null ? null : (
        <View className="flex-row px-4">
          <ControlPill
            variant="pill"
            label="Undo"
            accessibilityLabel="Undo that cancel"
            onPress={() => void change(undo, "undo")}
          />
        </View>
      )}
      {view.unreadable.length === 0 ? null : (
        <Muted>{`Couldn't read ${view.unreadable.join(", ")} just now.`}</Muted>
      )}
      {items.length === 0 ? (
        <SettingsSection title={`${prefix}Coming up`}>
          <Muted>Nothing is set to happen in the next 7 days, and nothing is waiting.</Muted>
        </SettingsSection>
      ) : (
        GROUPS.map((group) => {
          const rows = items.filter((item) => upcomingGroup(item, now) === group);
          if (rows.length === 0) return null;
          return (
            <SettingsSection key={group} title={`${prefix}${UPCOMING_GROUP_LABEL[group]}`}>
              {rows.map((item) => {
                const when = [countdownText(item, now), upcomingClock(item), item.repeats]
                  .filter((p) => p !== null)
                  .join(" · ");
                const detail =
                  item.condition === null ? item.line : `${item.condition}. ${item.line}`;
                return (
                  <View key={item.id} className="border-t border-border-subtle">
                    <ListRowLayout
                      label={`${UPCOMING_SOURCE_LABEL[item.source]}: ${item.title}`}
                      description={detail === "" ? when : `${when} · ${detail}`}
                    />
                    <View className="flex-row flex-wrap gap-2 px-4 pb-3">
                      {item.can.move && item.at !== null ? (
                        <>
                          <ControlPill
                            variant="pill"
                            label="+5 min"
                            accessibilityLabel={`Move ${item.title} 5 minutes later`}
                            onPress={() => void change(item.id, "move", item.at! + 5 * 60_000)}
                          />
                          <ControlPill
                            variant="pill"
                            label="+15 min"
                            accessibilityLabel={`Move ${item.title} 15 minutes later`}
                            onPress={() => void change(item.id, "move", item.at! + 15 * 60_000)}
                          />
                        </>
                      ) : null}
                      {item.can.pause ? (
                        <ControlPill
                          variant="pill"
                          label={item.paused ? "Resume" : "Pause"}
                          accessibilityLabel={`${item.paused ? "Resume" : "Pause"} ${item.title}`}
                          onPress={() => void change(item.id, item.paused ? "resume" : "pause")}
                        />
                      ) : null}
                      {item.can.cancel ? (
                        <ControlPill
                          variant="pill"
                          label="Cancel"
                          accessibilityLabel={`Cancel ${item.title}`}
                          onPress={() => void change(item.id, "cancel")}
                        />
                      ) : null}
                    </View>
                  </View>
                );
              })}
            </SettingsSection>
          );
        })
      )}
    </View>
  );
}

function Muted(props: { readonly children: string }) {
  return (
    <Text textRole="footnote" className="px-4 py-3 text-foreground-muted">
      {props.children}
    </Text>
  );
}
