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
} from "@t3tools/baton-contracts";
import {
  EYE_SCREENS,
  KEY_ROWS,
  MOOD_EYES,
  clock,
  deviceStatusLine,
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
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
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
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SecretInput } from "./SecretInput";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";

const REFRESH_MS = 5000;
type Kind = "read" | "act" | "owner";

export function HardwareSettingsPanel() {
  const { environment } = useSettingsScope();
  return (
    <SettingsPageContainer>
      {environment?.connection.phase === "connected" ? (
        <HardwareSections
          key={environment.environmentId}
          environmentId={environment.environmentId}
        />
      ) : (
        <p className="px-4 py-3 text-sm text-muted-foreground">
          Connect an environment to see its devices.
        </p>
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

function HardwareSections({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const quiet = { reportFailure: false } as const;
  const devicesCall = useAtomCommand(batonWorkSessions.devicesCall, quiet);
  const homeCall = useAtomCommand(batonWorkSessions.homeCall, quiet);
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
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- follows the server's live device status while open
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect, react/exhaustive-effect-dependencies -- first read, then every few seconds while the page is open; refresh closes over the environment
    void refresh();
    const timer = window.setInterval(() => void refresh(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [environmentId]);

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

  const devices = view?.devices ?? [];
  return (
    <>
      <SettingsSection {...searchableSetting("hardware-devices")}>
        <SettingsRow
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
            description={deviceStatusLine(d)}
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

      <RoomBrainSection environmentId={environmentId} />

      <SetupSection
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
  const [confirm, setConfirm] = useState<"reboot" | "forget" | null>(null);
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
          description="Needs new firmware: the R1 has no volume command yet. It comes with the firmware work."
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
              ? "Enrolling: speak to the device as it asks."
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
              alt="The R1's camera picture"
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
              {confirm === "reboot" ? `Restart ${id}?` : `Forget ${id}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === "reboot"
                ? "It stops listening while it restarts. In-house voice comes back on by itself."
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
                void (op === "reboot"
                  ? run("owner", "reboot", { id })
                  : run("act", "forget", { id }));
              }}
            >
              {confirm === "reboot" ? "Restart" : "Forget"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

const ACTIONS = ["mute", "unmute", ...R1_MOODS.map((m) => `mood:${m}`), "scene"] as const;
const OUTPUT_LABEL = { auto: "Speaker, else R1", bt: "Speaker only", onboard: "R1 only" } as const;

/** Shown only once the R1's firmware reports it can drive a Bluetooth speaker. */
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
  return (
    <SettingsSection title={`Bluetooth speaker · ${id}`}>
      <SettingsRow
        title={s.saved?.name ?? "Speaker"}
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
              <SelectValue>{OUTPUT_LABEL[s.output]}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="auto">{OUTPUT_LABEL.auto}</SelectItem>
              <SelectItem value="bt">{OUTPUT_LABEL.bt}</SelectItem>
              <SelectItem value="onboard">{OUTPUT_LABEL.onboard}</SelectItem>
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        title="Pair a speaker"
        description={
          s.scannedAt === null
            ? "Put the speaker in pairing mode, then scan."
            : `${s.found.length} found at ${clock(s.scannedAt)}. Pick one to pair.`
        }
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
                {f.name || f.mac}
                {f.audio ? null : " (not audio)"}
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
            ? "Tap a tag on the R1, then give it a name and what it does."
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
  const choices = keyChoices(slot);
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
          "Grey presses are the R1's own. A Tessaya action runs only where the R1 itself does nothing."
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
            ? "Pick a press and what it does. Saved on the R1 and on this server."
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
}: {
  readonly busy: boolean;
  readonly configured: boolean;
  readonly onSave: (args: Record<string, string>) => Promise<void>;
}) {
  const [deviceId, setDeviceId] = useState("");
  const [mqttUrl, setMqttUrl] = useState("");
  const [mqttUser, setMqttUser] = useState("");
  const [mqttPass, setMqttPass] = useState("");
  const [deviceKey, setDeviceKey] = useState("");
  return (
    <SettingsSection title={configured ? "Replace the R1's settings" : "Set up an R1"}>
      <SettingsRow
        title="Device and broker"
        description="Its id (r1-…), the MQTT broker it listens on, and the key it uses to reach Tessaya (24 characters or more). The key and password stay on the server."
      >
        <div className="flex flex-col gap-2 pt-2">
          <Input
            value={deviceId}
            placeholder="r1-3d57b3"
            onChange={(e) => setDeviceId(e.target.value)}
          />
          <Input
            value={mqttUrl}
            placeholder="mqtt://broker.local:1883"
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
          <div>
            <Button
              size="xs"
              disabled={
                busy ||
                deviceId.trim() === "" ||
                mqttUrl.trim() === "" ||
                deviceKey.trim().length < 24
              }
              onClick={() =>
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
            >
              Save
            </Button>
          </div>
        </div>
      </SettingsRow>
    </SettingsSection>
  );
}

const ROOM_BRAIN_LABELS = {
  auto: "Automatic",
  api: "Anthropic API key",
  subscription: "Claude subscription",
} as const;

/** How the R1's turns reach Claude; it applies from the next turn, with no restart. */
function RoomBrainSection({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const roomBrain = useEnvironmentSettings(environmentId, (settings) => settings.roomBrain);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  return (
    <SettingsSection title="Room brain">
      <SettingsRow
        {...searchableSetting("room-brain")}
        title="Room brain"
        description="Automatic uses your Anthropic key (Settings → APIs) for the quickest answers, and your Claude subscription if the key fails. Applies from the next thing you say."
        control={
          <Select
            value={roomBrain ?? "auto"}
            onValueChange={(value) =>
              updateSettings({
                roomBrain: value === "api" || value === "subscription" ? value : "auto",
              })
            }
          >
            <SelectTrigger size="sm" aria-label="Room brain">
              <SelectValue>
                {(value: string | null) =>
                  ROOM_BRAIN_LABELS[(value ?? "auto") as keyof typeof ROOM_BRAIN_LABELS]
                }
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {(["auto", "api", "subscription"] as const).map((way) => (
                <SelectItem key={way} value={way}>
                  {ROOM_BRAIN_LABELS[way]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
    </SettingsSection>
  );
}
