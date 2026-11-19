/**
 * Settings → Voice: every voice this environment can speak in, with a preview line, and each persona's voice. The list
 * and the previews come from the environment (`baton.voice.call`), so web, desktop, mobile and the R1 see the same
 * library; a persona's choice is written to its own pack file there.
 */
import {
  batonDesktopBridge,
  TONE_LABELS,
  type ToneLabel,
  type ToneTurn,
} from "@t3tools/tessaya-contracts";
import type {
  TessayaVoiceCallResult,
  LibraryVoiceView,
  PersonaVoiceRow,
  VoiceClip,
  VoiceLibraryView,
} from "@t3tools/tessaya-contracts";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  becauseOf,
  DIAL_STEPS as STEPS,
  MOOD_DIALS as DIALS,
  moodTitle,
  opinionOf,
  stepOf,
  type PersonaMood,
} from "@t3tools/tessaya-shared/moodView";
import { LoaderIcon, PauseIcon, PlayIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
import { tessayaWorkSessions } from "../../state/tessayaWorkSessions";
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
import { PersonaRoster } from "./PersonaRosterSettings";
import { PersonaOpsAccess } from "./PersonaOpsSettings";
import { CastSection } from "./CastSettings";
import { placeLine } from "./PersonasPage.logic";
import { BlindCompare, UseItFor } from "./LabBenches";
import { VoicePlayground } from "./VoicePlayground";

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

/**
 * `voices`: the Playground and every voice to pick from (the Lab's Voices bench). `personas`: the Personas page, each
 * persona a card with its voice, body and mood, then where they all are (Cast) and their inner state.
 */
export function VoiceLibrarySections({
  page = "voices",
  environmentId,
}: {
  readonly page?: "voices" | "personas" | "compare";
  /** Her pages pass her environment; inside a settings scope it comes from the scope. */
  readonly environmentId?: EnvironmentId;
}) {
  const environment = useOptionalSettingsScope()?.environment ?? null;
  const id =
    environmentId ??
    (environment?.connection.phase === "connected" ? environment.environmentId : null);
  if (id === null) return null;
  return <VoiceLibrary key={id} environmentId={id} page={page} />;
}

function VoiceLibrary({
  environmentId,
  page,
}: {
  readonly environmentId: EnvironmentId;
  readonly page: "voices" | "personas" | "compare";
}) {
  const cast = useEnvironmentQuery(tessayaWorkSessions.castQuery({ environmentId, input: {} }));
  const castCall = useAtomCommand(tessayaWorkSessions.castCall, { reportFailure: false });
  const voiceCall = useAtomCommand(tessayaWorkSessions.voiceCall, { reportFailure: false });
  const call = async (
    kind: "read" | "act" | "owner",
    op: string,
    args: Record<string, unknown> = {},
  ): Promise<TessayaVoiceCallResult> => {
    const result = await voiceCall({ environmentId, input: { kind, op, args } });
    return result._tag === "Success"
      ? result.value
      : { ok: false, error: "Couldn’t reach this environment. Try again." };
  };
  const [library, setLibrary] = useState<VoiceLibraryView | null>(null);
  const [note, setNote] = useState("");
  const [moods, setMoods] = useState<Readonly<Record<string, PersonaMood | null>>>({});
  const [openMoods, setOpenMoods] = useState<ReadonlySet<string>>(new Set());
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const readMoods = async (personas: ReadonlyArray<PersonaVoiceRow>) => {
    const read = await Promise.all(
      personas.map(async (p) => {
        // A member's session can't make owner calls: it reads its own row without the general why.
        const owner = await call("owner", "mood", { persona: p.id });
        const reply = owner.ok ? owner : await call("read", "mood", { persona: p.id });
        return [p.id, reply.ok ? (reply.value as PersonaMood | null) : null] as const;
      }),
    );
    setMoods(Object.fromEntries(read));
  };
  const refresh = async () => {
    const reply = await call("read", "library");
    if (reply.ok) {
      const next = reply.value as VoiceLibraryView;
      setLibrary(next);
      await readMoods(next.personas);
    } else setNote(reply.error ?? "The voice library could not be read.");
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

  const setPersona = async (
    persona: string,
    engine: "pocket" | "gemini" | "clone",
    voice: string | null,
  ) => {
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

  const voiceLists = (
    <>
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
  /** How a persona feels toward each person, and its dials: shown on its card when he opens them. */
  const moodDetails = (
    persona: { readonly id: string; readonly name: string },
    mood: PersonaMood,
  ) => (
    <>
      <SettingsRow
        title="What this is"
        description="A working state that shapes how they talk, shown only to the person it is about (you see everyone). It is not a claim of feelings."
      />
      {(mood.people ?? []).length === 0 ? (
        <SettingsRow
          title="Toward people"
          description="No feelings toward anyone yet; they grow as people talk to them."
        />
      ) : null}
      {mood.dials === undefined ? (
        <SettingsRow
          title="Dials"
          description="Shown only to the owner’s own signed-in app: this session can’t change them."
        />
      ) : null}
      {(mood.people ?? []).map((person) => (
        <SettingsRow
          key={person.member}
          title={moodTitle(`Toward ${person.name}`, person)}
          description={[becauseOf(person.why), opinionOf(person)].filter((s) => s !== "").join(" ")}
          control={
            mood.dials === undefined ? undefined : (
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  void call("owner", "moodReset", {
                    persona: persona.id,
                    member: person.member,
                  }).then(() => readMoods(library.personas))
                }
              >
                Reset
              </Button>
            )
          }
        />
      ))}
      {mood.dials === undefined ? null : (
        <FoldedSettingsSection
          id={`dials-${persona.id}`}
          title="Dials"
          summary="Every emotional trait, from warmth to jealousy. You can also say it: “make Freya a bit more playful”."
        >
          {DIALS.map(([dial, says]) => (
            <SettingsRow
              key={dial}
              title={dial}
              description={says}
              control={
                <Select
                  value={stepOf(mood.dials?.[dial] ?? 0)}
                  onValueChange={(value) => {
                    updateSettings({
                      tessayaMood: {
                        personas: { [persona.id]: { [dial]: Number(value) } },
                      },
                    });
                    setMoods((now) => ({
                      ...now,
                      [persona.id]: {
                        ...mood,
                        dials: { ...mood.dials, [dial]: Number(value) },
                      },
                    }));
                  }}
                >
                  <SelectTrigger size="sm" aria-label={`${persona.name}: ${dial}`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    {STEPS.map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              }
            />
          ))}
        </FoldedSettingsSection>
      )}
    </>
  );
  const bodies = cast.data?.bodies ?? [];
  if (page === "compare") return <BlindCompare library={library} call={call} />;
  if (page === "voices")
    return (
      <>
        <VoicePlayground library={library} call={call} onChanged={refresh} />
        <UseItFor library={library} bodies={bodies} call={call} onChanged={refresh} />
        {voiceLists}
      </>
    );
  return (
    <>
      <PersonaRoster
        environmentId={environmentId}
        clones={library.clones ?? []}
        onChanged={refresh}
        renderCard={(p) => {
          const persona = library.personas.find((x) => x.id === p.id);
          const mood = moods[p.id];
          return (
            <>
              {persona === undefined ? null : (
                <PersonaRow
                  title="Voice"
                  persona={persona}
                  library={library}
                  onPlay={(voice) => void play(voice)}
                  playing={playing}
                  onPick={(engine, voice) => void setPersona(persona.id, engine, voice)}
                />
              )}
              <SettingsRow
                title="Body and place"
                description={placeLine(p.id, bodies)}
                control={
                  bodies.length === 0 ? undefined : (
                    <Select
                      items={bodies.map((body) => ({ value: body.id, label: body.name }))}
                      value={null}
                      onValueChange={(body) => {
                        // the same act as "bring Freya to Tumble": called there to stay, until sent home
                        if (typeof body === "string")
                          void castCall({
                            environmentId,
                            input: { op: "call", body, persona: p.id, stay: true },
                          }).then((result) => {
                            setNote(
                              result._tag === "Success"
                                ? ""
                                : `${p.name} couldn’t move there. ${formatEnvironmentQueryError(result.cause)}`,
                            );
                            cast.refresh();
                          });
                      }}
                    >
                      <SelectTrigger
                        size="sm"
                        className="w-44"
                        aria-label={`Bring ${p.name} to a body`}
                      >
                        <SelectValue placeholder="Bring to…" />
                      </SelectTrigger>
                      <SelectPopup>
                        {bodies.map((body) => (
                          <SelectItem key={body.id} value={body.id}>
                            {body.name}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                  )
                }
              />
              {mood == null ? (
                <SettingsRow title="Mood" description="The mood could not be read." />
              ) : (
                <SettingsRow
                  title={moodTitle("Mood", mood)}
                  description={becauseOf(mood.why)}
                  control={
                    <div className="flex items-center gap-1.5">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void readMoods(library.personas)}
                      >
                        Check again
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        aria-expanded={openMoods.has(p.id)}
                        onClick={() =>
                          setOpenMoods((now) => {
                            const next = new Set(now);
                            if (!next.delete(p.id)) next.add(p.id);
                            return next;
                          })
                        }
                      >
                        {openMoods.has(p.id) ? "Hide feelings" : "Feelings and dials"}
                      </Button>
                    </div>
                  }
                />
              )}
              {mood != null && openMoods.has(p.id) ? moodDetails(p, mood) : null}
            </>
          );
        }}
      />
      {status === undefined ? null : (
        <SettingsSection title="Voices">
          <SettingsRow title="Couldn’t change that" status={status} />
        </SettingsSection>
      )}
      <CastSection environmentId={environmentId} />
      <PersonaOpsAccess environmentId={environmentId} />
      {batonDesktopBridge()?.tonePass === undefined ? null : (
        <SettingsSection id="voice-moods" title="Your tone">
          <FoldedSettingsSection
            id="voice-tone"
            title="Label my tone"
            summary="Your 40 newest recorded turns on this computer. Play one and tap how you were; this teaches Tessaya your voice's tone. The labels stay on this computer. You can also say “let’s label my tone”."
          >
            <TonePass />
          </FoldedSettingsSection>
        </SettingsSection>
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
  /** Inside the persona's own card the row is just its voice. */
  readonly title?: string;
  readonly library: VoiceLibraryView;
  readonly playing: string | null;
  readonly onPlay: (voice: LibraryVoiceView) => void;
  readonly onPick: (engine: "pocket" | "gemini" | "clone", voice: string | null) => void;
}) {
  const { persona, library } = props;
  const pocket = byEar(library.pocket);
  const speaks = pocket.find((v) => v.id === persona.speaks) ?? pocket[0];
  const cloud = library.cloud === null ? null : byEar(library.cloud);
  const clone = (library.clones ?? []).find((c) => c.id === persona.cloneVoice);
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
      title={props.title ?? (persona.lead ? `${persona.name} (lead)` : persona.name)}
      description={
        clone !== undefined
          ? `Speaks in your clone ${clone.name} where clones can be spoken; ${speaks?.name ?? persona.speaks} elsewhere.`
          : persona.cloudVoice !== null && cloud !== null
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
          {(library.clones ?? []).length === 0 ? null : (
            <Select
              items={[
                { value: NO_CLOUD, label: "No clone" },
                ...(library.clones ?? []).map((c) => ({ value: c.id, label: c.name })),
              ]}
              value={persona.cloneVoice ?? NO_CLOUD}
              onValueChange={(next) => {
                if (typeof next === "string")
                  props.onPick("clone", next === NO_CLOUD ? null : next);
              }}
            >
              <SelectTrigger
                size="sm"
                className="w-44"
                aria-label={`${persona.name}’s cloned voice`}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value={NO_CLOUD}>No clone</SelectItem>
                {(library.clones ?? []).map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          )}
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

const TONE_WORDS: Readonly<Record<ToneLabel, string>> = {
  fine: "Fine",
  tired: "Tired",
  frustrated: "Frustrated",
  stressed: "Stressed",
  upbeat: "Upbeat",
  unsure: "Don’t remember",
};

/** One tap per turn; the clips and the labels stay in the desktop's own history. */
function TonePass() {
  const bridge = batonDesktopBridge();
  const [turns, setTurns] = useState<ReadonlyArray<ToneTurn> | null>(null);
  const [note, setNote] = useState("");
  const clip = useRef<HTMLAudioElement | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the desktop's history when the fold opens, and stops a clip when it closes
  useEffect(() => {
    void bridge
      ?.tonePass?.()
      .then(setTurns)
      .catch(() => setNote("Your recordings could not be read."));
    return () => clip.current?.pause();
  }, [bridge]);
  const play = async (id: string) => {
    clip.current?.pause();
    const reply = await bridge?.toneTurn?.(id, "play");
    if (reply?.playback === undefined) return setNote(reply?.failed ?? "That could not be played.");
    setNote("");
    clip.current = new Audio(reply.playback);
    await clip.current.play().catch(() => setNote("That could not be played."));
  };
  const label = async (id: string, tone: ToneLabel) => {
    const was = turns?.find((t) => t.id === id)?.tone ?? null;
    const next = was === tone ? null : tone;
    setTurns((now) => now?.map((t) => (t.id === id ? { ...t, tone: next } : t)) ?? now);
    await bridge?.toneTurn?.(id, next);
  };
  if (turns === null) return <SettingsRow title={note || "Loading your recordings…"} />;
  if (turns.length === 0)
    return (
      <SettingsRow title="No recorded turns yet" description="Speak or dictate, then come back." />
    );
  const done = turns.filter((t) => t.tone !== null).length;
  return (
    <>
      <SettingsRow
        title={`${done} of ${turns.length} labelled`}
        status={note ? <span role="status">{note}</span> : undefined}
      />
      {turns.map((turn) => (
        <SettingsRow
          key={turn.id}
          title={turn.text.length > 120 ? `${turn.text.slice(0, 117)}…` : turn.text || "(no words)"}
          description={new Date(turn.at).toLocaleString()}
        >
          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              size="xs"
              variant="outline"
              aria-label="Play"
              onClick={() => void play(turn.id)}
            >
              <PlayIcon />
            </Button>
            {TONE_LABELS.map((tone) => (
              <Button
                key={tone}
                size="xs"
                variant={turn.tone === tone ? "default" : "outline"}
                aria-pressed={turn.tone === tone}
                onClick={() => void label(turn.id, tone)}
              >
                {TONE_WORDS[tone]}
              </Button>
            ))}
          </div>
        </SettingsRow>
      ))}
    </>
  );
}
