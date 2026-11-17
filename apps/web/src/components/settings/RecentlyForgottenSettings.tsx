/**
 * Tessaya › Recently forgotten: people and facts from her understanding, restorable for the bin's days, as the
 * desktop's People section shows them. The household service decides who may restore or delete; a refusal shows its line.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import type { TessayaHouseholdCallInput } from "@t3tools/tessaya-contracts";
import {
  BIN_DAY_CHOICES,
  FORGOTTEN_COPY,
  type Forgotten,
  forgottenRow,
  purgeTap,
} from "@t3tools/tessaya-shared/recentlyForgotten";
import { useEffect, useState } from "react";

import { formatEnvironmentQueryError } from "../../state/query";
import { tessayaWorkSessions } from "../../state/tessayaWorkSessions";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export function RecentlyForgottenSection({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const call = useAtomCommand(tessayaWorkSessions.householdCall, { reportFailure: false });
  const [bin, setBin] = useState<{
    readonly forgotten: ReadonlyArray<Forgotten>;
    readonly days: number;
  } | null>(null);
  const [line, setLine] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const read = async () => {
    const result = await call({ environmentId, input: { op: "peopleList" } });
    if (result._tag !== "Success") return setLine(formatEnvironmentQueryError(result.cause));
    if (result.value.status !== "done") return setLine(result.value.line);
    setBin({ forgotten: result.value.forgotten ?? [], days: result.value.binDays ?? 30 });
  };
  const send = async (input: TessayaHouseholdCallInput) => {
    setConfirming(null);
    const result = await call({ environmentId, input });
    setLine(
      result._tag === "Success"
        ? result.value.line || null
        : formatEnvironmentQueryError(result.cause),
    );
    await read();
  };
  const purge = (id?: string) => {
    const tap = purgeTap(confirming, id);
    if ("confirm" in tap) setConfirming(tap.confirm);
    else void send(tap.send);
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the environment's bin once per environment
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect, react/exhaustive-effect-dependencies -- one read per environment
    void read();
  }, [environmentId]);

  return (
    <SettingsSection title={FORGOTTEN_COPY.section}>
      {bin === null ? (
        line === null ? (
          <SettingsRow title="Loading…" />
        ) : null
      ) : (
        <>
          <SettingsRow
            title={FORGOTTEN_COPY.days}
            description={FORGOTTEN_COPY.hint}
            control={
              <Select
                value={String(bin.days)}
                onValueChange={(days) =>
                  days !== null &&
                  void send({ op: "peopleManage", action: "bin", days: Number(days) })
                }
              >
                <SelectTrigger size="sm" aria-label={FORGOTTEN_COPY.days}>
                  <SelectValue>{(v: string | null) => `${v ?? bin.days} days`}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {BIN_DAY_CHOICES.map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      {`${n} days`}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
          {bin.forgotten.map((f) => {
            const row = forgottenRow(f);
            return (
              <SettingsRow
                key={f.id}
                title={confirming === f.id ? row.confirm : row.label}
                description={row.hint}
                control={
                  <span className="flex flex-wrap justify-end gap-1">
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => void send({ op: "peopleManage", action: "restore", id: f.id })}
                    >
                      {FORGOTTEN_COPY.restore}
                    </Button>
                    <Button size="xs" variant="destructive-outline" onClick={() => purge(f.id)}>
                      {FORGOTTEN_COPY.purge}
                    </Button>
                  </span>
                }
              />
            );
          })}
          {bin.forgotten.length === 0 ? (
            <SettingsRow title={FORGOTTEN_COPY.empty} />
          ) : (
            <SettingsRow
              title={
                confirming === "all" ? FORGOTTEN_COPY.purgeAllConfirm : FORGOTTEN_COPY.purgeAllLabel
              }
              control={
                <Button size="xs" variant="destructive-outline" onClick={() => purge()}>
                  {FORGOTTEN_COPY.purgeAll}
                </Button>
              }
            />
          )}
        </>
      )}
      {line === null ? null : <SettingsRow title={line} />}
    </SettingsSection>
  );
}
