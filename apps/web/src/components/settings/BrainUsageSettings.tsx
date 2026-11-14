/**
 * Settings → Usage's brain section (BRAIN-DESIGN §13.3): what each kind of her work used on which login, by day in
 * the reader's own zone, and his API spend alerts against what the key spent.
 */
import type { BrainUsageResult, EnvironmentId } from "@t3tools/tessaya-contracts";
import { BRAIN_ROLE_LABELS, credentialLabel } from "@t3tools/tessaya-shared/brainRoutes";
import type { BrainCredential, BrainRole, BrainSpendLimit } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { batonWorkSessions } from "../../state/batonWorkSessions";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";

const RANGES = [
  { days: 1, label: "Today" },
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
] as const;
const tokens = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const money = (dollars: number) => `$${dollars < 1 ? dollars.toFixed(3) : dollars.toFixed(2)}`;
const roleLabel = (role: string) => BRAIN_ROLE_LABELS[role as BrainRole] ?? role;
const loginLabel = (credential: string) => credentialLabel(credential as BrainCredential);

interface Line {
  readonly key: string;
  readonly role: string;
  readonly credential: string;
  readonly model: string;
  calls: number;
  tokens: number;
  dollars: number | null;
}

/** One line per role, login and model over the whole range, the costliest first, then the busiest. */
const usageLines = (totals: BrainUsageResult["totals"]): ReadonlyArray<Line> => {
  const lines = new Map<string, Line>();
  for (const t of totals) {
    const key = `${t.role}|${t.credential}|${t.model}`;
    const line = lines.get(key) ?? {
      key,
      role: t.role,
      credential: t.credential,
      model: t.model,
      calls: 0,
      tokens: 0,
      dollars: null,
    };
    line.calls += t.calls;
    line.tokens += t.input + t.cacheRead + t.cacheWrite + t.output;
    if (t.dollars !== null) line.dollars = (line.dollars ?? 0) + t.dollars;
    lines.set(key, line);
  }
  return [...lines.values()].toSorted(
    (a, b) => (b.dollars ?? 0) - (a.dollars ?? 0) || b.calls - a.calls,
  );
};

export function BrainUsagePanel() {
  const { environment } = useSettingsScope();
  return (
    <SettingsPageContainer>
      {environment?.connection.phase === "connected" ? (
        <BrainUsageSections
          key={environment.environmentId}
          environmentId={environment.environmentId}
        />
      ) : (
        <p className="px-4 py-3 text-sm text-muted-foreground">
          Connect an environment to see what her brain used.
        </p>
      )}
    </SettingsPageContainer>
  );
}

function BrainUsageSections({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const read = useAtomCommand(batonWorkSessions.brainUsage, { reportFailure: false });
  const [days, setDays] = useState<number>(7);
  const [report, setReport] = useState<BrainUsageResult | null>(null);
  const [failed, setFailed] = useState(false);
  const refresh = async (range: number) => {
    const result = await read({
      environmentId,
      input: { days: range, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
    });
    setFailed(result._tag !== "Success");
    if (result._tag === "Success") setReport(result.value);
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the server's usage once per environment and range
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect, react/exhaustive-effect-dependencies -- one read per environment and range; refresh closes over them
    void refresh(days);
  }, [environmentId, days]);

  const lines = report === null ? [] : usageLines(report.totals);
  const apiSpent = lines.reduce((sum, line) => sum + (line.dollars ?? 0), 0);
  const planTokens = lines
    .filter((line) => line.dollars === null && line.credential.startsWith("subscription"))
    .reduce((sum, line) => sum + line.tokens, 0);
  return (
    <>
      <SettingsSection
        title="What her brain used"
        headerAction={
          <div className="flex gap-1" role="group" aria-label="Range">
            {RANGES.map((range) => (
              <Button
                key={range.days}
                size="xs"
                variant={range.days === days ? "secondary" : "ghost-muted"}
                aria-pressed={range.days === days}
                onClick={() => setDays(range.days)}
              >
                {range.label}
              </Button>
            ))}
          </div>
        }
      >
        <SettingsRow
          title="API key"
          description="What the Anthropic key spent, at list price."
          control={<span className="text-sm tabular-nums">{money(apiSpent)}</span>}
        />
        <SettingsRow
          title="Claude subscription"
          description="Covered by your plan: tokens, not dollars."
          control={<span className="text-sm tabular-nums">{tokens.format(planTokens)} tokens</span>}
        />
        {failed ? (
          <p className="px-4 py-3 text-sm text-muted-foreground">
            This server could not read its usage.
          </p>
        ) : lines.length === 0 ? (
          <p className="px-4 py-3 text-sm text-muted-foreground">
            {report === null ? "Reading…" : "Nothing used in this range."}
          </p>
        ) : (
          lines.map((line) => (
            <SettingsRow
              key={line.key}
              title={roleLabel(line.role)}
              description={`${loginLabel(line.credential)} · ${line.model} · ${line.calls} ${
                line.calls === 1 ? "call" : "calls"
              } · ${tokens.format(line.tokens)} tokens`}
              control={
                <span className="text-sm tabular-nums">
                  {line.dollars === null ? "Plan" : money(line.dollars)}
                </span>
              }
            />
          ))
        )}
      </SettingsSection>
      <NearLimit environmentId={environmentId} />
      <SpendAlerts environmentId={environmentId} limits={report?.limits ?? []} />
    </>
  );
}

/** One subscription near its limit: background learning waits for the reset so talking keeps working (B-031). */
function NearLimit({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const on = useEnvironmentSettings(environmentId, (settings) => settings.brainDeferNearLimit);
  const update = useUpdateEnvironmentSettings(environmentId);
  return (
    <SettingsSection title="Near the limit">
      <SettingsRow
        title="Let background learning wait"
        description="When the subscription has 15% or less left and no other login has room, background learning and memory upkeep wait for the reset. Talking and hard tasks go on."
        control={
          <Switch
            checked={on}
            aria-label="Let background learning wait near the limit"
            onCheckedChange={(checked) => update({ brainDeferNearLimit: Boolean(checked) })}
          />
        }
      />
    </SettingsSection>
  );
}

/** His alerts on every role together; a role's own limit is set by voice ("tell me if cleanup passes 50 cents"). */
function SpendAlerts({
  environmentId,
  limits,
}: {
  readonly environmentId: EnvironmentId;
  readonly limits: BrainUsageResult["limits"];
}) {
  const all = useEnvironmentSettings(environmentId, (settings) => settings.brainSpendAlert.all);
  const update = useUpdateEnvironmentSettings(environmentId);
  const field = (period: keyof BrainSpendLimit, title: string, description: string) => {
    const state = limits.find((l) => l.scope === "all" && l.period === period);
    return (
      <SettingsRow
        title={title}
        description={
          state === undefined
            ? description
            : `${money(state.spent)} of ${money(state.limit)} so far${state.reached ? ": reached" : ""}.`
        }
        control={
          <Input
            key={String(all?.[period] ?? "")}
            type="number"
            min={0.01}
            step={0.5}
            className="w-24"
            aria-label={title}
            placeholder="Off"
            defaultValue={all?.[period] ?? ""}
            onBlur={(event) => {
              const raw = event.target.value.trim();
              const value = raw === "" ? null : Number(raw);
              if (value !== null && !(value >= 0.01)) return;
              if (value === (all?.[period] ?? null)) return;
              update({ brainSpendAlert: { all: { [period]: value } } });
            }}
          />
        }
      />
    );
  };
  const others = limits.filter((l) => l.scope !== "all");
  return (
    <SettingsSection title="API spend alerts">
      {field("day", "A day", "Tell me when the API key passes this in a day. Empty is off.")}
      {field("month", "A month", "Tell me when the API key passes this in a month. Empty is off.")}
      {others.map((l) => (
        <SettingsRow
          key={`${l.scope}-${l.period}`}
          title={`${roleLabel(l.scope)}, a ${l.period}`}
          description={`${money(l.spent)} of ${money(l.limit)} so far${l.reached ? ": reached" : ""}. Change it by voice.`}
        />
      ))}
    </SettingsSection>
  );
}
