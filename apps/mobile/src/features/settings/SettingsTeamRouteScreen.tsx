/**
 * Settings → Team, mirroring web's Tessaya › Team: each persona's duties, templates, track record, load and recent
 * hand-offs, and "Hand to…" on every job it leads. The board is the server's read (`baton.job.team`).
 */
import type { TessayaTeamMember } from "@t3tools/tessaya-contracts";
import {
  leadChoices,
  leadMoveLine,
  loadLine,
  templateLine,
  trackLine,
} from "@t3tools/tessaya-shared/teamView";
import type { EnvironmentId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useState } from "react";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { ControlPill } from "../../components/ui/ControlPill";
import { Menu } from "../../components/ui/Menu";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { tessayaWorkSessions } from "../../state/tessayaWorkSessions";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSettingsEnvironmentMenu } from "./components/SettingsEnvironmentFilterHeader";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";

const QUIET = { reportFailure: false } as const;

export function SettingsTeamRouteScreen() {
  const environmentMenu = useSettingsEnvironmentMenu();
  const { selectedTargets } = useSettingsEnvironmentFilter();
  const insets = useSafeAreaInsets();
  return (
    <SettingsScreen title="Team" menus={[environmentMenu]}>
      <ScreenScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {selectedTargets.length === 0 ? (
          <Text className="text-foreground-muted">Connect an environment to see the team.</Text>
        ) : (
          selectedTargets.map((environment) => (
            <TeamSection
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

function TeamSection(props: {
  readonly environmentId: EnvironmentId;
  readonly label: string | null;
}) {
  const { environmentId } = props;
  const read = useAtomCommand(tessayaWorkSessions.jobTeam, QUIET);
  const lead = useAtomCommand(tessayaWorkSessions.jobLead, QUIET);
  const canLead = useAtomValue(tessayaWorkSessions.jobLead.permissionAtom(environmentId));
  const [members, setMembers] = useState<ReadonlyArray<TessayaTeamMember> | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const refresh = async () => {
    const result = await read({ environmentId, input: {} });
    setFailed(result._tag !== "Success");
    if (result._tag === "Success") setMembers(result.value.members);
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the server's team board once per environment
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect, react/exhaustive-effect-dependencies -- refresh closes over this environment only
    void refresh();
  }, [environmentId]);

  const handTo = async (job: { id: string; title: string }, to: TessayaTeamMember) => {
    setNote("");
    const result = await lead({
      environmentId,
      input: { id: job.id as never, to: to.id, via: "card" },
    });
    setNote(
      result._tag === "Success"
        ? `${to.name} leads ${job.title} now. Its worker carries on.`
        : "That hand-off did not go through. Nothing changed.",
    );
    await refresh();
  };

  const team = members ?? [];
  return (
    <SettingsSection title={`${props.label === null ? "" : `${props.label} · `}The team`}>
      {failed ? (
        <Muted>This server could not read the team.</Muted>
      ) : members === null ? (
        <Muted>Reading the team…</Muted>
      ) : (
        team.map((m, i) => {
          const expanded = open === m.id;
          const others = leadChoices(team, m.id);
          return (
            <View key={m.id} className={i > 0 ? "border-t border-border-subtle" : undefined}>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ expanded }}
                disabled={m.private}
                onPress={() => setOpen(expanded ? null : m.id)}
                className="min-h-16 gap-0.5 px-4 py-3"
              >
                <Text textRole="body" className="text-foreground">
                  {m.name}
                </Text>
                <Text textRole="footnote" className="text-foreground-muted">
                  {[m.role, loadLine(m), trackLine(m.track)].filter(Boolean).join(" · ")}
                </Text>
              </Pressable>
              {expanded ? (
                <View className="gap-3 px-4 pb-4">
                  {m.duties === undefined ? null : <Detail label="Duties" lines={[m.duties]} />}
                  {(m.templates ?? []).length === 0 ? null : (
                    <Detail label="Templates" lines={(m.templates ?? []).map(templateLine)} />
                  )}
                  {m.jobs.length === 0 ? null : (
                    <View className="gap-1">
                      <Label>Leading</Label>
                      {m.jobs.map((job) => (
                        <View key={job.id} className="flex-row items-center justify-between gap-3">
                          <Text className="min-w-0 flex-1 text-foreground" numberOfLines={1}>
                            {job.title}
                          </Text>
                          {canLead && others.length > 0 ? (
                            <Menu
                              accessible
                              accessibilityRole="button"
                              accessibilityLabel={`Hand ${job.title} to`}
                              title="Hand to…"
                              actions={others.map((p) => ({ id: p.id, title: p.name }))}
                              onPressAction={({ nativeEvent }) => {
                                const to = others.find((p) => p.id === nativeEvent.event);
                                if (to !== undefined) void handTo(job, to);
                              }}
                            >
                              <ControlPill variant="pill" label="Hand to…" />
                            </Menu>
                          ) : null}
                        </View>
                      ))}
                    </View>
                  )}
                  {(m.moves ?? []).length === 0 ? null : (
                    <Detail
                      label="Hand-offs and referrals"
                      lines={(m.moves ?? []).map((move) => leadMoveLine(move, team))}
                    />
                  )}
                  {m.recent.length === 0 ? null : (
                    <Detail
                      label="Lately"
                      lines={m.recent.slice(0, 3).map((r) => `${r.subject}: ${r.outcome}`)}
                    />
                  )}
                </View>
              ) : null}
            </View>
          );
        })
      )}
      {note === "" ? null : <Muted>{note}</Muted>}
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

function Label(props: { readonly children: string }) {
  return (
    <Text textRole="footnote" className="text-foreground-muted">
      {props.children}
    </Text>
  );
}

function Detail(props: { readonly label: string; readonly lines: ReadonlyArray<string> }) {
  return (
    <View className="gap-1">
      <Label>{props.label}</Label>
      {props.lines.map((line) => (
        <Text key={line} className="text-foreground">
          {line}
        </Text>
      ))}
    </View>
  );
}
