/**
 * Settings → Brain → Always allowed: his standing yeses, the one list on his server every vessel reads (the Tessel, his
 * desktop, phone and web). Revoking one here means she asks again everywhere; he gives one by answering "Always allow".
 */
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/tessaya-contracts";
import { grantLabel } from "@t3tools/tessaya-shared/consent";
import { useEffect, useState } from "react";

import { tessayaWorkSessions } from "../../state/tessayaWorkSessions";
import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export function StandingYeses({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const allowed = useAtomValue(tessayaWorkSessions.consentList.permissionAtom(environmentId));
  const mayRevoke = useAtomValue(tessayaWorkSessions.consentSet.permissionAtom(environmentId));
  const list = useAtomCommand(tessayaWorkSessions.consentList, { reportFailure: false });
  const set = useAtomCommand(tessayaWorkSessions.consentSet);
  const [keys, setKeys] = useState<ReadonlyArray<string> | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads his standing yeses from his server once per environment
  useEffect(() => {
    if (!allowed) return;
    void list({ environmentId, input: {} }).then((r) => {
      if (r._tag === "Success") setKeys(r.value.keys);
    });
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- one read per environment; the command is stable
  }, [environmentId, allowed]);

  const minutes = useEnvironmentSettings(environmentId, (s) => s.approvalCardMinutes);
  const update = useUpdateEnvironmentSettings(environmentId);
  const cardLife = (
    <SettingsRow
      title="Cards wait"
      description="Minutes a card asking for your yes stays answerable, on every device, before it is dropped unanswered."
      control={
        <Input
          key={minutes}
          type="number"
          min={1}
          max={1440}
          className="w-24"
          aria-label="Minutes a card waits"
          defaultValue={minutes}
          onBlur={(event) => {
            const value = Math.round(Number(event.target.value));
            if (value >= 1 && value <= 1440 && value !== minutes)
              update({ approvalCardMinutes: value });
          }}
        />
      }
    />
  );
  if (!allowed || keys === null)
    return <SettingsSection title="Always allowed">{cardLife}</SettingsSection>;
  const revoke = async (key: string) => {
    const r = await set({ environmentId, input: { key, allow: false } });
    if (r._tag === "Success") setKeys(r.value.keys);
  };
  return (
    <SettingsSection title="Always allowed">
      {cardLife}
      {keys.length === 0 ? (
        <SettingsRow
          title="Nothing yet"
          description="When she asks, answer “Always allow” and she stops asking about that on every device. Only your own voice or your own devices count; anyone else is still asked."
        />
      ) : (
        keys.map((key) => (
          <SettingsRow
            key={key}
            title={grantLabel(key)}
            description="She does this without asking you, on every device."
            control={
              <Button
                size="sm"
                variant="outline"
                disabled={!mayRevoke}
                onClick={() => void revoke(key)}
              >
                Ask again
              </Button>
            }
          />
        ))
      )}
    </SettingsSection>
  );
}
