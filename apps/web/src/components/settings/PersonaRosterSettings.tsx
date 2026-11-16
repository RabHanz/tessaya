/**
 * Settings → Voice → Personas: hire a persona, change its dials, brief and brain, copy it, retire it to the bin and
 * restore it. Every change goes to the environment's one registry (`baton.personas.change`); she does the same by voice.
 */
import type {
  SavedCloneView,
  TessayaPersona,
  TessayaPersonaChangeInput,
  TessayaPersonaChangeResult,
  TessayaPersonaDraft,
} from "@t3tools/tessaya-contracts";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { tessayaWorkSessions } from "../../state/tessayaWorkSessions";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { FoldedSettingsSection } from "./FoldedSettingsSection";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const DIALS = [
  ["energy", "Energy"],
  ["warmth", "Warmth"],
  ["play", "Playfulness"],
  ["expr", "Expressiveness"],
  ["formal", "Formality"],
  ["sass", "Sass"],
] as const;
type Dial = (typeof DIALS)[number][0];

interface Form {
  readonly id: string | null;
  readonly name: string;
  readonly role: string;
  readonly about: string;
  readonly traits: Readonly<Partial<Record<Dial, number>>>;
  readonly model: string;
  readonly private: boolean;
}

const blank: Form = {
  id: null,
  name: "",
  role: "",
  about: "",
  traits: {},
  model: "",
  private: false,
};

export function PersonaRoster(props: {
  readonly environmentId: EnvironmentId;
  readonly clones: ReadonlyArray<SavedCloneView>;
  readonly onChanged: () => Promise<void>;
}) {
  const list = useAtomCommand(tessayaWorkSessions.personasList, { reportFailure: false });
  const change = useAtomCommand(tessayaWorkSessions.personaChange, { reportFailure: false });
  const [personas, setPersonas] = useState<ReadonlyArray<TessayaPersona>>([]);
  const [bin, setBin] = useState<TessayaPersonaChangeResult["bin"]>([]);
  const [form, setForm] = useState<Form | null>(null);
  const [note, setNote] = useState("");

  const ask = async (input: TessayaPersonaChangeInput): Promise<TessayaPersonaChangeResult> => {
    const result = await change({ environmentId: props.environmentId, input });
    const reply: TessayaPersonaChangeResult =
      result._tag === "Success"
        ? result.value
        : { ok: false, error: "Couldn’t reach this environment. Try again.", bin };
    setBin(reply.bin);
    setNote(reply.ok ? "" : (reply.error ?? "That was not saved."));
    return reply;
  };
  const read = async () => {
    const result = await list({ environmentId: props.environmentId, input: {} });
    if (result._tag === "Success") setPersonas(result.value.personas);
  };
  const send = async (input: TessayaPersonaChangeInput): Promise<boolean> => {
    const reply = await ask(input);
    if (reply.ok) await Promise.all([read(), props.onChanged()]);
    return reply.ok;
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the environment's roster and bin once per environment
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect, react/exhaustive-effect-dependencies -- one read per environment
    void Promise.all([read(), ask({ op: "bin" })]);
  }, [props.environmentId]);

  const save = async (f: Form) => {
    const draft: TessayaPersonaDraft = {
      name: f.name,
      role: f.role,
      ...(f.about.trim() === "" ? {} : { about: f.about }),
      traits: f.traits,
      model: f.model.trim() === "" ? null : f.model.trim(),
      private: f.private,
    };
    const ok = await send(
      f.id === null ? { op: "create", draft } : { op: "edit", id: f.id, draft },
    );
    if (ok) setForm(null);
  };

  const status = note ? <span role="status">{note}</span> : undefined;
  return (
    <SettingsSection id="voice-roster" title="Personas">
      <SettingsRow
        title="Your team"
        description="Make new personas, tune each one’s personality and brain, copy or retire them. You can also ask Tessaya: “make a new persona called Luna”, “make Freya warmer”, “retire Onyx”."
        status={status}
        control={
          <Button size="sm" variant="outline" onClick={() => setForm(blank)}>
            New persona
          </Button>
        }
      />
      {form === null ? null : (
        <PersonaForm
          form={form}
          onChange={setForm}
          onCancel={() => setForm(null)}
          onSave={() => void save(form)}
        />
      )}
      {personas.map((p) => (
        <SettingsRow
          key={p.id}
          title={`${p.name}${p.lead ? " (lead)" : ""}${p.private === true ? " · private" : ""}`}
          description={[
            p.role,
            p.brain === undefined ? null : `Thinks on ${p.brain.model}, ${p.brain.effort} effort.`,
            p.cloneVoice === undefined
              ? null
              : `Speaks in your clone ${props.clones.find((c) => c.id === p.cloneVoice)?.name ?? "(no longer saved)"}.`,
          ]
            .filter(Boolean)
            .join(" ")}
          control={
            <div className="flex items-center gap-1.5">
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  setForm({
                    id: p.id,
                    name: p.name,
                    role: p.role,
                    about: "",
                    traits: p.traits ?? {},
                    model: p.brain?.model ?? "",
                    private: p.private === true,
                  })
                }
              >
                Edit
              </Button>
              {p.lead ? null : (
                <>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void send({ op: "duplicate", id: p.id, name: `${p.name} copy` })}
                  >
                    Duplicate
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void send({ op: "retire", id: p.id })}
                  >
                    Retire
                  </Button>
                </>
              )}
            </div>
          }
        />
      ))}
      {bin.length === 0 ? null : (
        <FoldedSettingsSection id="voice-roster-bin" title="Bin" summary={`${bin.length} retired`}>
          {bin.map((p) => (
            <SettingsRow
              key={p.id}
              title={p.name}
              description="Retired: out of the team, with its memories and settings kept."
              control={
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void send({ op: "restore", id: p.id })}
                >
                  Restore
                </Button>
              }
            />
          ))}
        </FoldedSettingsSection>
      )}
    </SettingsSection>
  );
}

function PersonaForm(props: {
  readonly form: Form;
  readonly onChange: (form: Form) => void;
  readonly onCancel: () => void;
  readonly onSave: () => void;
}) {
  const { form, onChange } = props;
  return (
    <div className="flex flex-col gap-2 px-3 py-2.5 sm:px-4">
      <Input
        aria-label="Name"
        placeholder="Name"
        maxLength={40}
        value={form.name}
        onChange={(e) => onChange({ ...form, name: e.target.value })}
      />
      <Input
        aria-label="Who they are, in one line"
        placeholder="Who they are, in one line"
        maxLength={200}
        value={form.role}
        onChange={(e) => onChange({ ...form, role: e.target.value })}
      />
      <Textarea
        aria-label="Personality, backstory and how they relate to you"
        placeholder={
          form.id === null
            ? "Personality, backstory and how they relate to you"
            : "Leave empty to keep the current description"
        }
        maxLength={4000}
        rows={4}
        value={form.about}
        onChange={(e) => onChange({ ...form, about: e.target.value })}
      />
      {DIALS.map(([dial, label]) => (
        <label key={dial} className="flex items-center gap-3 text-sm">
          <span className="w-32 text-muted-foreground">{label}</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            className="flex-1"
            value={form.traits[dial] ?? 0.5}
            onChange={(e) =>
              onChange({ ...form, traits: { ...form.traits, [dial]: Number(e.target.value) } })
            }
          />
          <span className="w-10 text-right tabular-nums">
            {(form.traits[dial] ?? 0.5).toFixed(2)}
          </span>
        </label>
      ))}
      <Input
        aria-label="Brain model"
        placeholder="Brain model, any provider (empty for the default)"
        maxLength={60}
        value={form.model}
        onChange={(e) => onChange({ ...form, model: e.target.value })}
      />
      <label className="flex items-center gap-2 text-sm">
        <Switch
          checked={form.private}
          onCheckedChange={(on) => onChange({ ...form, private: on })}
        />
        Private: only you, verified, can reach this persona and its memories
      </label>
      <div className="flex justify-end gap-1.5">
        <Button size="sm" variant="ghost" onClick={props.onCancel}>
          Cancel
        </Button>
        <Button size="sm" disabled={form.name.trim() === ""} onClick={props.onSave}>
          {form.id === null ? "Create" : "Save"}
        </Button>
      </div>
    </div>
  );
}
