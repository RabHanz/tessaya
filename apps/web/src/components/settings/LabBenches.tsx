/**
 * Personas › Lab: what the Voices and Compare benches add to the voice library. "Use it for" gives a saved clone to
 * several personas at once (each speaks in it on every body it wears), with an Undo; Compare plays two voices as X
 * and Y, blind, and names them only after he picks. Both go through the environment's voice calls, like the Playground.
 */
import type {
  CastBody,
  TessayaVoiceCallResult,
  VoiceClip,
  VoiceLibraryView,
} from "@t3tools/tessaya-contracts";
import { PlayIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { cloneUses, undoUses, type CloneUse } from "./LabBenches.logic";
import { placeLine } from "./PersonasPage.logic";
import { SettingsRow, SettingsSection } from "./settingsLayout";

type Call = (
  kind: "read" | "act" | "owner",
  op: string,
  args?: Record<string, unknown>,
) => Promise<TessayaVoiceCallResult>;

const UNDO_MS = 30_000;

export function UseItFor(props: {
  readonly library: VoiceLibraryView;
  readonly bodies: ReadonlyArray<CastBody>;
  readonly call: Call;
  readonly onChanged: () => Promise<void>;
}) {
  const clones = props.library.clones ?? [];
  const [clone, setClone] = useState<string | null>(null);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [done, setDone] = useState<ReadonlyArray<CloneUse>>([]);
  const [note, setNote] = useState("");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the Undo offer runs out after 30 seconds
  useEffect(() => {
    if (done.length === 0) return;
    const t = setTimeout(() => setDone([]), UNDO_MS);
    return () => clearTimeout(t);
  }, [done]);
  if (clones.length === 0) return null;
  const chosen = clone ?? clones[0]!.id;
  const apply = async (uses: ReadonlyArray<CloneUse>) => {
    for (const u of uses) {
      const reply = await props.call("act", "setPersona", {
        persona: u.persona,
        engine: "clone",
        voice: u.after,
      });
      if (!reply.ok) return reply.error ?? "That was not saved.";
    }
    await props.onChanged();
    return null;
  };
  const name = (id: string) => props.library.personas.find((p) => p.id === id)?.name ?? id;
  return (
    <SettingsSection id="lab-use-it-for" title="Use it for">
      <SettingsRow
        title="Give a clone to personas"
        description="Each one speaks in it from the next sentence, on every body it wears: desktop, Tessels and phone. Or say “use my studio voice for Freya”."
        status={note ? <span role="status">{note}</span> : undefined}
        control={
          <Select
            items={clones.map((c) => ({ value: c.id, label: c.name }))}
            value={chosen}
            onValueChange={(next) => {
              if (typeof next === "string") setClone(next);
            }}
          >
            <SelectTrigger size="sm" className="w-44" aria-label="Which clone">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {clones.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      {props.library.personas.map((p) => (
        <SettingsRow
          key={p.id}
          title={p.cloneVoice === chosen ? `${p.name} · speaks in it now` : p.name}
          description={placeLine(p.id, props.bodies)}
          control={
            <Checkbox
              aria-label={`Use it for ${p.name}`}
              checked={picked.has(p.id)}
              onCheckedChange={(on) =>
                setPicked((now) => {
                  const next = new Set(now);
                  if (on === true) next.add(p.id);
                  else next.delete(p.id);
                  return next;
                })
              }
            />
          }
        />
      ))}
      <SettingsRow
        title={
          done.length === 0
            ? "Use now"
            : `${done.map((u) => name(u.persona)).join(", ")} speak in it now`
        }
        control={
          <div className="flex items-center gap-1.5">
            {done.length === 0 ? null : (
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  void apply(undoUses(done)).then((error) => {
                    setNote(error ?? "Undone: each speaks in its own voice again.");
                    setDone([]);
                  })
                }
              >
                Undo
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              disabled={cloneUses(props.library.personas, chosen, picked).length === 0}
              onClick={() => {
                const uses = cloneUses(props.library.personas, chosen, picked);
                void apply(uses).then((error) => {
                  setNote(error ?? "");
                  if (error === null) {
                    setDone(uses);
                    setPicked(new Set());
                  }
                });
              }}
            >
              Use now
            </Button>
          </div>
        }
      />
    </SettingsSection>
  );
}

interface Option {
  readonly key: string;
  readonly engine: "pocket" | "gemini" | "clone";
  readonly id: string;
  readonly name: string;
}

/** Two voices said the same line as X and Y in a random order; the names show once he picks. */
export function BlindCompare(props: { readonly library: VoiceLibraryView; readonly call: Call }) {
  const options: ReadonlyArray<Option> = [
    ...(props.library.clones ?? []).map((c) => ({
      key: `clone:${c.id}`,
      engine: "clone" as const,
      id: c.id,
      name: `${c.name} (your clone)`,
    })),
    ...props.library.pocket.map((v) => ({
      key: `pocket:${v.id}`,
      engine: "pocket" as const,
      id: v.id,
      name: v.name,
    })),
    ...(props.library.cloud ?? []).map((v) => ({
      key: `gemini:${v.id}`,
      engine: "gemini" as const,
      id: v.id,
      name: `${v.name} (cloud)`,
    })),
  ];
  const [a, setA] = useState<string | null>(null);
  const [b, setB] = useState<string | null>(null);
  const [line, setLine] = useState(props.library.previewLine);
  const [pair, setPair] = useState<{ x: Option; y: Option; clips: [VoiceClip, VoiceClip] } | null>(
    null,
  );
  const [picked, setPicked] = useState<"x" | "y" | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const audio = useRef<HTMLAudioElement | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- stops a clip when the bench closes
  useEffect(() => () => audio.current?.pause(), []);
  const first = a ?? options[0]?.key ?? null;
  const second = b ?? options[1]?.key ?? null;
  const say = async (o: Option) => {
    const reply = await props.call(o.engine === "clone" ? "owner" : "act", "say", {
      engine: o.engine,
      voice: o.id,
      text: line,
    });
    if (!reply.ok) throw new Error(reply.error ?? `${o.name} could not be made.`);
    return reply.value as VoiceClip;
  };
  const make = async () => {
    const oa = options.find((o) => o.key === first);
    const ob = options.find((o) => o.key === second);
    if (oa === undefined || ob === undefined || oa.key === ob.key)
      return setNote("Pick two different voices.");
    setBusy(true);
    setNote("");
    try {
      const [ca, cb] = await Promise.all([say(oa), say(ob)]);
      // the order is a coin flip, so he can't tell which is which until he picks
      setPair(
        Math.random() < 0.5 ? { x: oa, y: ob, clips: [ca, cb] } : { x: ob, y: oa, clips: [cb, ca] },
      );
      setPicked(null);
    } catch (error) {
      setNote(error instanceof Error ? error.message : "That did not work.");
    }
    setBusy(false);
  };
  const play = (clip: VoiceClip) => {
    audio.current?.pause();
    audio.current = new Audio(`data:audio/wav;base64,${clip.base64}`);
    void audio.current.play().catch(() => setNote("This browser would not play the clip."));
  };
  const pick = (key: string, value: string | null, set: (v: string) => void, label: string) => (
    <Select
      items={options.map((o) => ({ value: o.key, label: o.name }))}
      value={value}
      onValueChange={(next) => {
        if (typeof next === "string") set(next);
      }}
    >
      <SelectTrigger size="sm" className="w-52" aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectPopup>
        {options.map((o) => (
          <SelectItem key={`${key}-${o.key}`} value={o.key}>
            {o.name}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
  return (
    <SettingsSection id="lab-compare" title="Compare">
      <SettingsRow
        title="Blind A/B"
        description="Two voices say the same line as X and Y, in a random order. Pick the one you prefer; their names show after."
        status={note ? <span role="status">{note}</span> : undefined}
        control={
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            {pick("a", first, setA, "First voice")}
            {pick("b", second, setB, "Second voice")}
          </div>
        }
      />
      <SettingsRow
        title="Line"
        control={
          <div className="flex items-center gap-1.5">
            <Input
              size="sm"
              className="w-72"
              value={line}
              maxLength={300}
              aria-label="Line to compare"
              onChange={(event) => setLine(event.target.value)}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={busy || line.trim() === ""}
              onClick={() => void make()}
            >
              {busy ? "Making…" : "Make X and Y"}
            </Button>
          </div>
        }
      />
      {pair === null
        ? null
        : (["x", "y"] as const).map((side, i) => (
            <SettingsRow
              key={side}
              title={
                picked === null
                  ? side.toUpperCase()
                  : `${side.toUpperCase()}: ${pair[side].name}${picked === side ? " · your pick" : ""}`
              }
              control={
                <div className="flex items-center gap-1.5">
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Play ${side.toUpperCase()}`}
                    onClick={() => play(pair.clips[i]!)}
                  >
                    <PlayIcon />
                    Play
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={picked !== null}
                    onClick={() => setPicked(side)}
                  >
                    {side.toUpperCase()} sounds better
                  </Button>
                </div>
              }
            />
          ))}
    </SettingsSection>
  );
}
