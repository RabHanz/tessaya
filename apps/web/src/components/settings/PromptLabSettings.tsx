/**
 * Settings → Brain → Prompt lab (B-030): each persona's live prompt, his named variants of it, a run of up to three
 * variants on up to three of his subscription's models side by side with scores, and making one live with a rollback.
 * The voice ("try my variant B on Sonnet") and `tessaya_prompt_lab` reach the same service.
 */
import { useAtomValue } from "@effect/atom-react";
import type {
  BatonPromptLabInput,
  BatonPromptLabResult,
  EnvironmentId,
} from "@t3tools/baton-contracts";
import { labSummary, LAB_MODELS } from "@t3tools/baton-shared/promptLab";
import { useEffect, useState } from "react";

import { batonWorkSessions } from "../../state/batonWorkSessions";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { SettingsRow, SettingsSection } from "./settingsLayout";

type Personas = NonNullable<BatonPromptLabResult["personas"]>;
type Cells = NonNullable<BatonPromptLabResult["cells"]>;

const MODEL_LABELS: Readonly<Record<string, string>> = {
  haiku: "Haiku",
  sonnet: "Sonnet",
  opus: "Opus",
};

export function PromptLab({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const allowed = useAtomValue(batonWorkSessions.promptLab.permissionAtom(environmentId));
  const lab = useAtomCommand(batonWorkSessions.promptLab, { reportFailure: false });
  const [personas, setPersonas] = useState<Personas>([]);
  const [pick, setPick] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [variants, setVariants] = useState<ReadonlyArray<string>>(["live"]);
  const [models, setModels] = useState<ReadonlyArray<string>>(["sonnet"]);
  const [message, setMessage] = useState("");
  const [cells, setCells] = useState<Cells>([]);
  const [line, setLine] = useState("");
  const [busy, setBusy] = useState(false);

  const send = async (input: BatonPromptLabInput) => {
    setBusy(true);
    const result = await lab({ environmentId, input });
    setBusy(false);
    if (result._tag !== "Success") {
      setLine("The lab could not be reached.");
      return null;
    }
    setLine(result.value.line);
    if (result.value.personas !== undefined) setPersonas(result.value.personas);
    return result.value;
  };
  const reload = () => send({ op: "list" });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the lab from her server once per environment
  useEffect(() => {
    if (!allowed) return;
    void lab({ environmentId, input: { op: "list" } }).then((r) => {
      if (r._tag === "Success") setPersonas(r.value.personas ?? []);
    });
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- one read per environment; the command is stable
  }, [environmentId, allowed]);

  if (!allowed) return null;
  const persona = personas.find((p) => p.id === pick) ?? personas[0];
  if (persona === undefined)
    return (
      <SettingsSection title="Prompt lab">
        <p className="px-4 text-sm text-muted-foreground">{line || "Loading the lab…"}</p>
      </SettingsSection>
    );
  const toggle = (list: ReadonlyArray<string>, item: string, on: boolean, max: number) =>
    on
      ? list.includes(item) || list.length >= max
        ? list
        : [...list, item]
      : list.filter((x) => x !== item);
  const after = async (input: BatonPromptLabInput) => {
    await send(input);
    await reload();
  };

  return (
    <SettingsSection title="Prompt lab">
      <p className="px-4 text-sm text-muted-foreground">
        Try a persona&apos;s prompt before it goes live: save variants, run them on your
        subscription&apos;s models over the standard scenarios or one message, and make the best one
        live. A rollback puts back what was live before.
      </p>
      <SettingsRow
        title="Persona"
        description={
          persona.mine
            ? "Its live prompt is your own file."
            : "Its live prompt is the shipped default."
        }
        control={
          <Select
            value={persona.id}
            onValueChange={(next) => {
              if (next === null) return;
              setPick(next);
              setVariants(["live"]);
              setCells([]);
            }}
          >
            <SelectTrigger size="sm" aria-label="Persona">
              <SelectValue>
                {(v: string | null) => personas.find((p) => p.id === v)?.name ?? v}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {personas.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <div className="flex flex-col gap-2 px-4 pb-3">
        <Textarea
          aria-label={`${persona.name}'s live prompt`}
          readOnly
          size="sm"
          rows={6}
          value={persona.live}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Input
            aria-label="Variant name"
            className="w-40"
            placeholder="variant name"
            value={name}
            onChange={(e) => setName(e.target.value.toLowerCase())}
          />
          <Button size="sm" variant="outline" onClick={() => setText(persona.live)}>
            Start from live
          </Button>
          {persona.variants.map((v) => (
            <Button
              key={v.name}
              size="sm"
              variant="ghost"
              onClick={() => {
                setName(v.name);
                setText(v.text);
              }}
            >
              Edit {v.name}
            </Button>
          ))}
        </div>
        <Textarea
          aria-label="Variant text"
          size="sm"
          rows={8}
          placeholder="Write a variant, or start from the live prompt."
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={busy || name === "" || text.trim() === ""}
            onClick={() => void after({ op: "save", persona: persona.id, variant: name, text })}
          >
            Save variant
          </Button>
          {persona.variants.some((v) => v.name === name) && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void after({ op: "promote", persona: persona.id, variant: name })}
            >
              Make {name} live
            </Button>
          )}
          {persona.previous && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void after({ op: "rollback", persona: persona.id })}
            >
              Roll back
            </Button>
          )}
        </div>
      </div>
      <SettingsRow
        title="Run"
        description="Up to three variants on up to three models. Leave the message empty to use the standard scenarios."
        control={
          <div className="flex flex-col gap-2 sm:w-80">
            <div className="flex flex-wrap gap-3">
              {["live", ...persona.variants.map((v) => v.name)].map((v) => (
                <label key={v} className="flex items-center gap-1.5 text-sm">
                  <Checkbox
                    checked={variants.includes(v)}
                    onCheckedChange={(on) => setVariants(toggle(variants, v, on === true, 3))}
                  />
                  {v}
                </label>
              ))}
            </div>
            <div className="flex flex-wrap gap-3">
              {LAB_MODELS.map((m) => (
                <label key={m} className="flex items-center gap-1.5 text-sm">
                  <Checkbox
                    checked={models.includes(m)}
                    onCheckedChange={(on) => setModels(toggle(models, m, on === true, 3))}
                  />
                  {MODEL_LABELS[m]}
                </label>
              ))}
            </div>
            <Input
              aria-label="A message to try instead"
              placeholder="A message to try (optional)"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
            />
            <Button
              size="sm"
              disabled={busy || variants.length === 0 || models.length === 0}
              onClick={async () => {
                const ran = await send({
                  op: "run",
                  persona: persona.id,
                  variants,
                  models,
                  ...(message.trim() === "" ? {} : { message }),
                });
                setCells(ran?.cells ?? []);
              }}
            >
              {busy ? "Running…" : "Run"}
            </Button>
          </div>
        }
      />
      {line !== "" && <p className="px-4 text-sm text-muted-foreground">{line}</p>}
      {cells.length > 0 && <Results cells={cells} />}
    </SettingsSection>
  );
}

function Results({ cells }: { readonly cells: Cells }) {
  const summary = labSummary(cells);
  const scenarios = cells[0]?.replies.map((r) => r.scenario) ?? [];
  return (
    <div className="overflow-x-auto px-4 pb-4">
      <table className="w-full min-w-max border-collapse text-left text-sm">
        <thead>
          <tr>
            <th className="p-2 font-medium text-muted-foreground">Scenario</th>
            {cells.map((c) => {
              const s = summary.find((x) => x.variant === c.variant && x.model === c.model)!;
              return (
                <th key={`${c.variant}/${c.model}`} className="p-2 font-medium">
                  {c.variant} on {MODEL_LABELS[c.model] ?? c.model}{" "}
                  <span className="text-muted-foreground">
                    {s.passed}/{s.of}
                  </span>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {scenarios.map((scenario) => (
            <tr key={scenario} className="border-t align-top">
              <td className="p-2 text-muted-foreground">{scenario}</td>
              {cells.map((c) => {
                const r = c.replies.find((x) => x.scenario === scenario);
                return (
                  <td key={`${c.variant}/${c.model}`} className="max-w-80 p-2">
                    <p>{r?.reply}</p>
                    <p className={r?.score.passed ? "text-muted-foreground" : "text-destructive"}>
                      {r?.score.passed ? "Pass" : r?.score.misses.join("; ")}
                    </p>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
