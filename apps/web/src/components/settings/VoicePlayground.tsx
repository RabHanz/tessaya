/**
 * Settings → Voices → Playground: any line in any voice this environment speaks (Pocket, Gemini, his saved clones), and
 * a clone made from a clip he records or uploads, on the environment's own machine. Every act is one `baton.voice.call`
 * op, so the Tessel, the phone and her tools reach the same service.
 */
import type {
  CloneResult,
  LibraryVoiceView,
  TessayaVoiceCallResult,
  VoiceClip,
  VoiceLibraryView,
} from "@t3tools/tessaya-contracts";
import { MicIcon, PlayIcon, SquareIcon, Trash2Icon, UploadIcon } from "lucide-react";
import { useRef, useState } from "react";

import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Textarea } from "../ui/textarea";
import { SecretInput } from "./SecretInput";
import { SettingsRow, SettingsSection } from "./settingsLayout";

type Engine = "pocket" | "gemini" | "clone";
type Call = (
  kind: "read" | "act" | "owner",
  op: string,
  args?: Record<string, unknown>,
) => Promise<TessayaVoiceCallResult>;
interface Choice {
  readonly value: string;
  readonly label: string;
  readonly group: string;
}

const RATE = 24_000;
const MAX_SECONDS = 30;

/** Any clip the browser can decode, as a 24 kHz mono 16-bit WAV in base64: what the server's clone check reads. */
const toWav = async (
  blob: Blob,
): Promise<{ readonly base64: string; readonly seconds: number }> => {
  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(await blob.arrayBuffer());
    const offline = new OfflineAudioContext(
      1,
      Math.max(1, Math.ceil(decoded.duration * RATE)),
      RATE,
    );
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    const mono = (await offline.startRendering()).getChannelData(0);
    const view = new DataView(new ArrayBuffer(44 + mono.length * 2));
    const put = (at: number, text: string) => {
      for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i));
    };
    put(0, "RIFF");
    view.setUint32(4, 36 + mono.length * 2, true);
    put(8, "WAVEfmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, RATE, true);
    view.setUint32(28, RATE * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    put(36, "data");
    view.setUint32(40, mono.length * 2, true);
    for (let i = 0; i < mono.length; i++)
      view.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, mono[i]!)) * 32_767), true);
    const bytes = new Uint8Array(view.buffer);
    let binary = "";
    for (let at = 0; at < bytes.length; at += 0x8000)
      binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
    return { base64: btoa(binary), seconds: decoded.duration };
  } finally {
    void context.close();
  }
};

const voices = (library: VoiceLibraryView, engine: Engine, test: CloneResult | null): Choice[] => {
  const listed = (list: ReadonlyArray<LibraryVoiceView>, group: string) =>
    list.map((v) => ({ value: v.id, label: v.name, group }));
  if (engine === "clone")
    return [
      ...(test === null
        ? []
        : [{ value: test.id, label: "Test voice (not saved)", group: "Test" }]),
      ...(library.clones ?? []).map((c) => ({ value: c.id, label: c.name, group: "Your clones" })),
    ];
  if (engine === "gemini")
    return [
      ...library.personas.flatMap((p) =>
        p.cloudVoice === null ? [] : [{ value: p.cloudVoice, label: p.name, group: "Personas" }],
      ),
      ...listed(library.cloud ?? [], "Gemini voices"),
    ];
  return [
    ...library.personas.map((p) => ({ value: p.speaks, label: p.name, group: "Personas" })),
    ...listed(library.pocket, "Pocket voices"),
  ];
};

export function VoicePlayground(props: {
  readonly library: VoiceLibraryView;
  readonly call: Call;
  readonly onChanged: () => Promise<void>;
}) {
  const { library, call } = props;
  const [engine, setEngine] = useState<Engine>("pocket");
  const [test, setTest] = useState<CloneResult | null>(null);
  const choices = voices(library, engine, test);
  const [picked, setPicked] = useState<string | null>(null);
  const voice = choices.some((c) => c.value === picked) ? picked : (choices[0]?.value ?? null);
  const [text, setText] = useState(library.previewLine);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const [clip, setClip] = useState<{ readonly base64: string; readonly seconds: number } | null>(
    null,
  );
  const [recorder, setRecorder] = useState<MediaRecorder | null>(null);
  const [consent, setConsent] = useState(false);
  const [name, setName] = useState("");
  const [token, setToken] = useState("");
  const upload = useRef<HTMLInputElement | null>(null);

  const play = (made: VoiceClip) => {
    audio.current?.pause();
    audio.current = new Audio(`data:audio/wav;base64,${made.base64}`);
    void audio.current.play().catch(() => setNote("This browser would not play the clip."));
  };
  const run = async (what: string, act: () => Promise<void>) => {
    setBusy(what);
    setNote("");
    await act().catch(() => setNote("That did not work. Try again."));
    setBusy(null);
  };
  const say = () =>
    run("say", async () => {
      if (voice === null) return;
      const reply = await call(engine === "clone" ? "owner" : "act", "say", {
        engine,
        voice,
        text,
      });
      if (reply.ok) play(reply.value as VoiceClip);
      else setNote(reply.error ?? "That voice could not say it.");
    });
  const takeClip = async (blob: Blob) => {
    const wav = await toWav(blob).catch(() => null);
    if (wav === null) setNote("That file is not audio this browser can read.");
    else if (wav.seconds > MAX_SECONDS) setNote(`Keep the clip under ${MAX_SECONDS} seconds.`);
    else {
      setClip(wav);
      setTest(null);
    }
  };
  const record = async () => {
    if (recorder !== null) {
      recorder.stop();
      return;
    }
    const stream = await navigator.mediaDevices
      ?.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false } })
      .catch(() => null);
    if (stream == null) {
      setNote("The microphone is not available here.");
      return;
    }
    const parts: Blob[] = [];
    const next = new MediaRecorder(stream);
    next.addEventListener("dataavailable", (event) => parts.push(event.data));
    next.addEventListener("stop", () => {
      clearTimeout(limit);
      for (const track of stream.getTracks()) track.stop();
      setRecorder(null);
      void takeClip(new Blob(parts, { type: next.mimeType }));
    });
    const limit = setTimeout(() => next.state === "recording" && next.stop(), MAX_SECONDS * 1_000);
    next.start();
    setRecorder(next);
    setNote("");
  };
  const clone = () =>
    run("clone", async () => {
      if (clip === null) return;
      if (token.trim() !== "") {
        const saved = await call("owner", "setHfToken", { token });
        if (!saved.ok) return setNote(saved.error ?? "The token was not saved.");
        setToken("");
      }
      const reply = await call("owner", "clone", { wav: clip.base64, consent });
      if (!reply.ok) return setNote(reply.error ?? "The voice could not be cloned.");
      const made = reply.value as CloneResult;
      setTest(made);
      setEngine("clone");
      setPicked(made.id);
      setNote(
        made.oneSpeaker === null
          ? "Cloned. This machine has no Voice ID model, so it could not check for a second voice."
          : "Cloned. Try it, then save it under a name.",
      );
      play(made.clip);
      await props.onChanged();
    });
  const save = () =>
    run("save", async () => {
      if (test === null) return;
      const reply = await call("owner", "saveClone", { id: test.id, name });
      if (!reply.ok) return setNote(reply.error ?? "The voice was not saved.");
      const saved = reply.value as { readonly id: string };
      setTest(null);
      setName("");
      setPicked(saved.id);
      await props.onChanged();
      setNote("Saved. It stays on this machine and is never synced.");
    });
  const remove = (id: string) =>
    run(`delete:${id}`, async () => {
      const reply = await call("owner", "deleteClone", { id });
      if (!reply.ok) return setNote(reply.error ?? "The voice was not deleted.");
      await props.onChanged();
    });

  const engines = [
    { value: "pocket", label: "Pocket (this machine)" },
    ...(library.cloud === null ? [] : [{ value: "gemini", label: "Gemini (cloud)" }]),
    { value: "clone", label: "Your clones" },
  ];
  const groups = [...new Set(choices.map((c) => c.group))];
  const cloning = library.cloning;
  return (
    <SettingsSection id="voice-playground" title="Voice Playground">
      <SettingsRow
        title="Hear any voice"
        description="Pick an engine and a voice, type anything, and play it."
        status={note ? <span role="status">{note}</span> : undefined}
        control={
          <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
            <Select
              items={engines}
              value={engine}
              onValueChange={(next) => {
                if (next === "pocket" || next === "gemini" || next === "clone") setEngine(next);
              }}
            >
              <SelectTrigger size="sm" className="w-44" aria-label="Engine">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {engines.map((e) => (
                  <SelectItem key={e.value} value={e.value}>
                    {e.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <Select
              items={choices.map((c) => ({ value: c.value, label: c.label }))}
              value={voice}
              onValueChange={(next) => {
                if (typeof next === "string") setPicked(next);
              }}
            >
              <SelectTrigger size="sm" className="w-48" aria-label="Voice">
                <SelectValue placeholder="No voices yet" />
              </SelectTrigger>
              <SelectPopup>
                {groups.map((group) => (
                  <SelectGroup key={group}>
                    <SelectGroupLabel>{group}</SelectGroupLabel>
                    {choices
                      .filter((c) => c.group === group)
                      .map((c) => (
                        <SelectItem key={`${group}:${c.value}`} value={c.value}>
                          {c.label}
                        </SelectItem>
                      ))}
                  </SelectGroup>
                ))}
              </SelectPopup>
            </Select>
          </div>
        }
      />
      <div className="flex items-start gap-2 px-3 pb-3 sm:px-4">
        <Textarea
          className="flex-1"
          size="sm"
          value={text}
          maxLength={600}
          aria-label="What to say"
          onChange={(event) => setText(event.target.value)}
        />
        <Button
          size="sm"
          disabled={voice === null || text.trim() === "" || busy !== null}
          onClick={() => void say()}
        >
          <PlayIcon />
          {busy === "say" ? "Making…" : "Play"}
        </Button>
      </div>
      <SettingsRow
        title="Clone a voice"
        description={
          cloning?.pocket === false
            ? "Cloning runs on this machine with Tessaya’s own voice, which downloads the first time she speaks."
            : "Record or upload 5 to 30 seconds of one person speaking, somewhere quiet. It runs on this machine; the recording itself is not kept."
        }
        control={
          <div className="flex items-center justify-end gap-1.5">
            <Button size="sm" variant="outline" onClick={() => void record()}>
              {recorder === null ? <MicIcon /> : <SquareIcon />}
              {recorder === null ? "Record" : "Stop"}
            </Button>
            <Button size="sm" variant="outline" onClick={() => upload.current?.click()}>
              <UploadIcon />
              Upload
            </Button>
            <input
              ref={upload}
              type="file"
              accept="audio/*"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file !== undefined) void takeClip(file);
              }}
            />
          </div>
        }
      />
      {clip === null ? null : (
        <div className="flex flex-col gap-2 px-3 pb-3 sm:px-4">
          <label className="flex items-center gap-1.5 text-sm">
            <Checkbox checked={consent} onCheckedChange={(on) => setConsent(on === true)} />
            This is my voice, or I have their permission to clone it.
          </label>
          {cloning?.weights === false ? (
            <SecretInput
              size="sm"
              value={token}
              placeholder="Hugging Face read token (once, for Kyutai’s cloning weights)"
              aria-label="Hugging Face read token"
              onChange={(event) => setToken(event.target.value)}
            />
          ) : null}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-muted-foreground">
              {clip.seconds.toFixed(1)} s clip ready
            </span>
            <Button size="sm" disabled={!consent || busy !== null} onClick={() => void clone()}>
              {busy === "clone" ? "Cloning…" : "Clone"}
            </Button>
            {test === null ? null : (
              <>
                <Button size="sm" variant="outline" onClick={() => play(test.clip)}>
                  <PlayIcon />
                  Try it
                </Button>
                <Input
                  size="sm"
                  className="w-40"
                  value={name}
                  maxLength={40}
                  placeholder="Name"
                  aria-label="Name for the voice"
                  onChange={(event) => setName(event.target.value)}
                />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={name.trim() === "" || busy !== null}
                  onClick={() => void save()}
                >
                  Save as
                </Button>
              </>
            )}
          </div>
        </div>
      )}
      {(library.clones ?? []).map((saved) => (
        <SettingsRow
          key={saved.id}
          title={saved.name}
          description="Your clone: on this machine only, marked synthetic. Withdrawing its consent in Brain → Always allowed silences it."
          control={
            <Button
              size="icon-sm-pill"
              variant="ghost"
              aria-label={`Delete ${saved.name}`}
              disabled={busy !== null}
              onClick={() => void remove(saved.id)}
            >
              <Trash2Icon />
            </Button>
          }
        />
      ))}
    </SettingsSection>
  );
}
