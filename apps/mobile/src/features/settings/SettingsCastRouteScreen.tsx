/**
 * Settings → Cast, mirroring web's Tessaya › Cast: which persona is on which body now, each body's home and follow
 * rule, and sending everyone home. The server's TessayaCast owns it (`baton.cast.*`); every change is also a voice phrase.
 */
import type { CastBody, CastCallInput, CastView } from "@t3tools/tessaya-contracts";
import type { EnvironmentId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { ControlPill } from "../../components/ui/ControlPill";
import { Menu } from "../../components/ui/Menu";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { ThemedSwitch } from "../../components/ui/ThemedSwitch";
import { tessayaWorkSessions } from "../../state/tessayaWorkSessions";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSettingsEnvironmentMenu } from "./components/SettingsEnvironmentFilterHeader";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";

const WHY: Record<CastBody["why"], string> = {
  visit: "called here for this conversation",
  stay: "called here to stay",
  follows: "following who you last talked to",
  home: "home",
  lead: "default",
};

export function SettingsCastRouteScreen() {
  const environmentMenu = useSettingsEnvironmentMenu();
  const { selectedTargets } = useSettingsEnvironmentFilter();
  const insets = useSafeAreaInsets();
  return (
    <SettingsScreen title="Cast" menus={[environmentMenu]}>
      <ScreenScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {selectedTargets.length === 0 ? (
          <Text className="text-foreground-muted">Connect an environment to see the cast.</Text>
        ) : (
          selectedTargets.map((environment) => (
            <CastSection
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

function CastSection(props: {
  readonly environmentId: EnvironmentId;
  readonly label: string | null;
}) {
  const { environmentId } = props;
  const read = useAtomValue(tessayaWorkSessions.castQuery({ environmentId, input: {} }));
  const send = useAtomCommand(tessayaWorkSessions.castCall, { reportFailure: false });
  const canMove = useAtomValue(tessayaWorkSessions.castCall.permissionAtom(environmentId));
  const [latest, setLatest] = useState<CastView | null>(null);
  const [note, setNote] = useState("");
  const view = latest ?? AsyncResult.getOrElse(read, () => null);
  const name = (id: string | null) => view?.personas.find((p) => p.id === id)?.name ?? "Default";

  const act = async (input: CastCallInput) => {
    setNote("");
    const result = await send({ environmentId, input });
    if (result._tag === "Success") setLatest(result.value);
    else setNote("That didn't go through. Nothing changed.");
  };

  return (
    <SettingsSection title={`${props.label === null ? "" : `${props.label} · `}Who's where`}>
      {view === null ? (
        <Muted>
          {read._tag === "Failure" ? "This server could not read the cast." : "Reading…"}
        </Muted>
      ) : (
        [
          ...(view.focus === undefined
            ? []
            : [
                <View key="focus" className="px-4 py-3">
                  <Text textRole="footnote" className="text-foreground-muted">
                    {view.focus}
                  </Text>
                </View>,
              ]),
          ...view.bodies.map((b, i) => (
            <View
              key={b.id}
              className={`gap-2 px-4 py-3${i > 0 ? " border-t border-border-subtle" : ""}`}
            >
              <Text textRole="body" className="text-foreground">
                {`${b.name}: ${b.on.map((p) => name(p)).join(", ") || "nobody"}`}
              </Text>
              <Text textRole="footnote" className="text-foreground-muted">
                {[
                  WHY[b.why],
                  b.home === null ? null : `home ${name(b.home)}`,
                  b.online === false ? "offline" : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </Text>
              {canMove ? (
                <View className="flex-row flex-wrap items-center gap-2">
                  <Menu
                    accessible
                    accessibilityRole="button"
                    accessibilityLabel={`${b.name} home persona`}
                    title="Home persona"
                    actions={[
                      { id: "", title: "Default" },
                      ...view.personas.map((p) => ({ id: p.id, title: p.name })),
                    ]}
                    onPressAction={({ nativeEvent }) =>
                      void act({ op: "home", body: b.id, persona: nativeEvent.event || null })
                    }
                  >
                    <ControlPill variant="pill" label={`Home: ${name(b.home)}`} />
                  </Menu>
                  {b.form !== undefined && b.form !== "tumble" ? (
                    <Menu
                      accessible
                      accessibilityRole="button"
                      accessibilityLabel={`${b.name} form`}
                      title="Form"
                      actions={[
                        { id: "cartoon", title: "Cartoon" },
                        { id: "human", title: "Full body" },
                      ]}
                      onPressAction={({ nativeEvent }) =>
                        void act({
                          op: "form",
                          body: b.id,
                          form: nativeEvent.event === "human" ? "human" : "cartoon",
                        })
                      }
                    >
                      <ControlPill
                        variant="pill"
                        label={`Form: ${b.form === "human" ? "Full body" : "Cartoon"}`}
                      />
                    </Menu>
                  ) : null}
                  {b.why === "visit" || b.why === "stay" ? (
                    <Menu
                      accessible
                      accessibilityRole="button"
                      accessibilityLabel={`Send ${b.name}'s visitor home`}
                      title="Send home"
                      actions={[{ id: "go", title: "Send home" }]}
                      onPressAction={() => void act({ op: "sendHome", body: b.id })}
                    >
                      <ControlPill variant="pill" label="Send home" />
                    </Menu>
                  ) : null}
                  <View className="flex-row items-center gap-2">
                    <Text textRole="footnote" className="text-foreground-muted">
                      Follows you
                    </Text>
                    <ThemedSwitch
                      accessibilityLabel={`${b.name} follows you`}
                      value={b.follows}
                      onValueChange={(on) => void act({ op: "follows", body: b.id, on })}
                    />
                  </View>
                </View>
              ) : null}
            </View>
          )),
        ]
      )}
      {canMove && view !== null ? (
        <View className="px-4 py-3">
          <Menu
            accessible
            accessibilityRole="button"
            accessibilityLabel="Send everyone home"
            title="Send everyone home?"
            actions={[{ id: "go", title: "Send everyone home" }]}
            onPressAction={() => void act({ op: "sendHome" })}
          >
            <ControlPill variant="pill" label="Send everyone home" />
          </Menu>
        </View>
      ) : null}
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
