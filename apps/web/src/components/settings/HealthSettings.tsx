/**
 * Tessaya › Health: the same snapshot and diagnosis her `tessaya_health` tool reads ("why are you slow?"), so what
 * she says and what this page shows never differ.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import type { ProblemReport, ReportsView } from "@t3tools/tessaya-contracts";
import { healthLines } from "@t3tools/tessaya-shared/healthView";
import { useState } from "react";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
import { tessayaWorkSessions } from "../../state/tessayaWorkSessions";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { Choice } from "./BrainSettings";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export function HealthSection({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const query = useEnvironmentQuery(tessayaWorkSessions.healthQuery({ environmentId, input: {} }));
  const view = query.data === null ? null : healthLines(query.data);
  return (
    <>
      <SettingsSection title="Health">
        <SettingsRow
          title={view?.summary ?? (query.isPending ? "Checking…" : "No reading yet")}
          description={query.error ?? (view?.checked || undefined)}
          control={
            <Button size="xs" variant="outline" onClick={() => query.refresh()}>
              Check again
            </Button>
          }
        />
        {view?.findings.map((f) => (
          <SettingsRow key={f.key} title={f.title} description={f.detail} status={f.severity} />
        ))}
      </SettingsSection>
      {view === null
        ? null
        : view.groups.map((g) => (
            <SettingsSection key={g.title} title={g.title}>
              {g.rows.map((r) => (
                <SettingsRow key={r.key} title={r.title} description={r.detail} />
              ))}
            </SettingsSection>
          ))}
      <ReportsSection environmentId={environmentId} />
    </>
  );
}

const MODE_LABELS: Readonly<Record<string, string>> = {
  off: "Off",
  silent: "Silent",
  developer: "Developer",
};
const STATUS_LABELS: Readonly<Record<ProblemReport["status"], string>> = {
  open: "Sent",
  filed: "Filed as an issue",
  withdrawn: "Withdrawn",
  deleted: "Deleted",
};

/** The reports she sent the developers, with the way back: withdraw keeps it listed, delete removes it everywhere. */
function ReportsSection({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const query = useEnvironmentQuery(tessayaWorkSessions.reportsQuery({ environmentId, input: {} }));
  const send = useAtomCommand(tessayaWorkSessions.reportsCall, { reportFailure: false });
  const mode = useEnvironmentSettings(environmentId, (s) => s.tessayaFeedback);
  const github = useEnvironmentSettings(environmentId, (s) => s.tessayaFeedbackGithub);
  const update = useUpdateEnvironmentSettings(environmentId);
  const [latest, setLatest] = useState<ReportsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const view = latest ?? query.data;
  const act = async (op: "withdraw" | "delete", id: string) => {
    setError(null);
    const result = await send({ environmentId, input: { op, id } });
    if (result._tag === "Success") setLatest(result.value);
    else setError(formatEnvironmentQueryError(result.cause));
  };
  return (
    <SettingsSection title="Problem reports">
      <SettingsRow
        title="Developer feedback loop"
        description={`Off collects nothing. Silent reports real faults without a word. Developer adds a live feed of every device for the developers, and she tells you when she sends a report.`}
        control={
          <Choice
            label="Developer feedback loop"
            value={mode}
            options={["off", "silent", "developer"] as const}
            labels={MODE_LABELS}
            onChange={(next) => update({ tessayaFeedback: next })}
          />
        }
      />
      <SettingsRow
        title="Open a GitHub issue"
        description="Each report also opens an issue labelled tessaya-report. Reports carry her health readings and log events, never what you said."
        control={
          <Switch
            aria-label="Open a GitHub issue"
            checked={github}
            onCheckedChange={(on) => update({ tessayaFeedbackGithub: on })}
          />
        }
      />
      {error === null && query.error === null ? null : (
        <SettingsRow title="Couldn't change that" description={error ?? query.error ?? ""} />
      )}
      {view?.reports.map((r) => (
        <SettingsRow
          key={r.id}
          title={r.title}
          description={`${new Date(r.at).toLocaleString()} · ${r.source === "asked" ? "you asked" : "she found it"}${r.bundle?.guess === undefined ? "" : ` · ${r.bundle.guess}`}${r.issueUrl === null ? "" : ` · ${r.issueUrl}`}`}
          status={STATUS_LABELS[r.status]}
          control={
            <>
              {r.status === "withdrawn" ? null : (
                <Button size="xs" variant="outline" onClick={() => void act("withdraw", r.id)}>
                  Withdraw
                </Button>
              )}
              <Button size="xs" variant="outline" onClick={() => void act("delete", r.id)}>
                Delete
              </Button>
            </>
          }
        />
      ))}
    </SettingsSection>
  );
}
