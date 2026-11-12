/**
 * Settings → Hardware, mirroring web's HardwareSettings: Tessaya's physical devices (the Agora R1 first), their status
 * and live controls, all through the server's `baton.devices.call`. Camera and restart are the owner kind.
 */
import { useAtomValue } from "@effect/atom-react";
import {
  R1_MOODS,
  type R1KeyBinding,
  type R1KeySlot,
  type BatonDevicesCallResult,
  type DeviceTagAction,
  type DeviceView,
  type DevicesOverview,
  type R1Mood,
} from "@t3tools/baton-contracts";
import {
  DISPLAY_CHOICES,
  EYE_SCREENS,
  KEY_ROWS,
  MOOD_EYES,
  clock,
  deviceStatusLine,
  displayChoiceOf,
  displayLine,
  keyBindingFrom,
  keyBindingLine,
  keyChoiceOf,
  keyChoices,
  msText,
  speakerLine,
  tagActionLine,
  transportLine,
  when,
} from "@t3tools/baton-shared/deviceView";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useState, type ReactNode } from "react";
import { Alert, Image, StyleSheet, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Path, Svg } from "react-native-svg";
import { useResolveClassNames } from "uniwind";

import { AppText as Text } from "../../components/ui/AppText";
import { ControlPill } from "../../components/ui/ControlPill";
import { Menu } from "../../components/ui/Menu";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { batonWorkSessions } from "../../state/batonWorkSessions";
import { useVisibleThreadShells } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSettingsEnvironmentMenu } from "./components/SettingsEnvironmentFilterHeader";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";
import { VoiceEnrolCard } from "./VoiceEnrolCard";

const QUIET = { reportFailure: false } as const;
const INPUT_CLASS = "rounded-lg border border-border-subtle px-3 py-2 text-base text-foreground";
const REFRESH_MS = 5000;
/** While he reads for an R1 enrolment, so the card keeps up with his words. */
const ENROL_REFRESH_MS = 300;
const LEDS = [
  ["green", "Green"],
  ["red", "Red"],
  ["standby", "Standby"],
] as const;
const TAG_CHOICES: ReadonlyArray<readonly [string, string]> = [
  ["mute", "Mute"],
  ["unmute", "Unmute"],
  ...R1_MOODS.map((m) => [`mood:${m}`, `Eyes: ${m}`] as const),
];
type Kind = "read" | "act" | "owner";
type RoomBrain = "auto" | "api" | "subscription";
const ROOM_BRAINS = ["auto", "api", "subscription"] as const;
const ROOM_BRAIN_LABELS = {
  auto: "Automatic",
  api: "Anthropic API key",
  subscription: "Claude subscription",
} as const;
type Run = (
  kind: Kind,
  op: string,
  args: Record<string, unknown>,
  done?: (value: unknown) => string,
) => Promise<unknown>;

const lineOf = (v: unknown) =>
  typeof v === "object" && v !== null && "line" in v
    ? String((v as { line: unknown }).line)
    : "Done.";

export function SettingsHardwareRouteScreen() {
  const environmentMenu = useSettingsEnvironmentMenu();
  const { selectedTargets } = useSettingsEnvironmentFilter();
  const insets = useSafeAreaInsets();
  return (
    <SettingsScreen title="Hardware" menus={[environmentMenu]}>
      <ScreenScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {selectedTargets.length === 0 ? (
          <Text className="text-foreground-muted">Connect an environment to see its devices.</Text>
        ) : (
          selectedTargets.map((environment) => (
            <HardwareSections
              key={environment.environmentId}
              environmentId={environment.environmentId}
              roomBrain={environment.serverConfig.settings.roomBrain}
              label={selectedTargets.length > 1 ? environment.label : null}
            />
          ))
        )}
      </ScreenScrollView>
    </SettingsScreen>
  );
}

function MoodEyes({ mood }: { readonly mood: R1Mood }) {
  const color = String(
    StyleSheet.flatten(useResolveClassNames("text-foreground"))?.color ?? "currentColor",
  );
  return (
    <Svg width={33} height={15} viewBox="0 0 80 36" accessible={false}>
      {[...EYE_SCREENS, ...MOOD_EYES[mood]].map((mark, i) => (
        <Path
          // oxlint-disable-next-line react/no-array-index-key -- a fixed drawing; marks never reorder
          key={i}
          d={mark.d}
          fill={mark.fill ? color : "none"}
          stroke={color}
          strokeWidth={i < EYE_SCREENS.length ? 1.5 : 3}
          strokeLinecap="round"
          opacity={i < EYE_SCREENS.length ? 0.35 : 1}
        />
      ))}
    </Svg>
  );
}

function HardwareSections({
  environmentId,
  roomBrain,
  label,
}: {
  readonly environmentId: EnvironmentId;
  readonly roomBrain: RoomBrain;
  readonly label: string | null;
}) {
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "room brain update",
    reportFailure: true,
  });
  const devicesCall = useAtomCommand(batonWorkSessions.devicesCall, QUIET);
  const homeCall = useAtomCommand(batonWorkSessions.homeCall, QUIET);
  const [view, setView] = useState<DevicesOverview | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    const result = await devicesCall({
      environmentId,
      input: { kind: "read", op: "list", args: {} },
    });
    if (result._tag === "Success" && result.value.ok)
      setView(result.value.value as DevicesOverview);
  };
  const reading =
    view?.devices.some((d) => d.enrol?.phase === "reading" || d.enrol?.phase === "saving") === true;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- follows the server's live device status while open
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect, react/exhaustive-effect-dependencies -- first read, then every few seconds while the screen is open (faster during an enrolment read); refresh closes over this environment
    void refresh();
    const timer = setInterval(() => void refresh(), reading ? ENROL_REFRESH_MS : REFRESH_MS);
    return () => clearInterval(timer);
  }, [environmentId, reading]);

  const run: Run = async (kind, op, args, done) => {
    if (busy) return null;
    setBusy(true);
    setNote("");
    const result = await devicesCall({ environmentId, input: { kind, op, args } });
    const reply: BatonDevicesCallResult | null = result._tag === "Success" ? result.value : null;
    setNote(
      reply === null
        ? "Couldn’t reach this environment. Try again."
        : reply.ok
          ? (done ?? lineOf)(reply.value)
          : (reply.error ?? "That was not done."),
    );
    setBusy(false);
    await refresh();
    return reply?.ok === true ? reply.value : null;
  };

  const prefix = label === null ? "" : `${label} · `;
  const devices = view?.devices ?? [];
  return (
    <>
      <SettingsSection title={`${prefix}Hardware devices`}>
        <Row
          title="Broker"
          description={
            view === null
              ? "Reading…"
              : view.broker.state === "off"
                ? "No device is set up. Set up an R1 below."
                : `${view.broker.state === "connected" ? "Connected to" : "Connecting to"} ${view.broker.host ?? "the broker"}.`
          }
        />
        {devices.map((d) => (
          <Row
            key={d.id}
            divider
            title={`${d.name}${d.muted ? " · muted" : ""}${d.camera.armedUntil === null ? "" : " · camera on"}`}
            description={deviceStatusLine(d)}
          />
        ))}
        {view?.pending.map((p) => (
          <Row
            key={p.id}
            divider
            title={p.line}
            description="Waiting for your yes on your phone."
          />
        ))}
        {note === "" ? null : (
          <Text
            accessibilityLiveRegion="polite"
            className="px-4 pb-3 text-sm text-foreground-muted"
          >
            {note}
          </Text>
        )}
      </SettingsSection>

      {devices.map((d) => (
        <DeviceControls
          key={d.id}
          device={d}
          tags={view?.tags ?? []}
          busy={busy}
          run={run}
          prefix={prefix}
          environmentId={environmentId}
        />
      ))}

      <SettingsSection title={`${prefix}Room brain`}>
        <Row
          title={ROOM_BRAIN_LABELS[roomBrain]}
          description="Automatic uses your Anthropic key from Settings → APIs for the quickest answers, and your Claude subscription if the key fails. Changes apply from the next thing you say, on every R1 this server answers."
        >
          {ROOM_BRAINS.map((way) => (
            <ControlPill
              key={way}
              variant={way === roomBrain ? "primary" : "pill"}
              label={ROOM_BRAIN_LABELS[way]}
              onPress={() =>
                void updateSettings({ environmentId, input: { patch: { roomBrain: way } } })
              }
            />
          ))}
        </Row>
      </SettingsSection>

      <SetupSection
        prefix={prefix}
        busy={busy}
        configured={devices.some((d) => d.configured)}
        onSave={async (args) => {
          setBusy(true);
          const result = await homeCall({
            environmentId,
            input: { kind: "act", op: "r1Setup", args },
          });
          setBusy(false);
          setNote(
            result._tag === "Success" && result.value.ok
              ? "Saved. The server connects to its broker within a few seconds."
              : result._tag === "Success"
                ? (result.value.error ?? "That was not saved.")
                : "Couldn’t reach this environment. Try again.",
          );
          await refresh();
        }}
      />
    </>
  );
}

function DeviceControls({
  device: d,
  tags,
  busy,
  run,
  prefix,
  environmentId,
}: {
  readonly device: DeviceView;
  readonly tags: DevicesOverview["tags"];
  readonly busy: boolean;
  readonly run: Run;
  readonly prefix: string;
  readonly environmentId: EnvironmentId;
}) {
  const id = d.id;
  const off = busy || d.online !== true;
  const [say, setSay] = useState("");
  const [picture, setPicture] = useState<{ at: string; dataUrl: string } | null>(null);
  const confirm = (title: string, body: string, action: string, onYes: () => void) =>
    Alert.alert(title, body, [
      { text: "Cancel", style: "cancel" },
      { text: action, style: "destructive", onPress: onYes },
    ]);

  return (
    <>
      <SettingsSection title={`${prefix}Live controls · ${id}`}>
        <Row title="Eyes" description={`Showing ${d.mood ?? "unknown"}. Pick a mood to show it.`}>
          {R1_MOODS.map((mood) => (
            <ControlPill
              key={mood}
              variant={d.mood === mood ? "primary" : "pill"}
              label={mood}
              accessibilityLabel={`Eyes: ${mood}`}
              disabled={off}
              iconNode={<MoodEyes mood={mood} />}
              onPress={() => void run("act", "eye", { id, mood })}
            />
          ))}
        </Row>
        <Row divider title="Light" description="The firmware shows three light states.">
          {LEDS.map(([color, text]) => (
            <ControlPill
              key={color}
              variant="pill"
              label={text}
              disabled={off}
              onPress={() => void run("act", "led", { id, color })}
            />
          ))}
        </Row>
        <Row divider title="Vibration" description="One short buzz, to check the motor.">
          <ControlPill
            variant="pill"
            label="Test"
            disabled={off}
            onPress={() => void run("act", "vibrate", { id, ms: 150 })}
          />
        </Row>
        <Row
          divider
          title="Volume"
          description={
            d.volume == null
              ? "This firmware has no volume command. Its own buttons still change it."
              : `${d.volume} of 100. Asking her also works: “speak up”, “too loud”, “normal volume”.`
          }
        >
          {d.volume == null
            ? null
            : (
                [
                  ["down", "Quieter"],
                  ["default", "Normal"],
                  ["up", "Louder"],
                ] as const
              ).map(([to, label]) => (
                <ControlPill
                  key={to}
                  variant="pill"
                  label={label}
                  disabled={off}
                  onPress={() => void run("act", "volume", { id, to })}
                />
              ))}
        </Row>
        <View className="gap-2 border-t border-border-subtle px-4 py-3">
          <Text textRole="body" className="text-foreground">
            Say something
          </Text>
          <TextInput
            accessibilityLabel="What the device says"
            className={INPUT_CLASS}
            placeholderTextColorClassName="accent-foreground-muted"
            placeholder="Dinner is ready."
            maxLength={400}
            editable={!off}
            value={say}
            onChangeText={setSay}
          />
          <View className="flex-row">
            <ControlPill
              variant="primary"
              label="Say"
              disabled={off || say.trim() === ""}
              onPress={() =>
                void run("act", "say", { id, text: say.trim() }).then((v) => {
                  if (v !== null) setSay("");
                })
              }
            />
          </View>
        </View>
        <Row
          divider
          title="Mute"
          description={
            d.muted
              ? "Muted: it neither listens nor speaks."
              : "It listens for its wake word and answers."
          }
        >
          <ControlPill
            variant="pill"
            label={d.muted ? "Unmute" : "Mute"}
            disabled={off}
            onPress={() => void run("act", "mute", { id, muted: !d.muted })}
          />
        </Row>
        <Row
          divider
          title="Earcons"
          description="A soft sound when it starts listening and when it closes."
        >
          <ControlPill
            variant="pill"
            label={d.earcons ? "Turn off" : "Turn on"}
            disabled={off}
            onPress={() => void run("act", "earcons", { id, on: !d.earcons })}
          />
        </Row>
        <Row divider title="Screen" description={displayLine(d)}>
          {DISPLAY_CHOICES.map(([value, label]) => (
            <ControlPill
              key={value}
              variant={value === displayChoiceOf(d) ? "primary" : "pill"}
              label={label}
              disabled={off}
              onPress={() => void run("act", "display", { id, set: value })}
            />
          ))}
          <ControlPill
            variant="pill"
            label="Set upright"
            disabled={off}
            onPress={() => void run("act", "display", { id, set: "calibrate" })}
          />
        </Row>
      </SettingsSection>

      <SettingsSection title={`${prefix}Voice · ${id}`}>
        <Row title="Voice transport" description={transportLine(d)}>
          {d.revertAt === null ? null : (
            <ControlPill
              variant="primary"
              label="Keep"
              disabled={off}
              onPress={() => void run("act", "transportConfirm", { id })}
            />
          )}
          {d.transport === "inhouse" ? (
            <ControlPill
              variant="pill"
              label="Try Agora"
              disabled={off}
              onPress={() => void run("act", "transport", { id, transport: "agora" })}
            />
          ) : (
            <ControlPill
              variant="pill"
              label="Revert to in-house"
              disabled={busy}
              onPress={() => void run("act", "transportRevert", { id })}
            />
          )}
        </Row>
        <Row
          divider
          title="Persona and voice"
          description="Tessaya, speaking with the voice anna. Her voice is set in Voice; the room follows it once that setting lives on the server."
        />
        <Row
          divider
          title="Voice ID"
          description={
            d.enrolling
              ? "Enrolling: read the sentences on the card aloud to the device."
              : "Teach the device your voice, through its own microphones."
          }
        >
          <ControlPill
            variant="pill"
            label={d.enrolling ? "Cancel" : "Enrol"}
            disabled={off}
            onPress={() => void run("act", "enrol", { id, cancel: d.enrolling })}
          />
        </Row>
        {d.enrol === null ? null : (
          <VoiceEnrolCard
            card={d.enrol}
            onClose={() => void run("act", "enrol", { id, cancel: true })}
            onRedo={() => void run("act", "enrol", { id, cancel: false })}
          />
        )}
      </SettingsSection>

      {d.speaker === null ? null : (
        <SpeakerSection device={d} busy={busy} run={run} prefix={prefix} />
      )}

      <TagsSection device={d} tags={tags} busy={busy} run={run} prefix={prefix} />

      <KeysSection device={d} busy={busy} run={run} prefix={prefix} environmentId={environmentId} />

      <SettingsSection title={`${prefix}Camera · ${id}`}>
        <Row
          title={d.camera.armedUntil === null ? "Snapshot" : "Snapshot · camera on"}
          description={
            d.camera.armedUntil !== null
              ? `The camera is on until ${clock(d.camera.armedUntil)}, for one picture.`
              : (d.camera.line ??
                "One picture, only when you ask. It is held in memory for 10 minutes and never stored.")
          }
        >
          {d.camera.shotAt === null ? null : (
            <ControlPill
              variant="pill"
              label="Show"
              disabled={busy}
              onPress={() =>
                void run("owner", "cameraView", { id }, () => "").then((v) =>
                  setPicture(v as { at: string; dataUrl: string } | null),
                )
              }
            />
          )}
          <ControlPill
            variant="pill"
            label="Take one"
            disabled={off || d.camera.armedUntil !== null}
            onPress={() => void run("owner", "camera", { id })}
          />
        </Row>
        {picture === null ? null : (
          <View className="gap-2 border-t border-border-subtle px-4 py-3">
            <Text textRole="footnote" className="text-foreground-muted">
              Taken {when(picture.at)}
            </Text>
            <Image
              source={{ uri: picture.dataUrl }}
              accessibilityLabel="The R1's camera picture"
              className="aspect-[4/3] w-full rounded-lg"
            />
            <View className="flex-row">
              <ControlPill
                variant="danger"
                label="Delete now"
                disabled={busy}
                onPress={() =>
                  void run("owner", "cameraClear", { id }, () => "Deleted.").then(() =>
                    setPicture(null),
                  )
                }
              />
            </View>
          </View>
        )}
      </SettingsSection>

      <SettingsSection title={`${prefix}Diagnostics · ${id}`}>
        <Row
          title="Firmware update"
          description={
            d.ota === null
              ? `No update running${d.firmware === null ? "" : `; on ${d.firmware}`}. Updates come with the firmware work.`
              : `Last update: ${d.ota.line}`
          }
        />
        {d.stages.map((s) => (
          <Row
            key={s.name}
            divider
            title={s.name}
            description={`Last ${msText(s.lastMs)} · typical ${msText(s.p50Ms)} · ${s.samples} turns`}
          />
        ))}
        <Row divider title="Log" description="What the device said most recently.">
          <ControlPill
            variant="pill"
            label="Snapshot"
            disabled={off}
            onPress={() => void run("act", "diag", { id })}
          />
        </Row>
        {d.log.length === 0 ? null : (
          <View className="gap-1 px-4 pb-3">
            {d.log.slice(0, 15).map((l, i) => (
              <Text
                // oxlint-disable-next-line react/no-array-index-key -- log lines can repeat exactly
                key={`${l.at}-${i}`}
                textRole="footnote"
                numberOfLines={1}
                className="font-mono text-foreground-muted"
              >
                {clock(l.at)} {l.topic} {l.text}
              </Text>
            ))}
          </View>
        )}
        <Row divider title="Restart" description="Back in about half a minute.">
          <ControlPill
            variant="pill"
            label="Restart"
            disabled={off}
            onPress={() =>
              confirm(
                `Restart ${id}?`,
                "It stops listening while it restarts. In-house voice comes back on by itself.",
                "Restart",
                () => void run("owner", "reboot", { id }),
              )
            }
          />
        </Row>
        <Row
          divider
          title="Forget this device"
          description="Removes its settings and its key from this server."
        >
          <ControlPill
            variant="danger"
            label="Forget"
            disabled={busy}
            onPress={() =>
              confirm(
                `Forget ${id}?`,
                "Its key, broker and tag settings are removed from this server. Nothing on the device changes.",
                "Forget",
                () => void run("act", "forget", { id }),
              )
            }
          />
        </Row>
      </SettingsSection>
    </>
  );
}

const actionOf = (choice: string, scene: string): DeviceTagAction | null =>
  choice === "mute" || choice === "unmute"
    ? { kind: choice }
    : choice.startsWith("mood:")
      ? { kind: "mood", mood: choice.slice(5) as R1Mood }
      : scene.trim() === ""
        ? null
        : { kind: "scene", entityId: scene.trim() };

function TagsSection({
  device: d,
  tags,
  busy,
  run,
  prefix,
}: {
  readonly device: DeviceView;
  readonly tags: DevicesOverview["tags"];
  readonly busy: boolean;
  readonly run: Run;
  readonly prefix: string;
}) {
  const [label, setLabel] = useState("");
  const [choice, setChoice] = useState("mute");
  const [scene, setScene] = useState("");
  const uid = d.lastTag?.uid ?? null;
  const action = actionOf(choice, scene);
  const choiceText =
    choice === "scene"
      ? "Run a scene"
      : (TAG_CHOICES.find(([value]) => value === choice)?.[1] ?? choice);
  return (
    <SettingsSection title={`${prefix}NFC tags`}>
      <View className="gap-2 px-4 py-3">
        <Text textRole="footnote" className="text-foreground-muted">
          {d.lastTag === null
            ? "Tap a tag on the R1, then give it a name and what it does."
            : `Last tapped: ${d.lastTag.uid} at ${clock(d.lastTag.at)}.`}
        </Text>
        <TextInput
          accessibilityLabel="Tag name"
          className={INPUT_CLASS}
          placeholderTextColorClassName="accent-foreground-muted"
          placeholder="Desk dock"
          maxLength={60}
          editable={!busy}
          value={label}
          onChangeText={setLabel}
        />
        <View className="flex-row flex-wrap gap-2">
          <Menu
            accessible
            accessibilityRole="button"
            accessibilityLabel="What a tap does"
            title="What a tap does"
            actions={[
              ...TAG_CHOICES.map(([value, title]) => ({
                id: value,
                title,
                state: value === choice ? ("on" as const) : ("off" as const),
              })),
              {
                id: "scene",
                title: "Run a scene",
                state: choice === "scene" ? ("on" as const) : ("off" as const),
              },
            ]}
            onPressAction={({ nativeEvent }) => setChoice(nativeEvent.event)}
          >
            <ControlPill variant="pill" label={choiceText} />
          </Menu>
          <ControlPill
            variant="primary"
            label="Assign"
            disabled={busy || uid === null || label.trim() === "" || action === null}
            onPress={() =>
              void run(
                "act",
                "nfcAssign",
                { uid, label: label.trim(), action },
                () => `Tag ${label.trim()} saved.`,
              ).then((v) => {
                if (v !== null) setLabel("");
              })
            }
          />
        </View>
        {choice === "scene" ? (
          <TextInput
            accessibilityLabel="Scene entity id"
            className={INPUT_CLASS}
            placeholderTextColorClassName="accent-foreground-muted"
            placeholder="scene.desk_mode"
            autoCapitalize="none"
            autoCorrect={false}
            value={scene}
            onChangeText={setScene}
          />
        ) : null}
      </View>
      {tags.map((t) => (
        <Row
          key={t.uid}
          divider
          title={t.label}
          description={`${t.uid} · ${tagActionLine(t.action)}`}
        >
          <ControlPill
            variant="pill"
            label="Remove"
            disabled={busy}
            onPress={() => void run("act", "nfcRemove", { uid: t.uid }, () => "Removed.")}
          />
        </Row>
      ))}
    </SettingsSection>
  );
}

const detailOf = (b: R1KeyBinding | undefined) =>
  b?.kind === "prompt" ? b.text : b?.kind === "home" ? b.entityId : "";

/** The R1's buttons, as on web: the firmware's fixed presses read-only, the rest its own action or one of hers. */
function KeysSection({
  device: d,
  busy,
  run,
  prefix,
  environmentId,
}: {
  readonly device: DeviceView;
  readonly busy: boolean;
  readonly run: Run;
  readonly prefix: string;
  readonly environmentId: EnvironmentId;
}) {
  const canEdit = useAtomValue(
    batonWorkSessions.devicesCall.permissionAtom(environmentId, { kind: "act" }),
  );
  const [slot, setSlot] = useState<R1KeySlot>("s2.double");
  const [choice, setChoice] = useState<string | null>(null);
  const [text, setText] = useState(detailOf(d.keys[slot]));
  const [threadId, setThreadId] = useState<string | null>(null);
  const current = d.keys[slot];
  const picked = choice ?? (current === undefined ? "device:none" : keyChoiceOf(current));
  const choices = keyChoices(slot);
  const threads = useVisibleThreadShells()
    .filter((t) => t.environmentId === environmentId)
    .slice(0, 40);
  const pickedThread =
    threads.find((t) => t.id === threadId) ??
    (current?.kind === "thread" && threadId === null
      ? { id: current.threadId, title: current.title }
      : null);
  const bind = keyBindingFrom(picked, text, pickedThread);
  const free = KEY_ROWS.filter((r) => r.fixed === null);
  return (
    <SettingsSection title={`${prefix}Buttons · ${d.id}`}>
      {(["s1", "s2", "s3"] as const).map((key, i) => (
        <Row
          key={key}
          divider={i > 0}
          title={key.toUpperCase()}
          description={KEY_ROWS.filter((r) => r.slot.startsWith(`${key}.`))
            .map((r) => {
              const b = d.keys[r.slot];
              const what = r.fixed ?? (b === undefined ? "" : keyBindingLine(b));
              return `${r.title.split(" ")[1]}: ${what}${r.fixed === null ? "" : " (fixed)"}`;
            })
            .join("\n")}
        />
      ))}
      <View className="gap-2 border-t border-border-subtle px-4 py-3">
        <Text textRole="footnote" className="text-foreground-muted">
          {d.keyNote ??
            (canEdit
              ? "Pick a press and what it does. A Tessaya action runs only where the R1 itself does nothing."
              : "This connection can look but not change the buttons.")}
        </Text>
        <View className="flex-row flex-wrap gap-2">
          <Menu
            accessible
            accessibilityRole="button"
            accessibilityLabel="Press"
            title="Press"
            actions={free.map((r) => ({
              id: r.slot,
              title: r.title,
              state: r.slot === slot ? ("on" as const) : ("off" as const),
            }))}
            onPressAction={({ nativeEvent }) => {
              const s = nativeEvent.event as R1KeySlot;
              setSlot(s);
              setChoice(null);
              setText(detailOf(d.keys[s]));
              setThreadId(null);
            }}
          >
            <ControlPill variant="pill" label={free.find((r) => r.slot === slot)?.title ?? slot} />
          </Menu>
          <Menu
            accessible
            accessibilityRole="button"
            accessibilityLabel="What it does"
            title="What it does"
            actions={choices.map(([value, title]) => ({
              id: value,
              title,
              state: value === picked ? ("on" as const) : ("off" as const),
            }))}
            onPressAction={({ nativeEvent }) => setChoice(nativeEvent.event)}
          >
            <ControlPill
              variant="pill"
              label={choices.find(([v]) => v === picked)?.[1] ?? picked}
            />
          </Menu>
          {picked.startsWith("thread:") ? (
            <Menu
              accessible
              accessibilityRole="button"
              accessibilityLabel="Thread"
              title="Thread"
              actions={threads.map((t) => ({
                id: t.id,
                title: t.title,
                state: t.id === pickedThread?.id ? ("on" as const) : ("off" as const),
              }))}
              onPressAction={({ nativeEvent }) => setThreadId(nativeEvent.event)}
            >
              <ControlPill variant="pill" label={pickedThread?.title ?? "Pick a thread"} />
            </Menu>
          ) : null}
          <ControlPill
            variant="primary"
            label="Save"
            disabled={!canEdit || busy || d.online !== true || bind === null}
            onPress={() =>
              void run("act", "keyBind", { id: d.id, slot, bind }).then((v) => {
                if (v !== null) setChoice(null);
              })
            }
          />
        </View>
        {picked === "home" || picked === "prompt" ? (
          <TextInput
            accessibilityLabel={picked === "home" ? "Home Assistant entity" : "What to ask her"}
            className={INPUT_CLASS}
            placeholderTextColorClassName="accent-foreground-muted"
            placeholder={
              picked === "home" ? "light.desk_lamp or scene.evening" : "What's on today?"
            }
            autoCapitalize={picked === "home" ? "none" : "sentences"}
            autoCorrect={picked !== "home"}
            maxLength={picked === "home" ? 200 : 400}
            value={text}
            onChangeText={setText}
          />
        ) : null}
      </View>
    </SettingsSection>
  );
}

function SetupSection({
  prefix,
  busy,
  configured,
  onSave,
}: {
  readonly prefix: string;
  readonly busy: boolean;
  readonly configured: boolean;
  readonly onSave: (args: Record<string, string>) => Promise<void>;
}) {
  const [deviceId, setDeviceId] = useState("");
  const [mqttUrl, setMqttUrl] = useState("");
  const [mqttUser, setMqttUser] = useState("");
  const [mqttPass, setMqttPass] = useState("");
  const [deviceKey, setDeviceKey] = useState("");
  const field = (
    labelText: string,
    value: string,
    onChange: (next: string) => void,
    secret = false,
  ) => (
    <TextInput
      accessibilityLabel={labelText}
      className={INPUT_CLASS}
      placeholderTextColorClassName="accent-foreground-muted"
      placeholder={labelText}
      autoCapitalize="none"
      autoCorrect={false}
      secureTextEntry={secret}
      editable={!busy}
      value={value}
      onChangeText={onChange}
    />
  );
  return (
    <SettingsSection
      title={`${prefix}${configured ? "Replace the R1's settings" : "Set up an R1"}`}
    >
      <View className="gap-2 px-4 py-3">
        <Text textRole="footnote" className="text-foreground-muted">
          Its id (r1-…), the MQTT broker it listens on, and the key it uses to reach Tessaya (24
          characters or more). The key and password stay on the server.
        </Text>
        {field("Device id, e.g. r1-3d57b3", deviceId, setDeviceId)}
        {field("mqtt://broker.local:1883", mqttUrl, setMqttUrl)}
        {field("Broker user (optional)", mqttUser, setMqttUser)}
        {field("Broker password (optional)", mqttPass, setMqttPass, true)}
        {field(
          configured ? "Saved. Enter a new device key to replace it." : "Device key",
          deviceKey,
          setDeviceKey,
          true,
        )}
        <View className="flex-row">
          <ControlPill
            variant="primary"
            label="Save"
            disabled={
              busy ||
              deviceId.trim() === "" ||
              mqttUrl.trim() === "" ||
              deviceKey.trim().length < 24
            }
            onPress={() =>
              void onSave({
                deviceKey: deviceKey.trim(),
                deviceId: deviceId.trim(),
                mqttUrl: mqttUrl.trim(),
                ...(mqttUser.trim() === "" ? {} : { mqttUser: mqttUser.trim() }),
                ...(mqttPass === "" ? {} : { mqttPass }),
              }).then(() => {
                setDeviceKey("");
                setMqttPass("");
              })
            }
          />
        </View>
      </View>
    </SettingsSection>
  );
}

const OUTPUTS = [
  ["auto", "Speaker, else R1"],
  ["bt", "Speaker only"],
  ["onboard", "R1 only"],
] as const;

/** Shown only once the R1's firmware reports it can drive a Bluetooth speaker. */
function SpeakerSection({
  device: d,
  busy,
  run,
  prefix,
}: {
  readonly device: DeviceView;
  readonly busy: boolean;
  readonly run: Run;
  readonly prefix: string;
}) {
  const id = d.id;
  const s = d.speaker!;
  const off = busy || d.online !== true;
  const linked = s.state === "connected" || s.state === "streaming";
  return (
    <SettingsSection title={`${prefix}Bluetooth speaker · ${id}`}>
      <Row title={s.saved?.name ?? "Speaker"} description={speakerLine(s)}>
        {s.saved === null ? null : (
          <ControlPill
            variant={linked ? "pill" : "primary"}
            label={linked ? "Disconnect" : "Connect"}
            disabled={off || s.state === "connecting"}
            onPress={() =>
              void run("act", "speaker", { id, action: linked ? "disconnect" : "connect" })
            }
          />
        )}
        {s.saved === null ? null : (
          <ControlPill
            variant="pill"
            label="Forget"
            disabled={off}
            onPress={() => void run("act", "speaker", { id, action: "forget" })}
          />
        )}
      </Row>
      <Row divider title="Replies play on" description="">
        {OUTPUTS.map(([output, label]) => (
          <ControlPill
            key={output}
            variant={s.output === output ? "primary" : "pill"}
            label={label}
            disabled={off}
            onPress={() => void run("act", "speaker", { id, action: "route", output })}
          />
        ))}
      </Row>
      <Row
        divider
        title="Pair a speaker"
        description={
          s.scannedAt === null
            ? "Put the speaker in pairing mode, then scan."
            : `${s.found.length} found at ${clock(s.scannedAt)}. Pick one to pair.`
        }
      >
        <ControlPill
          variant="pill"
          label={s.state === "scanning" ? "Scanning…" : "Scan"}
          disabled={off || s.state === "scanning"}
          onPress={() => void run("act", "speaker", { id, action: "scan" })}
        />
        {s.found.map((f) => (
          <ControlPill
            key={f.mac}
            variant={s.saved?.mac === f.mac ? "primary" : "pill"}
            label={`${f.name || f.mac}${f.audio ? "" : " (not audio)"}`}
            disabled={off}
            onPress={() => void run("act", "speaker", { id, action: "pair", mac: f.mac })}
          />
        ))}
      </Row>
    </SettingsSection>
  );
}

function Row(props: {
  readonly title: string;
  readonly description: string;
  readonly divider?: boolean;
  readonly children?: ReactNode;
}) {
  return (
    <View
      className={
        props.divider
          ? "min-h-16 gap-3 border-t border-border-subtle px-4 py-3"
          : "min-h-16 gap-3 px-4 py-3"
      }
    >
      <View accessible className="min-w-0 gap-0.5">
        <Text textRole="body" className="text-foreground">
          {props.title}
        </Text>
        <Text textRole="footnote" className="text-foreground-muted">
          {props.description}
        </Text>
      </View>
      {props.children ? <View className="flex-row flex-wrap gap-2">{props.children}</View> : null}
    </View>
  );
}
