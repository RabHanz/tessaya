/**
 * Settings → Voice → Personas: hire a persona (by hand, from one sentence, or from a Character Card), change its dials,
 * brief, greetings and brain, export it as a card, copy it, retire it to the bin and restore it. Every change goes to the environment's one registry (`baton.personas.change`); she does the same by voice.
 */
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import type {
  SavedCloneView,
  TessayaPersona,
  TessayaPersonaChangeInput,
  TessayaPersonaChangeResult,
  TessayaPersonaDraft,
  TessayaPersonaGroup,
} from "@t3tools/tessaya-contracts";
import type { EnvironmentId } from "@t3tools/contracts";
import { colourOf } from "@t3tools/tessaya-shared/personaColour";
import { type ReactNode, useEffect, useState } from "react";

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
  /** "he/him", "she/her", "they/them". */
  readonly pronouns: string;
  readonly about: string;
  readonly traits: Readonly<Partial<Record<Dial, number>>>;
  readonly model: string;
  readonly private: boolean;
  /** How far a private persona comes into his private rooms. */
  readonly privateRooms: PrivateRoomsChoice;
  /** One greeting per line. */
  readonly greetings: string;
}

const blank: Form = {
  id: null,
  name: "",
  role: "",
  pronouns: "",
  about: "",
  traits: {},
  model: "",
  private: false,
  privateRooms: "open",
  greetings: "",
};

type PrivateRoomsChoice = "never" | "one-on-one" | "open";
const PRIVATE_ROOMS_LABELS: Readonly<Record<PrivateRoomsChoice, string>> = {
  open: "Private rooms: one-on-one and open rooms",
  "one-on-one": "Private rooms: only one-on-one with you",
  never: "Private rooms: never",
};

const formOfDraft = (d: TessayaPersonaDraft): Form => ({
  ...blank,
  name: d.name ?? "",
  role: d.role ?? "",
  pronouns: d.pronouns ?? "",
  about: d.about ?? "",
  traits: d.traits ?? {},
  greetings: (d.greetings ?? []).join("\n"),
});

const nameLine = (p: TessayaPersona) =>
  `${p.name}${p.lead ? " (lead)" : ""}${p.private === true ? " · private" : ""}${p.sealed === undefined ? "" : " · sealed in your private layer"}`;

/** A persona's face on its card: its initials on its own colour (the one its exported card wears). No image yet. */
function PersonaAvatar({ name }: { readonly name: string }) {
  const [r, g, b] = colourOf(name);
  const initials = name
    .split(/\s+/)
    .map((w) => w[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return (
    <span
      aria-hidden
      className="inline-flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-black/70"
      style={{ backgroundColor: `rgb(${r} ${g} ${b})` }}
    >
      {initials}
    </span>
  );
}

const download = (name: string, blob: Blob) => {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1_000);
};

export function PersonaRoster(props: {
  readonly environmentId: EnvironmentId;
  readonly clones: ReadonlyArray<SavedCloneView>;
  readonly onChanged: () => Promise<void>;
  /** The Personas page: each persona is its own card, with these rows (voice, body, mood) under its own. */
  readonly renderCard?: (persona: TessayaPersona) => ReactNode;
}) {
  const list = useAtomCommand(tessayaWorkSessions.personasList, { reportFailure: false });
  const change = useAtomCommand(tessayaWorkSessions.personaChange, { reportFailure: false });
  const [personas, setPersonas] = useState<ReadonlyArray<TessayaPersona>>([]);
  const [bin, setBin] = useState<TessayaPersonaChangeResult["bin"]>([]);
  const [form, setForm] = useState<Form | null>(null);
  const [note, setNote] = useState("");
  const [sentence, setSentence] = useState("");
  const [drafting, setDrafting] = useState(false);

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
    const greetings = f.greetings
      .split("\n")
      .map((g) => g.trim())
      .filter((g) => g !== "");
    const draft: TessayaPersonaDraft = {
      name: f.name,
      role: f.role,
      ...(f.pronouns.trim() === "" ? {} : { pronouns: f.pronouns.trim() }),
      ...(f.about.trim() === "" ? {} : { about: f.about }),
      traits: f.traits,
      model: f.model.trim() === "" ? null : f.model.trim(),
      private: f.private,
      ...(f.private ? { privateRooms: f.privateRooms } : {}),
      ...(f.id === null && greetings.length === 0 ? {} : { greetings }),
    };
    const ok = await send(
      f.id === null ? { op: "create", draft } : { op: "edit", id: f.id, draft },
    );
    if (ok) setForm(null);
  };

  const hire = async () => {
    setDrafting(true);
    const reply = await ask({ op: "hire", sentence: sentence.trim() });
    setDrafting(false);
    if (reply.draft === undefined) return;
    setSentence("");
    setForm(formOfDraft(reply.draft));
  };

  const importCard = async (file: File) => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const isJson = file.name.toLowerCase().endsWith(".json") || bytes[0] === 0x7b;
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    await send({ op: "import", card: isJson ? new TextDecoder().decode(bytes) : btoa(binary) });
  };

  const exportCard = async (id: string, kind: "png" | "json") => {
    const reply = await ask({ op: "export", id });
    if (reply.card === undefined) return;
    download(
      `${id}.card.${kind}`,
      kind === "json"
        ? new Blob([reply.card.json], { type: "application/json" })
        : new Blob([Uint8Array.from(atob(reply.card.png), (c) => c.charCodeAt(0))], {
            type: "image/png",
          }),
    );
  };

  const personaRow = (p: TessayaPersona, inCard = false) => (
    <SettingsRow
      key={p.id}
      title={inCard ? "Role and brain" : nameLine(p)}
      description={[
        p.pronouns === undefined ? null : `${p.pronouns}.`,
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
                pronouns: p.pronouns ?? "",
                about: "",
                traits: p.traits ?? {},
                model: p.brain?.model ?? "",
                private: p.private === true,
                privateRooms: p.privateRooms ?? "open",
                greetings: (p.greetings ?? []).join("\n"),
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
  );
  const status = note ? <span role="status">{note}</span> : undefined;
  const roster = (
    <SettingsSection id="voice-roster" title="Personas">
      <SettingsRow
        title="Your team"
        description="Make new personas, tune each one’s personality and brain, copy or retire them. You can also ask Tessaya: “make a new persona called Luna”, “make Freya warmer”, “retire Onyx”."
        status={status}
        control={
          <div className="flex items-center gap-1.5">
            <Button size="sm" variant="ghost" render={<label />}>
              Import card
              <input
                type="file"
                accept=".png,.json,image/png,application/json"
                className="sr-only"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file !== undefined) void importCard(file);
                }}
              />
            </Button>
            <Button size="sm" variant="outline" onClick={() => setForm(blank)}>
              New persona
            </Button>
          </div>
        }
      />
      <SettingsRow
        title="Hire from a sentence"
        description="Describe who you want; Tessaya drafts them for you to check before they join. Imports take Character Card PNG or JSON files from other apps. By voice: “hire me a cheerful cooking buddy”."
        control={
          <div className="flex items-center gap-1.5">
            <Input
              aria-label="Who to hire"
              placeholder="A grumpy Scottish chef who rates my cooking"
              maxLength={600}
              value={sentence}
              onChange={(e) => setSentence(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && sentence.trim() !== "") void hire();
              }}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={drafting || sentence.trim() === ""}
              onClick={() => void hire()}
            >
              {drafting ? "Drafting…" : "Draft"}
            </Button>
          </div>
        }
      />
      {form === null ? null : (
        <PersonaForm
          form={form}
          onChange={setForm}
          onCancel={() => setForm(null)}
          onSave={() => void save(form)}
          onExport={form.id === null ? undefined : (kind) => void exportCard(form.id!, kind)}
        />
      )}
      {props.renderCard === undefined ? personas.map((p) => personaRow(p)) : null}
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
      {props.renderCard === undefined ? <PersonaGroupRows personas={personas} ask={ask} /> : null}
    </SettingsSection>
  );
  if (props.renderCard === undefined) return roster;
  const card = props.renderCard;
  return (
    <>
      {roster}
      {personas.map((p) => (
        <SettingsSection
          key={p.id}
          id={`persona-${p.id}`}
          title={nameLine(p)}
          icon={<PersonaAvatar name={p.name} />}
        >
          {personaRow(p, true)}
          {card(p)}
        </SettingsSection>
      ))}
    </>
  );
}

/** Personas › Groups: talk to several at once, on its own page. */
export function PersonaGroupsSection({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const list = useAtomCommand(tessayaWorkSessions.personasList, { reportFailure: false });
  const change = useAtomCommand(tessayaWorkSessions.personaChange, { reportFailure: false });
  const [personas, setPersonas] = useState<ReadonlyArray<TessayaPersona>>([]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the environment's roster once per environment
  useEffect(() => {
    void list({ environmentId, input: {} }).then((r) => {
      if (r._tag === "Success") setPersonas(r.value.personas);
    });
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- one read per environment; the command is stable
  }, [environmentId]);
  const ask = async (input: TessayaPersonaChangeInput): Promise<TessayaPersonaChangeResult> => {
    const result = await change({ environmentId, input });
    return result._tag === "Success"
      ? result.value
      : { ok: false, error: "Couldn’t reach this environment. Try again.", bin: [] };
  };
  return (
    <SettingsSection id="persona-groups" title="Groups">
      <PersonaGroupRows personas={personas} ask={ask} open />
    </SettingsSection>
  );
}

/** His group (M-021): who is in it, who only listens, and whether they talk among themselves. */
function PersonaGroupRows(props: {
  readonly personas: ReadonlyArray<TessayaPersona>;
  readonly ask: (input: TessayaPersonaChangeInput) => Promise<TessayaPersonaChangeResult>;
  /** On its own page the rows show at once; inside the roster they fold. */
  readonly open?: boolean;
}) {
  const [group, setGroup] = useState<TessayaPersonaGroup | null>(null);
  // Picked before a group exists: it starts once two are in.
  const [picked, setPicked] = useState<ReadonlyArray<string>>([]);
  const [line, setLine] = useState("");
  const change = async (input: Extract<TessayaPersonaChangeInput, { op: "group" }>["change"]) => {
    const reply = await props.ask({ op: "group", change: input });
    if (reply.group !== undefined) setGroup(reply.group);
    if (input.op !== "status") setLine(reply.line ?? "");
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads his group once when the roster opens
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- the read's answer lands after it returns
    void change({ op: "status" });
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- one read on mount
  }, []);
  const member = (id: string) => group?.members.find((m) => m.id === id);
  const toggle = (id: string, on: boolean) => {
    if (group !== null)
      return void change(on ? { op: "add", personas: [id] } : { op: "leave", persona: id });
    const next = on ? [...picked, id] : picked.filter((p) => p !== id);
    setPicked(next);
    if (next.length >= 2) {
      setPicked([]);
      void change({ op: "start", personas: next });
    }
  };
  const rows = (
    <>
      <SettingsRow
        title="Talk to several at once"
        description="Pick two or more; each answers in its own voice. Say a name to ask one. By voice: “let me talk to Freya and Alfred together”, “let them talk”, “end the group”."
        status={line ? <span role="status">{line}</span> : undefined}
        control={
          group === null ? undefined : (
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Let them talk</span>
              <Switch
                aria-label="Let them talk among themselves"
                checked={group.mode === "watch"}
                onCheckedChange={(on) => void change({ op: "mode", mode: on ? "watch" : "answer" })}
              />
              <Button size="sm" variant="outline" onClick={() => void change({ op: "end" })}>
                End group
              </Button>
            </div>
          )
        }
      />
      {props.personas.map((p) => {
        const m = member(p.id);
        const inGroup = m !== undefined || picked.includes(p.id);
        return (
          <SettingsRow
            key={p.id}
            title={p.name}
            description={m?.silent === true ? "Listening; speaks when you name them." : p.role}
            control={
              <div className="flex items-center gap-2">
                {m === undefined ? null : (
                  <>
                    <span className="text-xs text-muted-foreground">Listen only</span>
                    <Switch
                      aria-label={`${p.name} listens only`}
                      checked={m.silent === true}
                      onCheckedChange={(on) =>
                        void change({ op: on ? "silent" : "speak", persona: p.id })
                      }
                    />
                  </>
                )}
                <Switch
                  aria-label={`${p.name} in the group`}
                  checked={inGroup}
                  onCheckedChange={(on) => toggle(p.id, on)}
                />
              </div>
            }
          />
        );
      })}
    </>
  );
  return props.open === true ? (
    rows
  ) : (
    <FoldedSettingsSection
      id="voice-roster-group"
      title="Group"
      summary={group === null ? "Off" : `${group.members.length} talking`}
    >
      {rows}
    </FoldedSettingsSection>
  );
}

function PersonaForm(props: {
  readonly form: Form;
  readonly onChange: (form: Form) => void;
  readonly onCancel: () => void;
  readonly onSave: () => void;
  readonly onExport: ((kind: "png" | "json") => void) | undefined;
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
      <Input
        aria-label="Pronouns"
        placeholder="Pronouns, like he/him, she/her or they/them"
        maxLength={26}
        value={form.pronouns}
        onChange={(e) => onChange({ ...form, pronouns: e.target.value })}
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
      <Textarea
        aria-label="Greetings, one per line"
        placeholder="Greetings, one per line: one is picked when you first wake them each day"
        rows={2}
        value={form.greetings}
        onChange={(e) => onChange({ ...form, greetings: e.target.value })}
      />
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
      {form.private ? (
        <Select
          value={form.privateRooms}
          onValueChange={(value) => {
            if (value !== null) onChange({ ...form, privateRooms: value as PrivateRoomsChoice });
          }}
        >
          <SelectTrigger aria-label="How far into private rooms" size="sm">
            <SelectValue>{PRIVATE_ROOMS_LABELS[form.privateRooms]}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {(Object.keys(PRIVATE_ROOMS_LABELS) as Array<PrivateRoomsChoice>).map((k) => (
              <SelectItem key={k} value={k}>
                {PRIVATE_ROOMS_LABELS[k]}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      ) : null}
      <div className="flex justify-end gap-1.5">
        {props.onExport === undefined ? null : (
          <>
            <Button size="sm" variant="ghost" onClick={() => props.onExport?.("png")}>
              Export card (PNG)
            </Button>
            <Button size="sm" variant="ghost" onClick={() => props.onExport?.("json")}>
              Export card (JSON)
            </Button>
          </>
        )}
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
