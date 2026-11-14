/**
 * Settings → Voice: every voice this environment can speak in, with a preview line, and each persona's voice. The list
 * and the previews come from the environment (`baton.voice.call`), so web, desktop, mobile and the R1 see the same
 * library; a persona's choice is written to its own pack file there.
 */
import type {
  BatonVoiceCallResult,
  LibraryVoiceView,
  PersonaVoiceRow,
  VoiceClip,
  VoiceLibraryView,
} from "@t3tools/tessaya-contracts";
import type { EnvironmentId } from "@t3tools/contracts";
import { LoaderIcon, PauseIcon, PlayIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { batonWorkSessions } from "../../state/batonWorkSessions";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { FoldedSettingsSection } from "./FoldedSettingsSection";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useOptionalSettingsScope } from "./SettingsScopeContext";

const NO_CLOUD = "none";
const voiceKey = (voice: Pick<LibraryVoiceView, "engine" | "id">) => `${voice.engine}:${voice.id}`;
const hint = (voice: LibraryVoiceView) =>
  [voice.gender === "female" ? "Female" : "Male", `${voice.pitch} pitch`, voice.accent]
    .filter(Boolean)
    .join(" · ");

/** Women first, then men; low to high within each. */
const ORDER = { low: 0, medium: 1, high: 2 } as const;
const byEar = (voices: ReadonlyArray<LibraryVoiceView>) =>
  voices.toSorted((a, b) =>
    a.gender === b.gender
      ? ORDER[a.pitch] - ORDER[b.pitch] || a.name.localeCompare(b.name)
      : a.gender === "female"
        ? -1
        : 1,
  );

export function VoiceLibrarySections() {
  const environment = useOptionalSettingsScope()?.environment ?? null;
  if (environment?.connection.phase !== "connected") return null;
  return <VoiceLibrary key={environment.environmentId} environmentId={environment.environmentId} />;
}

function VoiceLibrary({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const voiceCall = useAtomCommand(batonWorkSessions.voiceCall, { reportFailure: false });
  const call = async (
    kind: "read" | "act",
    op: string,
    args: Record<string, unknown> = {},
  ): Promise<BatonVoiceCallResult> => {
    const result = await voiceCall({ environmentId, input: { kind, op, args } });
    return result._tag === "Success"
      ? result.value
      : { ok: false, error: "Couldn’t reach this environment. Try again." };
  };
  const [library, setLibrary] = useState<VoiceLibraryView | null>(null);
  const [note, setNote] = useState("");
  const refresh = async () => {
    const reply = await call("read", "library");
    if (reply.ok) setLibrary(reply.value as VoiceLibraryView);
    else setNote(reply.error ?? "The voice library could not be read.");
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the environment's voice library once per environment
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect, react/exhaustive-effect-dependencies -- one read per environment; refresh closes over it
    void refresh();
  }, [environmentId]);

  // A clip is fetched once and kept for the visit; one plays at a time.
  const audio = useRef<HTMLAudioElement | null>(null);
  const clips = useRef(new Map<string, HTMLAudioElement>());
  const [playing, setPlaying] = useState<string | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- stops the preview when the page closes
  useEffect(() => () => audio.current?.pause(), []);
  const play = async (voice: Pick<LibraryVoiceView, "engine" | "id" | "name">) => {
    const key = voiceKey(voice);
    audio.current?.pause();
    setPlaying(null);
    if (playing === key) return;
    let clip = clips.current.get(key);
    if (clip === undefined) {
      setLoading(key);
      const reply = await call("read", "preview", { engine: voice.engine, voice: voice.id });
      setLoading(null);
      if (!reply.ok) {
        setNote(reply.error ?? `${voice.name} could not be played.`);
        return;
      }
      const made = new Audio(`data:audio/wav;base64,${(reply.value as VoiceClip).base64}`);
      made.addEventListener("ended", () => setPlaying((now) => (now === key ? null : now)));
      clips.current.set(key, made);
      clip = made;
    }
    audio.current = clip;
    setNote("");
    setPlaying(key);
    clip.currentTime = 0;
    await clip.play().catch(() => setPlaying(null));
  };

  const setPersona = async (persona: string, engine: "pocket" | "gemini", voice: string | null) => {
    const reply = await call("act", "setPersona", { persona, engine, voice });
    setNote(reply.ok ? "" : (reply.error ?? "That was not saved."));
    if (reply.ok) await refresh();
  };

  if (library === null) {
    return (
      <SettingsSection id="voice-library" title="Voices">
        <p className="px-4 py-3 text-sm text-muted-foreground">{note || "Loading voices…"}</p>
      </SettingsSection>
    );
  }
  const status = note ? <span role="status">{note}</span> : undefined;
  const preview = (voice: LibraryVoiceView, can: boolean) => (
    <PreviewButton
      voice={voice}
      state={
        loading === voiceKey(voice) ? "loading" : playing === voiceKey(voice) ? "playing" : "idle"
      }
      disabled={!can}
      onPlay={() => void play(voice)}
    />
  );
  const row = (voice: LibraryVoiceView, can: boolean) => (
    <SettingsRow
      key={voiceKey(voice)}
      title={
        <span className="flex flex-wrap items-center gap-1.5">
          {voice.name}
          <Badge variant={voice.personalUse ? "warning" : "outline"} size="sm">
            {voice.licenceLabel}
          </Badge>
        </span>
      }
      description={hint(voice)}
      control={preview(voice, can)}
    />
  );

  return (
    <>
      <SettingsSection id="voice-personas" title="Persona voices">
        <SettingsRow
          title="Who speaks in which voice"
          description={`Each persona’s voice on the desktop, the room device and the phone. Previews say: “${library.previewLine}”`}
          status={status}
        />
        {library.personas.map((persona) => (
          <PersonaRow
            key={persona.id}
            persona={persona}
            library={library}
            onPlay={(voice) => void play(voice)}
            playing={playing}
            onPick={(engine, voice) => void setPersona(persona.id, engine, voice)}
          />
        ))}
      </SettingsSection>
      <SettingsSection id="voice-library" title="Voices on this machine">
        <SettingsRow
          title="Pocket voices"
          description={
            library.previews.pocket
              ? "Spoken on this machine. “Personal use” voices come from non-commercial or unlicensed recordings: fine for you, left out of a commercial build."
              : "Previews play once Tessaya’s own voice is installed on this machine (it downloads the first time she speaks)."
          }
        />
        {byEar(library.pocket).map((voice) => row(voice, library.previews.pocket))}
      </SettingsSection>
      {library.cloud === null ? null : (
        <FoldedSettingsSection
          id="voice-cloud"
          title="Cloud voices (Gemini)"
          summary={`${library.cloud.length} British voices, with your Google key`}
        >
          <p className="px-3 py-2.5 text-xs text-muted-foreground sm:px-4">
            Spoken by Google with the key in Settings → APIs. When Google cannot be reached, a
            persona speaks in its own Pocket voice.
          </p>
          {byEar(library.cloud).map((voice) => row(voice, library.previews.cloud))}
        </FoldedSettingsSection>
      )}
    </>
  );
}

function PreviewButton(props: {
  readonly voice: Pick<LibraryVoiceView, "name">;
  readonly state: "idle" | "loading" | "playing";
  readonly disabled: boolean;
  readonly onPlay: () => void;
}) {
  return (
    <Button
      size="icon-sm-pill"
      variant="ghost"
      aria-label={`${props.state === "playing" ? "Stop" : "Play"} ${props.voice.name}`}
      disabled={props.disabled || props.state === "loading"}
      onClick={props.onPlay}
    >
      {props.state === "loading" ? (
        <LoaderIcon className="animate-spin" />
      ) : props.state === "playing" ? (
        <PauseIcon />
      ) : (
        <PlayIcon />
      )}
    </Button>
  );
}

function PersonaRow(props: {
  readonly persona: PersonaVoiceRow;
  readonly library: VoiceLibraryView;
  readonly playing: string | null;
  readonly onPlay: (voice: LibraryVoiceView) => void;
  readonly onPick: (engine: "pocket" | "gemini", voice: string | null) => void;
}) {
  const { persona, library } = props;
  const pocket = byEar(library.pocket);
  const speaks = pocket.find((v) => v.id === persona.speaks) ?? pocket[0];
  const cloud = library.cloud === null ? null : byEar(library.cloud);
  const label = (v: LibraryVoiceView) => `${v.name}${v.personalUse ? " (personal use)" : ""}`;
  const groups = (voices: ReadonlyArray<LibraryVoiceView>) =>
    (["female", "male"] as const).map((gender) => (
      <SelectGroup key={gender}>
        <SelectGroupLabel>{gender === "female" ? "Women" : "Men"}</SelectGroupLabel>
        {voices
          .filter((v) => v.gender === gender)
          .map((v) => (
            <SelectItem key={v.id} value={v.id}>
              {label(v)}
            </SelectItem>
          ))}
      </SelectGroup>
    ));
  return (
    <SettingsRow
      title={persona.lead ? `${persona.name} (lead)` : persona.name}
      description={
        persona.cloudVoice !== null && cloud !== null
          ? `Speaks in ${cloud.find((v) => v.id === persona.cloudVoice)?.name ?? persona.cloudVoice}; ${speaks?.name ?? persona.speaks} when Google can’t be reached.`
          : `Speaks in ${speaks?.name ?? persona.speaks}.`
      }
      control={
        <div className="flex min-w-0 items-center justify-end gap-1.5">
          {speaks === undefined ? null : (
            <PreviewButton
              voice={speaks}
              state={props.playing === voiceKey(speaks) ? "playing" : "idle"}
              disabled={!library.previews.pocket}
              onPlay={() => props.onPlay(speaks)}
            />
          )}
          <Select
            items={pocket.map((v) => ({ value: v.id, label: label(v) }))}
            value={persona.speaks}
            onValueChange={(next) => {
              if (typeof next === "string") props.onPick("pocket", next);
            }}
          >
            <SelectTrigger size="sm" className="w-44" aria-label={`${persona.name}’s voice`}>
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>{groups(pocket)}</SelectPopup>
          </Select>
          {cloud === null ? null : (
            <Select
              items={[
                { value: NO_CLOUD, label: "No cloud voice" },
                ...cloud.map((v) => ({ value: v.id, label: v.name })),
              ]}
              value={persona.cloudVoice ?? NO_CLOUD}
              onValueChange={(next) => {
                if (typeof next === "string")
                  props.onPick("gemini", next === NO_CLOUD ? null : next);
              }}
            >
              <SelectTrigger
                size="sm"
                className="w-52"
                aria-label={`${persona.name}’s cloud voice`}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value={NO_CLOUD}>No cloud voice</SelectItem>
                {groups(cloud)}
              </SelectPopup>
            </Select>
          )}
        </div>
      }
    />
  );
}
