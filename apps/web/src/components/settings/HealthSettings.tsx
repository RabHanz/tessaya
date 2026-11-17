/**
 * Tessaya › Health: the same snapshot and diagnosis her `tessaya_health` tool reads ("why are you slow?"), so what
 * she says and what this page shows never differ.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { healthLines } from "@t3tools/tessaya-shared/healthView";

import { useEnvironmentQuery } from "../../state/query";
import { tessayaWorkSessions } from "../../state/tessayaWorkSessions";
import { Button } from "../ui/button";
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
    </>
  );
}
