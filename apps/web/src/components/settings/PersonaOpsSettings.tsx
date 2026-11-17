/**
 * Settings → Voice → Personas in the ops system: which personas act in the ops system as their own worker, the accounts
 * The ops system shows each, and revoking one (its token leaves the brain). She does the same by voice (ops_access).
 */
import type { PersonaOpsCallInput, PersonaOpsView } from "@t3tools/tessaya-contracts";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { tessayaWorkSessions } from "../../state/tessayaWorkSessions";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const name = (persona: string) => `${persona[0]?.toUpperCase() ?? ""}${persona.slice(1)}`;

export function PersonaOpsAccess(props: { readonly environmentId: EnvironmentId }) {
  const call = useAtomCommand(tessayaWorkSessions.personaOpsCall, { reportFailure: false });
  const [view, setView] = useState<PersonaOpsView | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const send = async (input: PersonaOpsCallInput) => {
    const result = await call({ environmentId: props.environmentId, input });
    if (result._tag !== "Success") return setNote("Couldn’t reach this environment. Try again.");
    setNote(result.value.ok ? "" : (result.value.error ?? "That didn’t work."));
    if (result.value.view !== undefined) setView(result.value.view);
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the ops system access once per environment
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect, react/exhaustive-effect-dependencies -- one read per environment
    void send({ op: "view" });
  }, [props.environmentId]);

  // Only the brain acts in the ops system; elsewhere there is nothing to show.
  if (view === null || !view.available) return null;

  const revoke = async (persona: string) => {
    setBusy(persona);
    await send({ op: "revoke", persona });
    setBusy(null);
  };

  return (
    <SettingsSection id="voice-persona-ops" title={`Personas in ${view.name}`}>
      <SettingsRow
        title={`Who acts in ${view.name}`}
        description={`Each acts as its own ${view.name} worker, only on the accounts ${view.name} gave it. Posts wait for your yes in ${view.name}.`}
        status={note === "" ? undefined : note}
      />
      {view.personas.map((p) => (
        <SettingsRow
          key={p.persona}
          title={name(p.persona)}
          description={
            !p.hasToken
              ? `No token on the brain: it can’t act in ${view.name}.`
              : p.accounts === null
                ? (p.error ?? `${view.name} didn’t answer.`)
                : p.accounts.length === 0
                  ? `${view.name} shows it no warm-up schedules yet.`
                  : `Warm-up schedules: ${p.accounts
                      .map((a) => `@${a.account} on ${a.platform}${a.enabled ? "" : " (paused)"}`)
                      .join(", ")}`
          }
          control={
            p.hasToken ? (
              <Button
                variant="outline"
                size="sm"
                disabled={busy === p.persona}
                onClick={() => void revoke(p.persona)}
              >
                Revoke
              </Button>
            ) : undefined
          }
        />
      ))}
    </SettingsSection>
  );
}
