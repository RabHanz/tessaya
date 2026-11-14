/**
 * Settings → Hardware: Tessaya's physical devices (the Agora R1 first). Status and every control go through the
 * server's `baton.devices.call`; no client speaks MQTT. Camera and restart are the owner kind (approval scope).
 */
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  R1_MOODS,
  type R1KeyBinding,
  type R1KeySlot,
  type BatonDevicesCallResult,
  type DeviceTagAction,
  type DeviceView,
  type DevicesOverview,
  type R1Mood,
  type DeviceItem,
  type DeviceSafety,
  type RegisteredDevice,
} from "@t3tools/baton-contracts";
import { accessOf, groupItems, valueText } from "@t3tools/baton-shared/deviceItems";
import type { R1UpdatesView } from "@t3tools/baton-shared/r1Firmware";
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
  btDeviceLabel,
  btKindNoun,
  displaySupported,
  outputLabels,
  scanLine,
  tesselHosts,
  type TesselSeen,
} from "@t3tools/baton-shared/deviceView";
import { Link } from "@tanstack/react-router";
import {
  BluetoothIcon,
  CarIcon,
  HeadphonesIcon,
  HeadsetIcon,
  RadioReceiverIcon,
  SpeakerIcon,
} from "lucide-react";
import { useEffect, useState } from "react";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { batonWorkSessions } from "../../state/batonWorkSessions";
import { useVisibleThreadShells } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { NumberField, NumberFieldGroup, NumberFieldInput } from "../ui/number-field";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { BodiesSection } from "./BodiesSection";
import { DeviceUtilitySection } from "./DeviceUtilitySection";
import { R1SetupSection } from "./R1SetupSection";
import { SecretInput } from "./SecretInput";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { VoiceEnrolCard } from "./VoiceEnrolCard";
import { DEVICE } from "@t3tools/baton-shared/productNames";

const REFRESH_MS = 5000;
/** While he reads for an R1 enrolment, so the card keeps up with his words. */
const ENROL_REFRESH_MS = 300;
type Kind = "read" | "act" | "owner";

/**
 * The household's devices, with no server to pick (13 Nov): every connected server's devices on one page, each one
 * driven through the server that holds it. The R1's setup and room brain show once, on the server that has the R1
 * (else this machine's own).
 */
export function HardwareSettingsPanel() {
  const { environments } = useEnvironments();
  const primary = usePrimaryEnvironmentId();
  const connected = environments
    .filter((e) => e.connection.phase === "connected")
    .map((e) => e.environmentId)
    .toSorted((a, b) => (a === primary ? -1 : b === primary ? 1 : 0));
  // What each server hears, so a Tessel several servers reach (a bridged broker) shows once, on its primary host.
  const [seen, setSeen] = useState<ReadonlyMap<EnvironmentId, ReadonlyArray<TesselSeen>>>(
    new Map(),
  );
  const hosts = tesselHosts(
    connected.flatMap((host) => {
      const devices = seen.get(host);
      return devices === undefined ? [] : [{ host, devices }];
    }),
  );
  const home =
    connected.find((id) => seen.get(id)?.some((d) => d.configured)) ?? connected[0] ?? null;
  const report = (id: EnvironmentId, devices: ReadonlyArray<TesselSeen>) =>
    setSeen((was) =>
      JSON.stringify(was.get(id)) === JSON.stringify(devices) ? was : new Map(was).set(id, devices),
    );
  const labelOf = (id: EnvironmentId) =>
    environments.find((e) => e.environmentId === id)?.label ?? id;
  return (
    <SettingsPageContainer>
      {connected.length === 0 ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">
          Connect to your Tessaya server to see your devices.
        </p>
      ) : (
        connected.map((id) => (
          <HardwareSections
            key={id}
            environmentId={id}
            label={connected.length > 1 ? labelOf(id) : null}
            home={id === home}
            onSeen={report}
            owns={(deviceId) => (hosts.get(deviceId)?.primary ?? id) === id}
            alsoOn={(deviceId) => (hosts.get(deviceId)?.reachable ?? []).map(labelOf)}
          />
        ))
      )}
    </SettingsPageContainer>
  );
}

/** One mood's still eyes, drawn from the shared sketch. */
function MoodEyes({ mood }: { readonly mood: R1Mood }) {
  return (
    <svg viewBox="0 0 80 36" className="size-auto h-5 w-11" aria-hidden="true">
      {[...EYE_SCREENS, ...MOOD_EYES[mood]].map((mark, i) => (
        <path
          // oxlint-disable-next-line react/no-array-index-key -- a fixed drawing; marks never reorder
          key={i}
          d={mark.d}
          fill={mark.fill ? "currentColor" : "none"}
          stroke="currentColor"
          strokeWidth={i < EYE_SCREENS.length ? 1 : 2.5}
          strokeLinecap="round"
          opacity={i < EYE_SCREENS.length ? 0.35 : 1}
        />
      ))}
    </svg>
  );
}

function HardwareSections({
  environmentId,
  label,
  home,
  onSeen,
  owns,
  alsoOn,
}: {
  readonly environmentId: EnvironmentId;
  /** This server's name, when the page shows more than one. */
  readonly label: string | null;
  /** The server whose R1 setup and room brain this page shows. */
  readonly home: boolean;
  readonly onSeen: (environmentId: EnvironmentId, devices: ReadonlyArray<TesselSeen>) => void;
  /** Whether this server is the device's primary host; another server's devices show there only. */
  readonly owns: (deviceId: string) => boolean;
  readonly alsoOn: (deviceId: string) => ReadonlyArray<string>;
}) {
  const quiet = { reportFailure: false } as const;
  const devicesCall = useAtomCommand(batonWorkSessions.devicesCall, quiet);
  const homeCall = useAtomCommand(batonWorkSessions.homeCall, quiet);
  const [view, setView] = useState<DevicesOverview | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [reach, setReach] = useState<{ away: boolean; offered: boolean; line: string } | null>(
    null,
  );
  // Read once and after each change, not on every refresh: it asks the tunnel for its address.
  // Firmware updates from this server (R1Updates): each R1's line, including why one stopped.
  const [updatesView, setUpdatesView] = useState<R1UpdatesView | null>(null);
  // The R1's room voice on this server (R1Loop): its download, then whether it runs.
  const [voice, setVoice] = useState<string | null>(null);
  const readReach = async () => {
    const result = await devicesCall({
      environmentId,
      input: { kind: "read", op: "reach", args: {} },
    });
    if (result._tag === "Success" && result.value.ok)
      setReach(result.value.value as { away: boolean; offered: boolean; line: string });
  };
  const readUpdates = async () => {
    const upd = await devicesCall({
      environmentId,
      input: { kind: "read", op: "updates", args: {} },
    });
    if (upd._tag === "Success" && upd.value.ok) setUpdatesView(upd.value.value as R1UpdatesView);
  };

  const refresh = async () => {
    const result = await devicesCall({
      environmentId,
      input: { kind: "read", op: "list", args: {} },
    });
    if (result._tag === "Success" && result.value.ok) {
      const next = result.value.value as DevicesOverview;
      setView(next);
      onSeen(environmentId, [
        ...next.devices.map((d) => ({ id: d.id, online: d.online, configured: d.configured })),
        ...(next.registry ?? []).map((r) => ({
          id: r.deviceId,
          online: r.online,
          configured: false,
        })),
      ]);
      const loop = await devicesCall({
        environmentId,
        input: { kind: "read", op: "voice", args: {} },
      });
      if (loop._tag === "Success" && loop.value.ok)
        setVoice((loop.value.value as { line: string } | null)?.line ?? null);
      // In memory on the server: cheap, and an install's progress shows as it goes.
      await readUpdates();
    }
  };
  const reading =
    view?.devices.some((d) => d.enrol?.phase === "reading" || d.enrol?.phase === "saving") === true;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- follows the server's live device status while open
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- first read, then every few seconds while the page is open (faster during an enrolment read); refresh closes over the environment
    void refresh();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- once per environment, like refresh
    void readReach();
    const timer = window.setInterval(() => void refresh(), reading ? ENROL_REFRESH_MS : REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [environmentId, reading]);

  const run = async (
    kind: Kind,
    op: string,
    args: Record<string, unknown>,
    done?: (value: unknown) => string,
  ): Promise<unknown> => {
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

  const heard = view?.devices ?? [];
  const devices = heard.filter((d) => owns(d.id));
  const registry = (view?.registry ?? []).filter((d) => owns(d.deviceId));
  const updates = (updatesView?.devices ?? []).filter((u) => owns(u.id));
  // A server with nothing on it says nothing; the household's page lists devices, not servers.
  if (!home && devices.length === 0 && registry.length === 0) return null;
  return (
    <>
      <SettingsSection {...searchableSetting("hardware-devices")}>
        <SettingsRow
          title={label === null ? "Broker" : `Broker · ${label}`}
          description={
            view === null
              ? "Reading…"
              : view.broker.state === "off"
                ? `No device is set up. Set up a ${DEVICE} below.`
                : `${view.broker.state === "connected" ? "Connected to" : "Connecting to"} ${view.broker.host ?? "the broker"}.`
          }
        />
        {reach === null || view?.broker.host?.includes("this server") !== true ? null : (
          <SettingsRow
            title="Away from home"
            description={reach.line}
            control={
              <Switch
                checked={reach.away}
                disabled={busy}
                aria-label="Away from home"
                onCheckedChange={(enabled) => {
                  const id = heard.find((d) => d.configured)?.id;
                  if (id !== undefined)
                    void run("owner", "away", { id, enabled }).then(() => readReach());
                }}
              />
            }
          />
        )}
        {voice === null ? null : <SettingsRow title="Voice" description={voice} />}
        {updates.map((u) => (
          <SettingsRow key={`fw-${u.id}`} title={`Firmware · ${u.id}`} description={u.line} />
        ))}
        {updates.map((u) => (
          <SettingsRow
            key={`kws-${u.id}`}
            title={`Own wake model · ${u.id}`}
            description={u.kws}
            control={
              <span className="flex gap-1">
                {(["shadow", "off"] as const).map((mode) => (
                  <Button
                    key={mode}
                    size="xs"
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void run("owner", "kwsMode", { id: u.id, mode }).then(() => readReach())
                    }
                  >
                    {mode === "shadow" ? "Shadow" : "Off"}
                  </Button>
                ))}
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void run("owner", "kwsClear", { id: u.id }).then(() => readReach())
                  }
                >
                  Unload
                </Button>
              </span>
            }
          />
        ))}
        {devices.map((d) => (
          <SettingsRow
            key={d.id}
            title={
              <span className="flex items-center gap-2">
                {d.name}
                <Badge variant={d.online === true ? "success" : "outline"}>
                  {d.online === true ? "Online" : "Offline"}
                </Badge>
                {d.muted ? <Badge variant="warning">Muted</Badge> : null}
                {d.camera.armedUntil === null ? null : <Badge variant="error">Camera on</Badge>}
              </span>
            }
            description={deviceStatusLine(d) + reachableLine(alsoOn(d.id))}
          />
        ))}
        {view?.pending.map((p) => (
          <SettingsRow
            key={p.id}
            title={p.line}
            description="Waiting for your yes on your phone."
          />
        ))}
        {note === "" ? null : (
          <p aria-live="polite" className="px-4 pb-3 text-sm text-muted-foreground">
            {note}
          </p>
        )}
      </SettingsSection>

      {devices.map((d) => (
        <DeviceControls
          key={d.id}
          device={d}
          tags={view?.tags ?? []}
          busy={busy}
          run={run}
          environmentId={environmentId}
        />
      ))}

      <DeviceUtilitySection
        devices={devices}
        registry={registry}
        updates={updatesView}
        busy={busy}
        run={run}
        call={async (kind, op, args) => {
          const result = await devicesCall({ environmentId, input: { kind, op, args } });
          return result._tag === "Success" ? result.value : null;
        }}
      />

      {registry.map((d) => (
        <ManifestDevice
          key={d.deviceId}
          device={d}
          // A device the rows above already show (the R1) is one device: its items join it, with no second header.
          shown={devices.some((r) => r.id === d.deviceId)}
          busy={busy}
          run={run}
        />
      ))}

      {home ? <RoomBrainSection environmentId={environmentId} /> : null}

      {home ? (
        <BodiesSection
          call={async (kind, op, args) => {
            const result = await devicesCall({ environmentId, input: { kind, op, args } });
            return result._tag === "Success" ? result.value : null;
          }}
        />
      ) : null}

      {home ? (
        <R1SetupSection
          call={async (kind, op, args) => {
            const result = await devicesCall({ environmentId, input: { kind, op, args } });
            return result._tag === "Success" ? result.value : null;
          }}
          // Unknown until read: never ask twice by mistake.
          awayOffered={reach?.offered ?? true}
          onChanged={() => {
            void refresh();
            void readReach();
          }}
        />
      ) : null}

      {home ? (
        <SetupSection
          busy={busy}
          configured={heard.some((d) => d.configured)}
          onShowBus={() =>
            run("owner", "busLogin", {}, (v) => {
              const login = v as { user: string; key: string; path: string };
              return `User ${login.user}, key ${login.key}, at ws://<this server>${login.path}.`;
            })
          }
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
      ) : null}
    </>
  );
}

const reachableLine = (others: ReadonlyArray<string>) =>
  others.length === 0 ? "" : ` Also reachable from ${others.join(", ")}.`;

const lineOf = (v: unknown) =>
  typeof v === "object" && v !== null && "line" in v
    ? String((v as { line: unknown }).line)
    : "Done.";

type Run = (
  kind: Kind,
  op: string,
  args: Record<string, unknown>,
  done?: (value: unknown) => string,
) => Promise<unknown>;

function DeviceControls({
  device: d,
  tags,
  busy,
  run,
  environmentId,
}: {
  readonly device: DeviceView;
  readonly tags: DevicesOverview["tags"];
  readonly busy: boolean;
  readonly run: Run;
  readonly environmentId: EnvironmentId;
}) {
  const id = d.id;
  const off = busy || d.online !== true;
  const [say, setSay] = useState("");
  const [confirm, setConfirm] = useState<"reboot" | "forget" | "rotate" | null>(null);
  // The server's warning when something on another machine uses the key: asked once more.
  const [rotateWarning, setRotateWarning] = useState<string | null>(null);
  const [picture, setPicture] = useState<{ at: string; dataUrl: string } | null>(null);

  return (
    <>
      <SettingsSection title={`Live controls · ${id}`}>
        <SettingsRow
          title="Eyes"
          description={`Showing ${d.mood ?? "unknown"}. Pick a mood to show it for a few seconds.`}
        >
          <div className="flex flex-wrap gap-1.5 pt-2">
            {R1_MOODS.map((mood) => (
              <Button
                key={mood}
                size="sm"
                variant={d.mood === mood ? "secondary" : "outline"}
                disabled={off}
                aria-label={`Eyes: ${mood}`}
                onClick={() => void run("act", "eye", { id, mood })}
              >
                <MoodEyes mood={mood} />
                {mood}
              </Button>
            ))}
          </div>
        </SettingsRow>
        <SettingsRow
          title="Light"
          description="The firmware shows three light states."
          control={
            <span className="flex gap-1.5">
              {(["green", "red", "standby"] as const).map((color) => (
                <Button
                  key={color}
                  size="xs"
                  variant="outline"
                  disabled={off}
                  onClick={() => void run("act", "led", { id, color })}
                >
                  {color === "standby" ? "Standby" : color === "green" ? "Green" : "Red"}
                </Button>
              ))}
            </span>
          }
        />
        <SettingsRow
          title="Vibration"
          description="One short buzz, to check the motor."
          control={
            <Button
              size="xs"
              variant="outline"
              disabled={off}
              onClick={() => void run("act", "vibrate", { id, ms: 150 })}
            >
              Test
            </Button>
          }
        />
        <SettingsRow
          title="Volume"
          description={
            d.volume == null
              ? "This firmware has no volume command. Its own buttons still change it."
              : `${d.volume} of 100. Asking her also works: “speak up”, “too loud”, “normal volume”.`
          }
          control={
            d.volume == null ? undefined : (
              <span className="flex gap-1.5">
                {(
                  [
                    ["down", "Quieter"],
                    ["default", "Normal"],
                    ["up", "Louder"],
                  ] as const
                ).map(([to, label]) => (
                  <Button
                    key={to}
                    size="xs"
                    variant="outline"
                    disabled={off}
                    onClick={() => void run("act", "volume", { id, to })}
                  >
                    {label}
                  </Button>
                ))}
              </span>
            )
          }
        />
        <SettingsRow title="Say something" description="Spoken out loud in the room.">
          <div className="flex gap-2 pt-2">
            <Input
              value={say}
              maxLength={400}
              placeholder="Dinner is ready."
              onChange={(e) => setSay(e.target.value)}
            />
            <Button
              size="xs"
              disabled={off || say.trim() === ""}
              onClick={() =>
                void run("act", "say", { id, text: say.trim() }).then((v) => {
                  if (v !== null) setSay("");
                })
              }
            >
              Say
            </Button>
          </div>
        </SettingsRow>
        <SettingsRow
          title="Mute"
          description={
            d.muted
              ? "Muted: it neither listens nor speaks."
              : "It listens for its wake word and answers."
          }
          control={
            <Switch
              checked={d.muted}
              disabled={off}
              aria-label="Mute"
              onCheckedChange={(muted) => void run("act", "mute", { id, muted })}
            />
          }
        />
        <SettingsRow
          title="Earcons"
          description="A soft sound when it starts listening and when it closes."
          control={
            <Switch
              checked={d.earcons}
              disabled={off}
              aria-label="Earcons"
              onCheckedChange={(on) => void run("act", "earcons", { id, on })}
            />
          }
        />
        <SettingsRow title="Screen" description={displayLine(d)}>
          <div className="flex flex-wrap gap-2 pt-2">
            <Select
              value={displayChoiceOf(d)}
              onValueChange={(set) => void run("act", "display", { id, set })}
            >
              <SelectTrigger
                size="sm"
                aria-label="Screen rotation"
                disabled={off || !displaySupported(d.display)}
              >
                <SelectValue>
                  {DISPLAY_CHOICES.find(([v]) => v === displayChoiceOf(d))?.[1]}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {DISPLAY_CHOICES.map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <Button
              size="xs"
              variant="outline"
              disabled={off || !displaySupported(d.display)}
              onClick={() => void run("act", "display", { id, set: "calibrate" })}
            >
              Set upright
            </Button>
          </div>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title={`Voice · ${id}`}>
        <SettingsRow
          title="Voice transport"
          description={transportLine(d)}
          control={
            <span className="flex gap-1.5">
              {d.revertAt === null ? null : (
                <Button
                  size="xs"
                  disabled={off}
                  onClick={() => void run("act", "transportConfirm", { id })}
                >
                  Keep
                </Button>
              )}
              {d.transport === "inhouse" ? null : (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void run("act", "transportRevert", { id })}
                >
                  Revert to in-house
                </Button>
              )}
              <Select
                value={d.transport}
                disabled={off}
                onValueChange={(transport) => void run("act", "transport", { id, transport })}
              >
                <SelectTrigger size="sm">
                  <SelectValue>
                    {d.transport === "inhouse" ? "In-house" : "Agora (trial)"}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="inhouse">In-house</SelectItem>
                  <SelectItem value="agora">Agora (trial)</SelectItem>
                </SelectPopup>
              </Select>
            </span>
          }
        />
        <SettingsRow
          title="Persona and voice"
          description={
            <>
              Tessaya, speaking with the voice anna. Her voice is set in{" "}
              <Link to="/settings/voice" className="underline underline-offset-2">
                Voice
              </Link>
              ; the room follows it once that setting lives on the server.
            </>
          }
        />
        <SettingsRow
          title="Voice ID"
          description={
            d.enrolling
              ? "Enrolling: read the sentences on the card aloud to the device."
              : "Teach the device your voice, through its own microphones."
          }
          control={
            <Button
              size="xs"
              variant="outline"
              disabled={off}
              onClick={() => void run("act", "enrol", { id, cancel: d.enrolling })}
            >
              {d.enrolling ? "Cancel" : "Enrol"}
            </Button>
          }
        />
        {d.enrol === null ? null : (
          <VoiceEnrolCard
            card={d.enrol}
            onClose={() => void run("act", "enrol", { id, cancel: true })}
            onRedo={() => void run("act", "enrol", { id, cancel: false })}
          />
        )}
      </SettingsSection>

      {d.speaker === null ? null : <SpeakerSection device={d} busy={busy} run={run} />}

      <TagsSection device={d} tags={tags} busy={busy} run={run} />

      <KeysSection device={d} busy={busy} run={run} environmentId={environmentId} />

      <SettingsSection title={`Camera · ${id}`}>
        <SettingsRow
          title="Snapshot"
          description={
            d.camera.armedUntil !== null
              ? `The camera is on until ${clock(d.camera.armedUntil)}, for one picture.`
              : (d.camera.line ??
                "One picture, only when you ask. It is held in memory for 10 minutes and never stored.")
          }
          status={d.camera.armedUntil === null ? null : <Badge variant="error">Camera on</Badge>}
          control={
            <span className="flex gap-1.5">
              {d.camera.shotAt === null ? null : (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void run("owner", "cameraView", { id }, () => "").then((v) =>
                      setPicture(v as { at: string; dataUrl: string } | null),
                    )
                  }
                >
                  Show
                </Button>
              )}
              <Button
                size="xs"
                variant="outline"
                disabled={off || d.camera.armedUntil !== null}
                onClick={() => void run("owner", "camera", { id })}
              >
                Take one
              </Button>
            </span>
          }
        />
        {picture === null ? null : (
          <SettingsRow
            title={`Taken ${when(picture.at)}`}
            control={
              <Button
                size="xs"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void run("owner", "cameraClear", { id }, () => "Deleted.").then(() =>
                    setPicture(null),
                  )
                }
              >
                Delete now
              </Button>
            }
          >
            <img
              src={picture.dataUrl}
              alt={`The ${DEVICE}'s camera picture`}
              className="mt-2 max-w-full rounded-md"
            />
          </SettingsRow>
        )}
      </SettingsSection>

      <SettingsSection title={`Diagnostics · ${id}`}>
        <SettingsRow
          title="Firmware update"
          description={
            d.ota === null
              ? `No update running${d.firmware === null ? "" : `; on ${d.firmware}`}. Updates come with the firmware work.`
              : `Last update: ${d.ota.line}`
          }
        />
        <SettingsRow
          title="Voice latency"
          description="Per stage: the last turn and the middle of the recent ones."
        >
          <table className="mt-2 w-full text-sm">
            <thead className="text-muted-foreground">
              <tr>
                <th className="text-left font-normal">Stage</th>
                <th className="text-right font-normal">Last</th>
                <th className="text-right font-normal">Typical</th>
                <th className="text-right font-normal">Turns</th>
              </tr>
            </thead>
            <tbody>
              {d.stages.map((s) => (
                <tr key={s.name}>
                  <td>{s.name}</td>
                  <td className="text-right tabular-nums">{msText(s.lastMs)}</td>
                  <td className="text-right tabular-nums">{msText(s.p50Ms)}</td>
                  <td className="text-right tabular-nums">{s.samples}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </SettingsRow>
        <SettingsRow
          title="Log"
          description="What the device said most recently."
          control={
            <Button
              size="xs"
              variant="outline"
              disabled={off}
              onClick={() => void run("act", "diag", { id })}
            >
              Snapshot
            </Button>
          }
        >
          {d.log.length === 0 ? null : (
            <ul className="mt-2 max-h-56 overflow-y-auto font-mono text-xs text-muted-foreground">
              {d.log.map((l, i) => (
                // oxlint-disable-next-line react/no-array-index-key -- log lines can repeat exactly
                <li key={`${l.at}-${i}`} className="truncate">
                  {clock(l.at)} {l.topic} {l.text}
                </li>
              ))}
            </ul>
          )}
        </SettingsRow>
        <SettingsRow
          title="Restart"
          description="Restarts the device; it is back in about half a minute."
          control={
            <Button size="xs" variant="outline" disabled={off} onClick={() => setConfirm("reboot")}>
              Restart
            </Button>
          }
        />
        <SettingsRow
          title="New device key"
          description={`Sends the ${DEVICE} a new key over its link; the old one stops working once it uses the new one.`}
          control={
            <Button size="xs" variant="outline" disabled={off} onClick={() => setConfirm("rotate")}>
              Rotate key
            </Button>
          }
        />
        <SettingsRow
          title="Forget this device"
          description="Removes its settings and its key from this server. Set it up again below."
          control={
            <Button
              size="xs"
              variant="destructive"
              disabled={busy}
              onClick={() => setConfirm("forget")}
            >
              Forget
            </Button>
          }
        />
      </SettingsSection>

      <AlertDialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm === "reboot"
                ? `Restart ${id}?`
                : confirm === "rotate"
                  ? `New key for ${id}?`
                  : `Forget ${id}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === "reboot"
                ? "It stops listening while it restarts. In-house voice comes back on by itself."
                : confirm === "rotate"
                  ? (rotateWarning ??
                    `It keeps working: the ${DEVICE} saves the new key and uses it from its next connection.`)
                  : "Its key, broker and tag settings are removed from this server. Nothing on the device changes."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => {
                const op = confirm;
                setConfirm(null);
                if (op === "rotate") {
                  const confirmed = rotateWarning !== null;
                  setRotateWarning(null);
                  void run("owner", "rotate", { id, confirmed }).then((v) => {
                    const r = v as { status?: string; line?: string } | null;
                    if (r?.status === "confirm") {
                      setRotateWarning(r.line ?? "");
                      setConfirm("rotate");
                    }
                  });
                  return;
                }
                void (op === "reboot"
                  ? run("owner", "reboot", { id })
                  : run("act", "forget", { id }));
              }}
            >
              {confirm === "reboot" ? "Restart" : confirm === "rotate" ? "Rotate key" : "Forget"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

const ACTIONS = ["mute", "unmute", ...R1_MOODS.map((m) => `mood:${m}`), "scene"] as const;
const KIND_ICON = {
  headphones: HeadphonesIcon,
  headset: HeadsetIcon,
  speaker: SpeakerIcon,
  car: CarIcon,
  receiver: RadioReceiverIcon,
  other: BluetoothIcon,
} as const;

/** Shown only once the R1's firmware reports it can drive Bluetooth audio. */
function SpeakerSection({
  device: d,
  busy,
  run,
}: {
  readonly device: DeviceView;
  readonly busy: boolean;
  readonly run: Run;
}) {
  const id = d.id;
  const s = d.speaker!;
  const off = busy || d.online !== true;
  const linked = s.state === "connected" || s.state === "streaming";
  const labels = outputLabels(s);
  const SavedIcon = KIND_ICON[s.saved?.kind ?? "other"];
  return (
    <SettingsSection title={`Bluetooth audio · ${id}`}>
      <SettingsRow
        title={
          s.saved === null ? (
            "Bluetooth audio"
          ) : (
            <span className="inline-flex items-center gap-1.5">
              <SavedIcon aria-hidden className="size-4" />
              {btDeviceLabel(s.saved)}
              <span className="text-muted-foreground text-xs">{btKindNoun(s.saved.kind)}</span>
            </span>
          )
        }
        description={speakerLine(s)}
        control={
          <span className="flex gap-1.5">
            {s.saved === null ? null : linked ? (
              <Button
                size="xs"
                variant="outline"
                disabled={off}
                onClick={() => void run("act", "speaker", { id, action: "disconnect" })}
              >
                Disconnect
              </Button>
            ) : (
              <Button
                size="xs"
                disabled={off || s.state === "connecting"}
                onClick={() => void run("act", "speaker", { id, action: "connect" })}
              >
                Connect
              </Button>
            )}
            {s.saved === null ? null : (
              <Button
                size="xs"
                variant="outline"
                disabled={off}
                onClick={() => void run("act", "speaker", { id, action: "forget" })}
              >
                Forget
              </Button>
            )}
          </span>
        }
      />
      <SettingsRow
        title="Replies play on"
        control={
          <Select
            value={s.output}
            disabled={off}
            onValueChange={(output) => void run("act", "speaker", { id, action: "route", output })}
          >
            <SelectTrigger size="sm">
              <SelectValue>{labels[s.output]}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="auto">{labels.auto}</SelectItem>
              <SelectItem value="bt">{labels.bt}</SelectItem>
              <SelectItem value="onboard">{labels.onboard}</SelectItem>
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        title="Pair a device"
        description={scanLine(s)}
        control={
          <Button
            size="xs"
            variant="outline"
            disabled={off || s.state === "scanning"}
            onClick={() => void run("act", "speaker", { id, action: "scan" })}
          >
            {s.state === "scanning" ? "Scanning…" : "Scan"}
          </Button>
        }
      >
        {s.found.length === 0 ? null : (
          <div className="flex flex-wrap gap-1.5 pt-2">
            {s.found.map((f) => (
              <Button
                key={f.mac}
                size="sm"
                variant={s.saved?.mac === f.mac ? "secondary" : "outline"}
                disabled={off}
                onClick={() => void run("act", "speaker", { id, action: "pair", mac: f.mac })}
              >
                {btDeviceLabel(f)}
                {f.audio ? ` · ${btKindNoun(f.kind)}` : " (not audio)"}
              </Button>
            ))}
          </div>
        )}
      </SettingsRow>
    </SettingsSection>
  );
}

const choiceLabel = (a: string) =>
  a === "scene"
    ? "Run a scene"
    : a.startsWith("mood:")
      ? `Eyes: ${a.slice(5)}`
      : a === "mute"
        ? "Mute"
        : "Unmute";
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
}: {
  readonly device: DeviceView;
  readonly tags: DevicesOverview["tags"];
  readonly busy: boolean;
  readonly run: Run;
}) {
  const [label, setLabel] = useState("");
  const [choice, setChoice] = useState<string>("mute");
  const [scene, setScene] = useState("");
  const uid = d.lastTag?.uid ?? null;
  const action = actionOf(choice, scene);
  return (
    <SettingsSection {...searchableSetting("hardware-nfc")}>
      <SettingsRow
        title="Assign a tag"
        description={
          uid === null || d.lastTag === null
            ? `Tap a tag on the ${DEVICE}, then give it a name and what it does.`
            : `Last tapped: ${uid} at ${clock(d.lastTag.at)}.`
        }
      >
        <div className="flex flex-wrap gap-2 pt-2">
          <Input
            value={label}
            placeholder="Desk dock"
            maxLength={60}
            onChange={(e) => setLabel(e.target.value)}
          />
          <Select value={choice} onValueChange={(next) => setChoice(String(next))}>
            <SelectTrigger size="sm">
              <SelectValue>{choiceLabel(choice)}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {ACTIONS.map((a) => (
                <SelectItem key={a} value={a}>
                  {choiceLabel(a)}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          {choice === "scene" ? (
            <Input
              value={scene}
              placeholder="scene.desk_mode"
              onChange={(e) => setScene(e.target.value)}
            />
          ) : null}
          <Button
            size="xs"
            disabled={busy || uid === null || label.trim() === "" || action === null}
            onClick={() =>
              void run(
                "act",
                "nfcAssign",
                { uid, label: label.trim(), action },
                () => `Tag ${label.trim()} saved.`,
              ).then((v) => {
                if (v !== null) setLabel("");
              })
            }
          >
            Assign
          </Button>
        </div>
      </SettingsRow>
      {tags.map((t) => (
        <SettingsRow
          key={t.uid}
          title={t.label}
          description={`${t.uid} · ${tagActionLine(t.action)}`}
          control={
            <Button
              size="xs"
              variant="outline"
              disabled={busy}
              onClick={() => void run("act", "nfcRemove", { uid: t.uid }, () => "Removed.")}
            >
              Remove
            </Button>
          }
        />
      ))}
    </SettingsSection>
  );
}

const detailOf = (b: R1KeyBinding | undefined) =>
  b?.kind === "prompt" ? b.text : b?.kind === "home" ? b.entityId : "";
const PRESSES = ["tap", "double", "hold", "long"] as const;

/** The R1's buttons: the firmware's fixed presses read-only, the rest set to its own action or one of hers. */
function KeysSection({
  device: d,
  busy,
  run,
  environmentId,
}: {
  readonly device: DeviceView;
  readonly busy: boolean;
  readonly run: Run;
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
  const listPersonas = useAtomCommand(batonWorkSessions.personasList, { reportFailure: false });
  const [personas, setPersonas] = useState<ReadonlyArray<string> | undefined>(undefined);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads her server's personas once per environment
  useEffect(() => {
    void listPersonas({ environmentId, input: {} }).then((r) => {
      if (r._tag === "Success") setPersonas(r.value.personas.map((p) => p.name));
    });
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- one read per environment; the command is stable
  }, [environmentId]);
  const choices = keyChoices(slot, personas);
  const threads = useVisibleThreadShells(picked.startsWith("thread:"))
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
    <SettingsSection title={`Buttons · ${d.id}`}>
      <SettingsRow
        title="Button map"
        description={
          d.keyNote ??
          `Grey presses are the ${DEVICE}'s own. A Tessaya action runs only where the ${DEVICE} itself does nothing.`
        }
      >
        <div className="overflow-x-auto pt-2">
          <table className="w-full text-left text-xs">
            <thead className="text-muted-foreground">
              <tr>
                <th className="py-1 pr-3 font-medium" />
                {PRESSES.map((p) => (
                  <th key={p} className="py-1 pr-3 font-medium capitalize">
                    {p}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(["s1", "s2", "s3"] as const).map((key) => (
                <tr key={key} className="border-t">
                  <th className="py-1.5 pr-3 font-medium">{key.toUpperCase()}</th>
                  {PRESSES.map((p) => {
                    const row = KEY_ROWS.find((r) => r.slot === `${key}.${p}`)!;
                    const b = d.keys[row.slot];
                    return (
                      <td
                        key={p}
                        className={
                          row.fixed === null ? "py-1.5 pr-3" : "py-1.5 pr-3 text-muted-foreground"
                        }
                      >
                        {row.fixed ?? (b === undefined ? "" : keyBindingLine(b))}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SettingsRow>
      <SettingsRow
        title="Change a button"
        description={
          canEdit
            ? `Pick a press and what it does. Saved on the ${DEVICE} and on this server.`
            : "This connection can look but not change the buttons."
        }
      >
        <div className="flex flex-wrap gap-2 pt-2">
          <Select
            value={slot}
            onValueChange={(next) => {
              const s = next as R1KeySlot;
              setSlot(s);
              setChoice(null);
              setText(detailOf(d.keys[s]));
              setThreadId(null);
            }}
          >
            <SelectTrigger size="sm" aria-label="Press">
              <SelectValue>{free.find((r) => r.slot === slot)?.title}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {free.map((r) => (
                <SelectItem key={r.slot} value={r.slot}>
                  {r.title}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          <Select value={picked} onValueChange={(next) => setChoice(String(next))}>
            <SelectTrigger size="sm" aria-label="What it does">
              <SelectValue>{choices.find(([v]) => v === picked)?.[1] ?? picked}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {choices.map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          {picked === "home" || picked === "prompt" ? (
            <Input
              value={text}
              aria-label={picked === "home" ? "Home Assistant entity" : "What to ask her"}
              placeholder={
                picked === "home" ? "light.desk_lamp or scene.evening" : "What's on today?"
              }
              maxLength={picked === "home" ? 200 : 400}
              onChange={(e) => setText(e.target.value)}
            />
          ) : null}
          {picked.startsWith("thread:") ? (
            <Select
              value={pickedThread?.id ?? ""}
              onValueChange={(next) => setThreadId(String(next))}
            >
              <SelectTrigger size="sm" aria-label="Thread">
                <SelectValue>{pickedThread?.title ?? "Pick a thread"}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {threads.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.title}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          ) : null}
          <Button
            size="xs"
            disabled={!canEdit || busy || d.online !== true || bind === null}
            onClick={() =>
              void run("act", "keyBind", { id: d.id, slot, bind }).then((v) => {
                if (v !== null) setChoice(null);
              })
            }
          >
            Save
          </Button>
        </div>
      </SettingsRow>
    </SettingsSection>
  );
}

function SetupSection({
  busy,
  configured,
  onSave,
  onShowBus,
}: {
  readonly busy: boolean;
  readonly configured: boolean;
  readonly onSave: (args: Record<string, string>) => Promise<void>;
  readonly onShowBus: () => Promise<unknown>;
}) {
  const [deviceId, setDeviceId] = useState("");
  const [mqttUrl, setMqttUrl] = useState("");
  const [mqttUser, setMqttUser] = useState("");
  const [mqttPass, setMqttPass] = useState("");
  const [deviceKey, setDeviceKey] = useState("");
  const [devicePass, setDevicePass] = useState("");
  return (
    <SettingsSection
      title={configured ? `Add a ${DEVICE}, or replace one by its id` : `Set up a ${DEVICE}`}
    >
      <SettingsRow
        title="Device and broker"
        description={`Its id (r1-…), its key to reach Tessaya (24 characters or more), and its MQTT broker: empty when the ${DEVICE} connects to this server itself. The key and passwords stay on the server.`}
      >
        <div className="flex flex-col gap-2 pt-2">
          <Input
            value={deviceId}
            placeholder="r1-3d57b3"
            onChange={(e) => setDeviceId(e.target.value)}
          />
          <Input
            value={mqttUrl}
            placeholder="Broker, e.g. mqtt://broker.local:1883 (empty: this server)"
            onChange={(e) => setMqttUrl(e.target.value)}
          />
          <Input
            value={mqttUser}
            placeholder="Broker user (optional)"
            onChange={(e) => setMqttUser(e.target.value)}
          />
          <SecretInput
            value={mqttPass}
            placeholder="Broker password (optional)"
            onChange={(e) => setMqttPass(e.target.value)}
          />
          <SecretInput
            configured={configured}
            value={deviceKey}
            onChange={(e) => setDeviceKey(e.target.value)}
          />
          {mqttUrl.trim() === "" ? (
            <SecretInput
              value={devicePass}
              placeholder={`The ${DEVICE}'s own MQTT password, if it is not the key (optional)`}
              onChange={(e) => setDevicePass(e.target.value)}
            />
          ) : null}
          <div>
            <Button
              size="xs"
              disabled={busy || deviceId.trim() === "" || deviceKey.trim().length < 24}
              onClick={() =>
                void onSave({
                  deviceKey: deviceKey.trim(),
                  deviceId: deviceId.trim(),
                  ...(mqttUrl.trim() === "" ? {} : { mqttUrl: mqttUrl.trim() }),
                  ...(mqttUser.trim() === "" ? {} : { mqttUser: mqttUser.trim() }),
                  ...(mqttPass === "" ? {} : { mqttPass }),
                  ...(mqttUrl.trim() !== "" || devicePass === "" ? {} : { devicePass }),
                }).then(() => {
                  setDeviceKey("");
                  setMqttPass("");
                  setDevicePass("");
                })
              }
            >
              Save
            </Button>
          </div>
        </div>
      </SettingsRow>
      <SettingsRow
        title="Room loop login"
        description={`What a voice loop or another server on a different machine logs in to this server's ${DEVICE} hub with.`}
        control={
          <Button size="xs" variant="outline" disabled={busy} onClick={() => void onShowBus()}>
            Show
          </Button>
        }
      />
    </SettingsSection>
  );
}

const ROOM_BRAIN_LABELS = {
  subscription: "Claude subscription",
  auto: "API key, subscription if it fails",
  api: "Anthropic API key",
} as const;
type RoomBrainWay = keyof typeof ROOM_BRAIN_LABELS;

/**
 * How her spoken turns reach Claude: the voice row of the brain's routing table (BRAIN-DESIGN §13). Choosing the key
 * also lets the key pay for talking; choosing the subscription takes that back. Applies from the next turn.
 */
function RoomBrainSection({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const voice = useEnvironmentSettings(
    environmentId,
    (settings) => settings.brainCredentials?.voice,
  );
  const keyRoles = useEnvironmentSettings(
    environmentId,
    (settings) => settings.brainKeyRoles?.anthropic,
  );
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const way: RoomBrainWay =
    voice === undefined || !voice.use.startsWith("apiKey:")
      ? "subscription"
      : voice.fallback === "subscription"
        ? "auto"
        : "api";
  const choose = (next: RoomBrainWay) => {
    const others = (keyRoles ?? ["cleanup"]).filter((role) => role !== "voice");
    updateSettings({
      brainCredentials: {
        voice:
          next === "subscription"
            ? { use: "subscription", fallback: "none" }
            : { use: "apiKey:anthropic", fallback: next === "auto" ? "subscription" : "none" },
      },
      brainKeyRoles: { anthropic: next === "subscription" ? others : [...others, "voice"] },
    });
  };
  return (
    <SettingsSection title="Room brain">
      <SettingsRow
        {...searchableSetting("room-brain")}
        title="Room brain"
        description="Her spoken turns run on your Claude subscription (Sonnet). Choose the API key (Settings → APIs) to have it pay for talking instead. Applies from the next thing you say."
        control={
          <Select
            value={way}
            onValueChange={(value) =>
              choose(value === "api" || value === "auto" ? value : "subscription")
            }
          >
            <SelectTrigger size="sm" aria-label="Room brain">
              <SelectValue>
                {(value: string | null) =>
                  ROOM_BRAIN_LABELS[(value ?? "subscription") as RoomBrainWay]
                }
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {(["subscription", "auto", "api"] as const).map((option) => (
                <SelectItem key={option} value={option}>
                  {ROOM_BRAIN_LABELS[option]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
    </SettingsSection>
  );
}

/** Items the R1's own rows above already set (volume, eyes, mute, screen turn, buttons). */
const HAND_BUILT: ReadonlySet<string> = new Set([
  "audio.volume",
  "eye.mood",
  "mic.mute",
  "display.rotate",
  "display.calibrate",
  "key.bind",
]);
const SAFETY_LABEL: Readonly<Record<DeviceSafety, string>> = {
  free: "Free",
  confirm: "Asks first",
  owner: "Needs your yes",
  never: "Settings only",
};

/**
 * Any device drawn from its own manifest: a block per group, live values, a control by type, and the safety class on
 * each. A new item needs no code here.
 */
function ManifestDevice({
  device: d,
  shown,
  busy,
  run,
}: {
  readonly device: RegisteredDevice;
  readonly shown: boolean;
  readonly busy: boolean;
  readonly run: Run;
}) {
  const values = new Map(d.values.map((v) => [v.itemId, v]));
  const live = new Set((d.live ?? []).map((l) => l.itemId));
  const off = busy || !d.online;
  const set = (itemId: string, value: unknown) =>
    void run("act", "set", { id: d.deviceId, itemId, value });
  const groups = groupItems(
    // The R1's own rows already set these two.
    d.items.filter((i) => !(shown && HAND_BUILT.has(i.id))),
    (i) => i,
  );
  const control = (item: DeviceItem) => {
    const access = accessOf(item);
    const v = values.get(item.id)?.value;
    if (!access.write || item.safety === "never") return null;
    // A setting the device has never reported is shown greyed, not guessed: its firmware may not do it yet.
    if (access.read && !values.has(item.id)) return null;
    if (item.type === "bool")
      return (
        <Switch
          checked={v === true}
          disabled={off}
          aria-label={item.label}
          onCheckedChange={(on) => set(item.id, on)}
        />
      );
    if (item.type === "enum" && item.values !== undefined && item.values.length > 0)
      return (
        <Select
          value={typeof v === "string" ? v : null}
          disabled={off}
          onValueChange={(next) => set(item.id, next)}
        >
          <SelectTrigger size="sm" aria-label={item.label}>
            <SelectValue>{typeof v === "string" ? v : "Choose"}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {item.values.map((x) => (
              <SelectItem key={x} value={x}>
                {x}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      );
    if (item.type === "number" && item.range !== undefined)
      return (
        <NumberField
          value={typeof v === "number" ? v : null}
          min={item.range[0]}
          max={item.range[1]}
          disabled={off}
          size="sm"
          className="w-24"
          onValueCommitted={(next) => {
            if (next !== null) set(item.id, next);
          }}
        >
          <NumberFieldGroup>
            <NumberFieldInput aria-label={item.label} />
          </NumberFieldGroup>
        </NumberField>
      );
    if (item.type === "action")
      return (
        <Button size="sm" variant="outline" disabled={off} onClick={() => set(item.id, true)}>
          {item.label}
        </Button>
      );
    return null;
  };
  return (
    <SettingsSection
      title={shown ? `Everything it reports · ${d.deviceId}` : `${d.name} (${d.kind})`}
    >
      {shown ? null : (
        <SettingsRow
          title={
            <span className="flex items-center gap-2">
              {d.name}
              <Badge variant={d.online ? "success" : "outline"}>
                {d.online ? "Online" : "Offline"}
              </Badge>
              {live.size > 0 ? <Badge variant="error">In use now</Badge> : null}
            </span>
          }
          description={[
            d.firmware,
            d.lastSeenAt === null ? null : `last heard ${clock(d.lastSeenAt)}`,
            d.items.length === 0 ? "it has not described itself yet" : null,
            d.stale === true ? "not heard from in over two weeks" : null,
          ]
            .filter((part) => part !== null)
            .join(" · ")}
          control={
            d.stale === true ? (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void run("act", "forget", { id: d.deviceId })}
              >
                Forget it
              </Button>
            ) : null
          }
        />
      )}
      {Object.entries(groups).map(([group, items]) =>
        items.map((item, at) => {
          const reported = values.get(item.id);
          const access = accessOf(item);
          const shown =
            access.read || access.event
              ? reported === undefined
                ? "Not reported yet."
                : `${valueText(item, reported.value)}, ${clock(reported.at)}.`
              : null;
          return (
            <SettingsRow
              key={item.id}
              className={
                (accessOf(item).read || accessOf(item).event) && !values.has(item.id)
                  ? "opacity-60"
                  : undefined
              }
              title={
                <span className="flex items-center gap-2">
                  {at === 0 ? (
                    <span className="text-muted-foreground capitalize">{group} ·</span>
                  ) : null}
                  {item.label}
                  {item.safety === "free" ? null : (
                    <Badge variant="outline">{SAFETY_LABEL[item.safety]}</Badge>
                  )}
                  {item.privacy === true ? (
                    <Badge variant={live.has(item.id) ? "error" : "warning"}>
                      {live.has(item.id) ? "Private, in use" : "Private"}
                    </Badge>
                  ) : null}
                </span>
              }
              description={[item.description, shown].filter((x) => x != null).join(". ")}
              control={control(item)}
            />
          );
        }),
      )}
    </SettingsSection>
  );
}
