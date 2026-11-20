/**
 * Tessaya › Cast: one persona is one mind in many bodies. Who's where (live), each body's home and follow rule and who
 * stands beside it, and the personas themselves. Every change is also a voice phrase (`tessaya_cast`).
 */
import type { EnvironmentId } from "@t3tools/contracts";
import type { CastBody, CastCallInput, CastView } from "@t3tools/tessaya-contracts";
import { useState } from "react";

import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
import { tessayaWorkSessions } from "../../state/tessayaWorkSessions";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { SettingsRow, SettingsSection } from "./settingsLayout";

type Tab = "where" | "bodies";
const LEAD = "(default)";

const WHY: Record<CastBody["why"], string> = {
  visit: "called here for this conversation",
  stay: "called here to stay",
  follows: "following who you last talked to",
  home: "home",
  lead: "default",
};

function PersonaPick({
  label,
  value,
  personas,
  onChange,
}: {
  readonly label: string;
  readonly value: string | null;
  readonly personas: CastView["personas"];
  readonly onChange: (persona: string | null) => void;
}) {
  const names: Record<string, string> = Object.fromEntries([
    [LEAD, "Default"],
    ...personas.map((p) => [p.id, p.name]),
  ]);
  return (
    <Select
      value={value ?? LEAD}
      onValueChange={(next) => next !== null && onChange(next === LEAD ? null : next)}
    >
      <SelectTrigger size="sm" aria-label={label}>
        <SelectValue>{(v: string | null) => names[v ?? LEAD] ?? v}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        {[LEAD, ...personas.map((p) => p.id)].map((id) => (
          <SelectItem key={id} value={id}>
            {names[id]}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

export function CastSection({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const query = useEnvironmentQuery(tessayaWorkSessions.castQuery({ environmentId, input: {} }));
  const send = useAtomCommand(tessayaWorkSessions.castCall, { reportFailure: false });
  const [tab, setTab] = useState<Tab>("where");
  const [latest, setLatest] = useState<CastView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const view = latest ?? query.data;

  const act = async (input: CastCallInput) => {
    setError(null);
    const result = await send({ environmentId, input });
    if (result._tag === "Success") setLatest(result.value);
    else setError(formatEnvironmentQueryError(result.cause));
    query.refresh();
  };
  const name = (id: string | null) =>
    view?.personas.find((p) => p.id === id)?.name ?? id ?? "nobody";

  return (
    <>
      <SettingsSection title="Bodies and places">
        <SettingsRow
          title="One persona, many bodies"
          description={
            'A persona is one mind with one mood and memory, in every body it wears. Say "who\'s on Tumble?", "bring Alfred here", "make Tumble always Tessaya" or "send everyone home".'
          }
          control={
            <ToggleGroup
              aria-label="Cast view"
              variant="segmented"
              value={[tab]}
              onValueChange={(next) => {
                const v = next[0];
                if (v === "where" || v === "bodies") setTab(v);
              }}
            >
              <Toggle value="where">Who's where</Toggle>
              <Toggle value="bodies">Bodies</Toggle>
            </ToggleGroup>
          }
        />
        {error === null && query.error === null ? null : (
          <SettingsRow title="Couldn't change that" description={error ?? query.error ?? ""} />
        )}
      </SettingsSection>
      {view === null ? (
        <SettingsSection title={tab === "where" ? "Who's where" : "Bodies"}>
          <SettingsRow title={query.isPending ? "Loading…" : "No bodies yet"} />
        </SettingsSection>
      ) : tab === "where" ? (
        <SettingsSection title="Who's where">
          {view.bodies.map((b) => (
            <SettingsRow
              key={b.id}
              title={`${b.name}: ${b.on.map((p) => name(p)).join(", ") || "nobody"}`}
              description={[
                WHY[b.why],
                b.home === null ? null : `home ${name(b.home)}`,
                b.follows ? "follows" : null,
                b.online === false ? "offline" : null,
              ]
                .filter(Boolean)
                .join(" · ")}
              control={
                b.why === "visit" || b.why === "stay" ? (
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => act({ op: "sendHome", body: b.id })}
                  >
                    Send home
                  </Button>
                ) : undefined
              }
            />
          ))}
          {view.focus === undefined ? null : (
            <SettingsRow title="Her desk body" description={view.focus} />
          )}
          <SettingsRow
            title="Send everyone home"
            description="Every persona called to another body goes back to its home."
            control={
              <Button size="xs" variant="outline" onClick={() => act({ op: "sendHome" })}>
                Send everyone home
              </Button>
            }
          />
        </SettingsSection>
      ) : (
        view.bodies.map((b) => (
          <SettingsSection key={b.id} title={b.name}>
            <SettingsRow
              title="Home persona"
              description="Who it goes back to after a conversation."
              control={
                <PersonaPick
                  label={`${b.name} home persona`}
                  value={b.home}
                  personas={view.personas}
                  onChange={(persona) => act({ op: "home", body: b.id, persona })}
                />
              }
            />
            <SettingsRow
              title="Follows you"
              description="Changes to whoever you last talked to, on any body."
              control={
                <Switch
                  aria-label={`${b.name} follows`}
                  checked={b.follows}
                  onCheckedChange={(on) => act({ op: "follows", body: b.id, on })}
                />
              }
            />
            {b.kind === "desktop" && b.form !== undefined ? (
              <SettingsRow
                title="Form"
                description="Her cartoon or her full body on the desk. She is the same self, with the same mood, in either."
                control={
                  <span className="flex gap-1">
                    {(["cartoon", "human"] as const).map((form) => (
                      <Button
                        key={form}
                        size="xs"
                        variant={b.form === form ? "default" : "outline"}
                        aria-pressed={b.form === form}
                        onClick={() => act({ op: "form", body: b.id, form })}
                      >
                        {form === "cartoon" ? "Cartoon" : "Full body"}
                      </Button>
                    ))}
                  </span>
                }
              />
            ) : null}
            {b.holds > 1 ? (
              <SettingsRow
                title="Beside it"
                description={`Up to ${b.holds - 1} more personas on it at once.`}
                control={
                  <span className="flex flex-wrap justify-end gap-1">
                    {view.personas
                      .filter((p) => p.id !== b.wearing)
                      .map((p) => {
                        const on = b.crew.includes(p.id);
                        return (
                          <Button
                            key={p.id}
                            size="xs"
                            variant={on ? "default" : "outline"}
                            aria-pressed={on}
                            onClick={() =>
                              act({
                                op: "crew",
                                body: b.id,
                                personas: on ? b.crew.filter((c) => c !== p.id) : [...b.crew, p.id],
                              })
                            }
                          >
                            {p.name}
                          </Button>
                        );
                      })}
                  </span>
                }
              />
            ) : null}
          </SettingsSection>
        ))
      )}
    </>
  );
}
