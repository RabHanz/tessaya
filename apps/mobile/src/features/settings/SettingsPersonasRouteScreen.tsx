/**
 * Settings → Personas, mirroring web's Voice › Personas: hire, tune, copy, retire and restore personas, and run his
 * group. Every change goes to the environment's one registry (`baton.personas.change`); she does the same by voice.
 */
import type {
  TessayaPersona,
  TessayaPersonaChangeInput,
  TessayaPersonaChangeResult,
  TessayaPersonaGroup,
} from "@t3tools/tessaya-contracts";
import type { EnvironmentId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useState } from "react";
import { TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ControlPill } from "../../components/ui/ControlPill";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { Menu } from "../../components/ui/Menu";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { SliderRow } from "../../components/ui/SliderRow";
import { tessayaWorkSessions } from "../../state/tessayaWorkSessions";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSettingsEnvironmentMenu } from "./components/SettingsEnvironmentFilterHeader";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import {
  BLANK_PERSONA,
  DIALS,
  groupToggle,
  type PersonaForm,
  personaFormFor,
  personaSave,
} from "./personaForm";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";

const QUIET = { reportFailure: false } as const;
const INPUT = "rounded-lg bg-background px-3 py-2 text-foreground";

export function SettingsPersonasRouteScreen() {
  const environmentMenu = useSettingsEnvironmentMenu();
  const { selectedTargets } = useSettingsEnvironmentFilter();
  const insets = useSafeAreaInsets();
  return (
    <SettingsScreen title="Personas" menus={[environmentMenu]}>
      <ScreenScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {selectedTargets.length === 0 ? (
          <Text className="text-foreground-muted">Connect an environment to see the personas.</Text>
        ) : (
          selectedTargets.map((environment) => (
            <PersonasSection
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

function PersonasSection(props: {
  readonly environmentId: EnvironmentId;
  readonly label: string | null;
}) {
  const { environmentId } = props;
  const list = useAtomCommand(tessayaWorkSessions.personasList, QUIET);
  const change = useAtomCommand(tessayaWorkSessions.personaChange, QUIET);
  const canChange = useAtomValue(tessayaWorkSessions.personaChange.permissionAtom(environmentId));
  const [personas, setPersonas] = useState<ReadonlyArray<TessayaPersona> | null>(null);
  const [failed, setFailed] = useState(false);
  const [bin, setBin] = useState<TessayaPersonaChangeResult["bin"]>([]);
  const [form, setForm] = useState<PersonaForm | null>(null);
  const [note, setNote] = useState("");

  const ask = async (input: TessayaPersonaChangeInput): Promise<TessayaPersonaChangeResult> => {
    const result = await change({ environmentId, input });
    const reply: TessayaPersonaChangeResult =
      result._tag === "Success"
        ? result.value
        : { ok: false, error: "Couldn't reach this environment. Try again.", bin };
    setBin(reply.bin);
    setNote(reply.ok ? "" : (reply.error ?? "That was not saved."));
    return reply;
  };
  const read = async () => {
    const result = await list({ environmentId, input: {} });
    setFailed(result._tag !== "Success");
    if (result._tag === "Success") setPersonas(result.value.personas);
  };
  const send = async (input: TessayaPersonaChangeInput) => {
    const reply = await ask(input);
    if (reply.ok) await read();
    return reply.ok;
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the environment's roster and bin once per environment
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect, react/exhaustive-effect-dependencies -- one read per environment
    void Promise.all([read(), canChange ? ask({ op: "bin" }) : null]);
  }, [environmentId, canChange]);

  const save = async (f: PersonaForm) => {
    if (await send(personaSave(f))) setForm(null);
  };
  const prefix = props.label === null ? "" : `${props.label} · `;
  const team = personas ?? [];

  return (
    <>
      <SettingsSection
        title={`${prefix}Your team`}
        trailing={
          canChange && form === null ? (
            <ControlPill
              variant="pill"
              icon="person.badge.plus"
              label="New persona"
              onPress={() => setForm(BLANK_PERSONA)}
            />
          ) : undefined
        }
        footer="You can also ask Tessaya: “make a new persona called Luna”, “make Freya warmer”, “retire Onyx”."
      >
        {failed ? (
          <Muted>This server could not read the personas.</Muted>
        ) : personas === null ? (
          <Muted>Reading…</Muted>
        ) : (
          team.map((p, i) => (
            <View key={p.id} className={i > 0 ? "border-t border-border-subtle" : undefined}>
              <ListRowLayout
                label={`${p.name}${p.lead ? " (lead)" : ""}${p.private === true ? " · private" : ""}`}
                description={[
                  p.role,
                  p.brain === undefined
                    ? null
                    : `Thinks on ${p.brain.model}, ${p.brain.effort} effort.`,
                ]
                  .filter(Boolean)
                  .join(" ")}
                accessory={
                  canChange ? (
                    <Menu
                      accessible
                      accessibilityRole="button"
                      accessibilityLabel={`Change ${p.name}`}
                      title={p.name}
                      actions={[
                        { id: "edit", title: "Edit" },
                        ...(p.lead
                          ? []
                          : [
                              { id: "duplicate", title: "Duplicate" },
                              {
                                id: "retire",
                                title: "Retire to the bin",
                                attributes: { destructive: true },
                              },
                            ]),
                      ]}
                      onPressAction={({ nativeEvent }) => {
                        if (nativeEvent.event === "edit") setForm(personaFormFor(p));
                        else if (nativeEvent.event === "duplicate")
                          void send({ op: "duplicate", id: p.id, name: `${p.name} copy` });
                        else if (nativeEvent.event === "retire")
                          void send({ op: "retire", id: p.id });
                      }}
                    >
                      <ControlPill icon="ellipsis.circle" accessibilityLabel={`Change ${p.name}`} />
                    </Menu>
                  ) : undefined
                }
              />
            </View>
          ))
        )}
        {note === "" ? null : <Muted>{note}</Muted>}
      </SettingsSection>
      {form === null ? null : (
        <PersonaFormSection
          form={form}
          onChange={setForm}
          onCancel={() => setForm(null)}
          onSave={() => void save(form)}
        />
      )}
      {bin.length === 0 ? null : (
        <SettingsSection title={`${prefix}Bin · ${bin.length} retired`}>
          {bin.map((p, i) => (
            <View key={p.id} className={i > 0 ? "border-t border-border-subtle" : undefined}>
              <ListRowLayout
                label={p.name}
                description="Retired: out of the team, with its memories and settings kept."
                accessory={
                  canChange ? (
                    <ControlPill
                      variant="pill"
                      label="Restore"
                      accessibilityLabel={`Restore ${p.name}`}
                      onPress={() => void send({ op: "restore", id: p.id })}
                    />
                  ) : undefined
                }
              />
            </View>
          ))}
        </SettingsSection>
      )}
      {canChange && personas !== null ? (
        <GroupSection prefix={prefix} personas={team} ask={ask} />
      ) : null}
    </>
  );
}

/** His group (M-021): who is in it, who only listens, and whether they talk among themselves. */
function GroupSection(props: {
  readonly prefix: string;
  readonly personas: ReadonlyArray<TessayaPersona>;
  readonly ask: (input: TessayaPersonaChangeInput) => Promise<TessayaPersonaChangeResult>;
}) {
  const [group, setGroup] = useState<TessayaPersonaGroup | null>(null);
  const [picked, setPicked] = useState<ReadonlyArray<string>>([]);
  const [line, setLine] = useState("");
  const change = async (input: Extract<TessayaPersonaChangeInput, { op: "group" }>["change"]) => {
    const reply = await props.ask({ op: "group", change: input });
    if (reply.group !== undefined) setGroup(reply.group);
    if (input.op !== "status") setLine(reply.line ?? "");
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads his group once when the screen opens
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- the read's answer lands after it returns
    void change({ op: "status" });
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- one read on mount
  }, []);
  const toggle = (id: string, on: boolean) => {
    const next = groupToggle(group, picked, id, on);
    setPicked(next.picked);
    if (next.change !== null) void change(next.change);
  };
  return (
    <SettingsSection
      title={`${props.prefix}Group · ${group === null ? "off" : `${group.members.length} talking`}`}
      footer="Pick two or more; each answers in its own voice. Say a name to ask one. By voice: “let me talk to Freya and Alfred together”, “let them talk”, “end the group”."
    >
      {line === "" ? null : <Muted>{line}</Muted>}
      {group === null ? null : (
        <>
          <ListToggleRow
            label="Let them talk"
            description="They talk among themselves while you listen."
            value={group.mode === "watch"}
            onValueChange={(on) => void change({ op: "mode", mode: on ? "watch" : "answer" })}
          />
          <View className="border-t border-border-subtle px-4 py-3">
            <Button size="compact" label="End group" onPress={() => void change({ op: "end" })} />
          </View>
        </>
      )}
      {props.personas.map((p, i) => {
        const m = group?.members.find((x) => x.id === p.id);
        return (
          <View
            key={p.id}
            className={
              i > 0 || group !== null || line !== "" ? "border-t border-border-subtle" : undefined
            }
          >
            <ListToggleRow
              label={p.name}
              description={m?.silent === true ? "Listening; speaks when you name them." : p.role}
              value={m !== undefined || picked.includes(p.id)}
              onValueChange={(on) => toggle(p.id, on)}
            />
            {m === undefined ? null : (
              <ListToggleRow
                label={`${p.name} listens only`}
                value={m.silent === true}
                onValueChange={(on) => void change({ op: on ? "silent" : "speak", persona: p.id })}
              />
            )}
          </View>
        );
      })}
    </SettingsSection>
  );
}

function PersonaFormSection(props: {
  readonly form: PersonaForm;
  readonly onChange: (form: PersonaForm) => void;
  readonly onCancel: () => void;
  readonly onSave: () => void;
}) {
  const { form, onChange } = props;
  return (
    <SettingsSection title={form.id === null ? "New persona" : `Edit ${form.name}`}>
      <View className="gap-2 px-4 py-3">
        <TextInput
          accessibilityLabel="Name"
          placeholder="Name"
          maxLength={40}
          value={form.name}
          onChangeText={(name) => onChange({ ...form, name })}
          className={INPUT}
        />
        <TextInput
          accessibilityLabel="Who they are, in one line"
          placeholder="Who they are, in one line"
          maxLength={200}
          value={form.role}
          onChangeText={(role) => onChange({ ...form, role })}
          className={INPUT}
        />
        <TextInput
          accessibilityLabel="Personality, backstory and how they relate to you"
          placeholder={
            form.id === null
              ? "Personality, backstory and how they relate to you"
              : "Leave empty to keep the current description"
          }
          maxLength={4000}
          multiline
          value={form.about}
          onChangeText={(about) => onChange({ ...form, about })}
          className={`${INPUT} min-h-24`}
          textAlignVertical="top"
        />
      </View>
      {DIALS.map(([dial, label]) => (
        <SliderRow
          key={dial}
          icon="slider.horizontal.3"
          label={label}
          min={0}
          max={1}
          step={0.05}
          value={form.traits[dial] ?? 0.5}
          valueLabel={(form.traits[dial] ?? 0.5).toFixed(2)}
          onChange={(v) => onChange({ ...form, traits: { ...form.traits, [dial]: v } })}
        />
      ))}
      <View className="px-4 py-3">
        <TextInput
          accessibilityLabel="Brain model"
          placeholder="Brain model, any provider (empty for the default)"
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={60}
          value={form.model}
          onChangeText={(model) => onChange({ ...form, model })}
          className={INPUT}
        />
      </View>
      <ListToggleRow
        label="Private"
        description="Only you, verified, can reach this persona and its memories."
        value={form.private}
        onValueChange={(on) => onChange({ ...form, private: on })}
      />
      <View className="flex-row justify-end gap-2 px-4 py-3">
        <Button size="compact" tone="text" label="Cancel" onPress={props.onCancel} />
        <Button
          size="compact"
          tone="primary"
          label={form.id === null ? "Create" : "Save"}
          disabled={form.name.trim() === ""}
          onPress={props.onSave}
        />
      </View>
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
