/**
 * Settings → Usage (BRAIN-DESIGN §13.3): what was used by feature, persona, surface, model, day or login, in the
 * reader's own zone; each line opens to its calls. Then his API spend alerts against what the key spent.
 */
import type { BrainUsageCall, BrainUsageResult, EnvironmentId } from "@t3tools/tessaya-contracts";
import { BRAIN_ROLE_LABELS, credentialLabel } from "@t3tools/tessaya-shared/brainRoutes";
import {
  ThreadId,
  type BrainCredential,
  type BrainRole,
  type BrainSpendLimit,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { Fragment, useEffect, useState } from "react";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { tessayaWorkSessions } from "../../state/tessayaWorkSessions";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import {
  lineCalls,
  lineDetail,
  USAGE_VIEWS,
  usageLines,
  type UsageLine,
  type UsageView,
} from "./BrainUsage.logic";
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

const VIEW_LABELS: Record<UsageView, string> = {
  feature: "Feature",
  persona: "Persona",
  surface: "Surface",
  model: "Model",
  day: "Day",
  login: "Login",
};
const callTime = new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" });
const readerZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const plural = (n: number, word: string) => `${n} ${n === 1 ? word : `${word}s`}`;
const OUTCOME_LABELS = { ok: null, failed: "failed", unmeasured: "no token count" } as const;

const lineTitle = (view: UsageView, line: UsageLine) => {
  const t = line.total;
  if (view === "login") return roleLabel(t.role);
  if (view === "day") return t.day;
  return t[view] ?? "None";
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
  const read = useAtomCommand(tessayaWorkSessions.brainUsage, { reportFailure: false });
  const [days, setDays] = useState<number>(7);
  const [view, setView] = useState<UsageView>("feature");
  const [report, setReport] = useState<BrainUsageResult | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState<{
    readonly key: string;
    readonly calls: ReadonlyArray<BrainUsageCall> | "reading" | "failed";
  } | null>(null);
  const timeZone = readerZone();
  const refresh = async (range: number) => {
    const result = await read({ environmentId, input: { days: range, timeZone } });
    setFailed(result._tag !== "Success");
    if (result._tag === "Success") setReport(result.value);
  };
  const toggle = async (line: UsageLine) => {
    if (open?.key === line.key) return setOpen(null);
    setOpen({ key: line.key, calls: "reading" });
    const result = await read({
      environmentId,
      input: { days, timeZone, detail: lineDetail(view, line) },
    });
    const calls =
      result._tag === "Success" ? lineCalls(result.value.calls ?? [], view, line) : "failed";
    setOpen((current) => (current?.key === line.key ? { key: line.key, calls } : current));
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the server's usage once per environment and range
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect, react/exhaustive-effect-dependencies -- one read per environment and range; refresh closes over them
    void refresh(days);
  }, [environmentId, days]);

  const lines = report === null ? [] : usageLines(report.totals, view);
  const apiSpent = lines.reduce((sum, line) => sum + (line.dollars ?? 0), 0);
  const planTokens = (report?.totals ?? [])
    .filter((t) => t.billing === "subscription")
    .reduce((sum, t) => sum + t.input + t.cacheRead + t.cacheWrite + t.output, 0);
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
                onClick={() => {
                  setOpen(null);
                  setDays(range.days);
                }}
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
        <SettingsRow
          title="By"
          control={
            <div className="flex flex-wrap gap-1" role="group" aria-label="Group by">
              {USAGE_VIEWS.map((v) => (
                <Button
                  key={v}
                  size="xs"
                  variant={v === view ? "secondary" : "ghost-muted"}
                  aria-pressed={v === view}
                  onClick={() => {
                    setOpen(null);
                    setView(v);
                  }}
                >
                  {VIEW_LABELS[v]}
                </Button>
              ))}
            </div>
          }
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
            <Fragment key={line.key}>
              <SettingsRow
                title={lineTitle(view, line)}
                description={`${
                  view === "login"
                    ? `${loginLabel(line.total.credential)} · ${line.total.model} · `
                    : ""
                }${plural(line.calls, "call")} · ${tokens.format(line.tokens)} tokens`}
                control={
                  <Button
                    size="xs"
                    variant={open?.key === line.key ? "secondary" : "ghost-muted"}
                    aria-expanded={open?.key === line.key}
                    aria-label={`Calls for ${lineTitle(view, line)}`}
                    onClick={() => void toggle(line)}
                  >
                    <span className="tabular-nums">
                      {line.dollars === null ? "Plan" : money(line.dollars)}
                    </span>
                  </Button>
                }
              />
              {open?.key === line.key ? (
                <UsageCalls environmentId={environmentId} calls={open.calls} />
              ) : null}
            </Fragment>
          ))
        )}
      </SettingsSection>
      <UnitCosts units={report?.units ?? []} />
      <NearLimit environmentId={environmentId} />
      <SpendAlerts environmentId={environmentId} limits={report?.limits ?? []} />
    </>
  );
}

/** The calls behind one line, each with everything it is attributed to. */
function UsageCalls({
  environmentId,
  calls,
}: {
  readonly environmentId: EnvironmentId;
  readonly calls: ReadonlyArray<BrainUsageCall> | "reading" | "failed";
}) {
  if (calls === "reading" || calls === "failed" || calls.length === 0) {
    return (
      <p className="px-4 py-3 text-sm text-muted-foreground">
        {calls === "reading"
          ? "Reading…"
          : calls === "failed"
            ? "This server could not read these calls."
            : "No calls found."}
      </p>
    );
  }
  return (
    <>
      {calls.map((call) => {
        const facts = [
          call.origin,
          call.surface,
          call.persona,
          call.model,
          loginLabel(call.credential),
          `${tokens.format(call.input + call.cacheRead + call.cacheWrite + call.output)} tokens`,
          OUTCOME_LABELS[call.outcome],
        ].filter((fact) => fact !== null);
        return (
          <SettingsRow
            key={`${call.at}-${call.role}-${call.credential}-${call.turnId}-${call.jobId}`}
            title={`${callTime.format(call.at)} · ${call.feature}`}
            description={
              <>
                {facts.join(" · ")}
                {call.threadId === null ? null : (
                  <>
                    {" · "}
                    <Link
                      to="/$environmentId/$threadId"
                      params={{ environmentId, threadId: ThreadId.make(call.threadId) }}
                      className="underline"
                    >
                      Thread
                    </Link>
                  </>
                )}
                {call.turnId === null ? null : ` · turn ${call.turnId}`}
              </>
            }
            control={
              <span className="text-sm tabular-nums">
                {call.dollars === null ? "Plan" : money(call.dollars)}
              </span>
            }
          />
        );
      })}
      {calls.length >= 200 ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">Showing the newest 200 calls.</p>
      ) : null}
    </>
  );
}

/** Each schedule's and each job's cost in the range: a schedule per run, a job in all, at list price. */
function UnitCosts({ units }: { readonly units: BrainUsageResult["units"] }) {
  if (units.length === 0) return null;
  const sections = [
    { kind: "schedule", title: "Per schedule" },
    { kind: "job", title: "Per job" },
  ] as const;
  return sections.map(({ kind, title }) => {
    const rows = units.filter((unit) => unit.kind === kind);
    if (rows.length === 0) return null;
    return (
      <SettingsSection key={kind} title={title}>
        {rows.map((unit) => {
          const each = kind === "schedule" && unit.runs > 1 ? unit.runs : 1;
          const cost = unit.listDollars ?? unit.dollars;
          return (
            <SettingsRow
              key={unit.id}
              title={unit.label ?? unit.id}
              description={[
                plural(unit.runs, "run"),
                plural(unit.calls, "call"),
                `${tokens.format(unit.tokens / each)} tokens${each > 1 ? " a run" : ""}`,
                unit.dollars === null ? null : `API key ${money(unit.dollars)}`,
              ]
                .filter((part) => part !== null)
                .join(" · ")}
              control={
                <span className="text-sm tabular-nums">
                  {cost === null
                    ? "Not priced"
                    : `${money(cost / each)}${each > 1 ? " a run" : ""}`}
                </span>
              }
            />
          );
        })}
      </SettingsSection>
    );
  });
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
