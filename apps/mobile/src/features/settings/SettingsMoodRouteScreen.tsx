/**
 * Settings → Her mood, mirroring web's Brain › Her lines and Voice › Inner state: her own words, her mood on or off,
 * chatter, and each persona's mood toward each person with why, a reset, and every emotional dial. By voice: "make
 * Freya a bit more playful", "turn her mood off", "be calmer".
 */
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import type { EnvironmentId, ServerSettings } from "@t3tools/contracts";
import type { TessayaPersona, TessayaVoiceCallResult } from "@t3tools/tessaya-contracts";
import {
  becauseOf,
  DIAL_STEPS,
  MOOD_DIALS,
  moodTitle,
  opinionOf,
  stepOf,
  type PersonaMood,
} from "@t3tools/tessaya-shared/moodView";
import { Fragment, useEffect, useState } from "react";
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
import { SettingsTextRow } from "./components/SettingsTextRow";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";

const CHATTER = [
  ["lively", "Lively"],
  ["calm", "Calm"],
  ["important", "Important only"],
] as const;
const stepLabel = (v: number) => DIAL_STEPS.find(([step]) => step === stepOf(v))?.[1] ?? "Some";

export function SettingsMoodRouteScreen() {
  const environmentMenu = useSettingsEnvironmentMenu();
  const { selectedTargets } = useSettingsEnvironmentFilter();
  const insets = useSafeAreaInsets();
  return (
    <SettingsScreen title="Her mood" menus={[environmentMenu]}>
      <ScreenScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {selectedTargets.length === 0 ? (
          <Text className="text-foreground-muted">Connect an environment to see her mood.</Text>
        ) : (
          selectedTargets.map((environment) => (
            <MoodSections
              key={environment.environmentId}
              environmentId={environment.environmentId}
              settings={environment.serverConfig.settings}
              label={selectedTargets.length > 1 ? environment.label : null}
            />
          ))
        )}
      </ScreenScrollView>
    </SettingsScreen>
  );
}

function MoodSections(props: {
  readonly environmentId: EnvironmentId;
  readonly settings: ServerSettings;
  readonly label: string | null;
}) {
  const { environmentId, settings } = props;
  const update = useAtomCommand(serverEnvironment.updateSettings, {
    label: "mood update",
    reportFailure: true,
  });
  const listPersonas = useAtomCommand(tessayaWorkSessions.personasList, { reportFailure: false });
  const voiceCall = useAtomCommand(tessayaWorkSessions.voiceCall, { reportFailure: false });
  const call = async (
    kind: "read" | "owner",
    op: string,
    args: Record<string, unknown>,
  ): Promise<TessayaVoiceCallResult> => {
    const result = await voiceCall({ environmentId, input: { kind, op, args } });
    return result._tag === "Success" ? result.value : { ok: false };
  };
  const [personas, setPersonas] = useState<ReadonlyArray<TessayaPersona> | null>(null);
  const [moods, setMoods] = useState<Readonly<Record<string, PersonaMood | null>>>({});
  const [dialsOpen, setDialsOpen] = useState<string | null>(null);
  const readMoods = async (list: ReadonlyArray<TessayaPersona>) => {
    const read = await Promise.all(
      list.map(async (p) => {
        // A member's session can't make owner calls: it reads its own row without the general why.
        const owner = await call("owner", "mood", { persona: p.id });
        const reply = owner.ok ? owner : await call("read", "mood", { persona: p.id });
        return [p.id, reply.ok ? (reply.value as PersonaMood | null) : null] as const;
      }),
    );
    setMoods(Object.fromEntries(read));
  };
  const refresh = () =>
    listPersonas({ environmentId, input: {} }).then((r) => {
      if (r._tag !== "Success") return setPersonas([]);
      setPersonas(r.value.personas);
      return readMoods(r.value.personas);
    });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads her personas and their moods once per environment
  useEffect(() => {
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- one read per environment; refresh is remade each render
    void refresh();
  }, [environmentId]);
  const patch = (next: Parameters<typeof update>[0]["input"]["patch"]) =>
    void update({ environmentId, input: { patch: next } });
  const setDial = (persona: string, mood: PersonaMood, dial: string, value: number) => {
    patch({ tessayaMood: { personas: { [persona]: { [dial]: value } } } });
    setMoods((now) => ({
      ...now,
      [persona]: { ...mood, dials: { ...mood.dials, [dial]: value } },
    }));
  };
  const prefix = props.label === null ? "" : `${props.label} · `;
  const chatter = CHATTER.find(([value]) => value === settings.companionMotion)?.[1] ?? "Calm";

  return (
    <>
      <SettingsSection title={`${prefix}Her lines`}>
        <SettingsSwitchRow
          label="Her own words"
          subtitle="Acknowledgements, confirmations and notices in her voice, varied and never the same twice. Off says the plain lines."
          value={settings.tessayaExpression}
          onValueChange={(on) => patch({ tessayaExpression: on })}
        />
        <SettingsSwitchRow
          label="Fix misheard words"
          subtitle="When words she heard on the Tessel sound like one of your names but are not, she fixes them from what you were talking about before answering. Clear turns never wait for it."
          value={settings.tessayaRoomCleanup}
          onValueChange={(on) => patch({ tessayaRoomCleanup: on })}
        />
        <SettingsSwitchRow
          label="Her own camera without a card"
          subtitle="When you ask her to look, the Tessel's camera takes its picture without a card to your phone. Her eyes show she is looking. An agent or a job still asks you."
          value={settings.tessayaOwnSensorsNoApproval}
          onValueChange={(on) => patch({ tessayaOwnSensorsNoApproval: on })}
        />
        {(
          [
            ["still", "Her own life: still", "She never moves on her own."],
            [
              "calm",
              "Her own life: calm",
              "Now and then she rests, wanders or comes looking for you.",
            ],
            [
              "lively",
              "Her own life: lively",
              "More often, and playful when she's in a bright mood.",
            ],
          ] as const
        ).map(([value, label, description], i) => (
          <ListChoiceRow
            key={value}
            label={label}
            description={description}
            selected={settings.tessayaLiveliness === value}
            separated={i > 0}
            onPress={() => patch({ tessayaLiveliness: value })}
          />
        ))}
        <SettingsSwitchRow
          label="Body-only agents move her body"
          subtitle="Agents you approved for her body only may move her own body, not only the body playground. It still waits while a conversation you are in has her."
          value={settings.tessayaBodyOutsideAgents}
          onValueChange={(on) => patch({ tessayaBodyOutsideAgents: on })}
        />
        <SettingsSwitchRow
          label="Breath between sentences"
          subtitle="A soft breath before a long sentence of her reply on the Tessel. Off, she pauses instead."
          value={settings.tessayaVoiceBreath}
          onValueChange={(on) => patch({ tessayaVoiceBreath: on })}
        />
        <SettingsSwitchRow
          label="Keep my voice for training"
          subtitle="Your own turns on the Tessel, only ones Voice ID knows are you, are kept privately to train your voice ID and recogniser. Nobody else's voice is kept."
          value={settings.tessayaTurnCapture}
          onValueChange={(on) => patch({ tessayaTurnCapture: on })}
        />
        <SettingsSwitchRow
          label="Her mood"
          subtitle="A working state that shapes her tone and her face on every device, moved only by your own turns. It never changes what she does. Off keeps her face neutral and clears her mood."
          value={settings.tessayaMood.enabled}
          onValueChange={(on) => patch({ tessayaMood: { enabled: on } })}
        />
        <SettingsTextRow
          divider
          title="Chatter"
          description="What she says and does unprompted. Answers to you and safety alerts always play."
        >
          <Menu
            accessible
            accessibilityRole="button"
            accessibilityLabel={`Chatter: ${chatter}`}
            title="Chatter"
            actions={CHATTER.map(([id, title]) => ({
              id,
              title,
              state: id === settings.companionMotion ? ("on" as const) : ("off" as const),
            }))}
            onPressAction={({ nativeEvent }) =>
              patch({ companionMotion: nativeEvent.event as (typeof CHATTER)[number][0] })
            }
          >
            <ControlPill variant="pill" label={chatter} />
          </Menu>
        </SettingsTextRow>
      </SettingsSection>
      <SettingsSection title={`${prefix}Inner state`}>
        <SettingsTextRow
          title="How each persona feels now, and why"
          description="A general mood, and how she feels toward each person, shown only to them (the owner sees everyone). This is a working state that shapes how Tessaya talks. It is not a claim of feelings."
        >
          <ControlPill
            variant="pill"
            label="Check again"
            onPress={() => void readMoods(personas ?? [])}
          />
        </SettingsTextRow>
        {personas === null ? <SettingsTextRow divider title="Reading…" /> : null}
        {(personas ?? []).map((persona) => {
          const mood = moods[persona.id];
          if (mood == null)
            return (
              <SettingsTextRow
                key={persona.id}
                divider
                title={persona.name}
                description="The mood could not be read."
              />
            );
          return (
            <Fragment key={persona.id}>
              <SettingsTextRow
                divider
                title={moodTitle(`${persona.name}, in general`, mood)}
                description={becauseOf(mood.why)}
              >
                {mood.dials === undefined ? null : (
                  <ControlPill
                    variant={dialsOpen === persona.id ? "primary" : "pill"}
                    label={dialsOpen === persona.id ? "Hide dials" : "Dials"}
                    onPress={() => setDialsOpen(dialsOpen === persona.id ? null : persona.id)}
                  />
                )}
              </SettingsTextRow>
              {(mood.people ?? []).map((person) => (
                <SettingsTextRow
                  key={person.member}
                  divider
                  title={moodTitle(`${persona.name}, toward ${person.name}`, person)}
                  description={[becauseOf(person.why), opinionOf(person)]
                    .filter((s) => s !== "")
                    .join(" ")}
                >
                  {mood.dials === undefined ? null : (
                    <ControlPill
                      variant="pill"
                      label="Reset"
                      accessibilityLabel={`Reset ${persona.name}'s mood toward ${person.name}`}
                      onPress={() =>
                        void call("owner", "moodReset", {
                          persona: persona.id,
                          member: person.member,
                        }).then(() => readMoods(personas ?? []))
                      }
                    />
                  )}
                </SettingsTextRow>
              ))}
              {dialsOpen !== persona.id || mood.dials === undefined
                ? null
                : MOOD_DIALS.map(([dial, says]) => {
                    const now = mood.dials?.[dial] ?? 0;
                    return (
                      <SettingsTextRow
                        key={dial}
                        divider
                        title={`${persona.name}: ${dial}`}
                        description={says}
                      >
                        <Menu
                          accessible
                          accessibilityRole="button"
                          accessibilityLabel={`${persona.name}: ${dial}, ${stepLabel(now)}`}
                          title={dial}
                          actions={DIAL_STEPS.map(([value, title]) => ({
                            id: value,
                            title,
                            state: value === stepOf(now) ? ("on" as const) : ("off" as const),
                          }))}
                          onPressAction={({ nativeEvent }) =>
                            setDial(persona.id, mood, dial, Number(nativeEvent.event))
                          }
                        >
                          <ControlPill variant="pill" label={stepLabel(now)} />
                        </Menu>
                      </SettingsTextRow>
                    );
                  })}
            </Fragment>
          );
        })}
      </SettingsSection>
    </>
  );
}
