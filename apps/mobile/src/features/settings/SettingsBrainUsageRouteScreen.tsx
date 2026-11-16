/**
 * Settings → Brain usage, mirroring web's Settings → Usage: what her brain used by feature, persona, surface, model,
 * day or login in this phone's zone, each line opening to its calls; per-schedule and per-job costs; the near-limit
 * switch; and his API spend alerts. A role's own alert is set by voice ("tell me if cleanup passes 50 cents").
 */
import type { EnvironmentId, ServerSettings } from "@t3tools/contracts";
import type { BrainUsageCall, BrainUsageResult } from "@t3tools/tessaya-contracts";
import { BRAIN_ROLE_LABELS, credentialLabel } from "@t3tools/tessaya-shared/brainRoutes";
import {
  lineCalls,
  lineDetail,
  USAGE_VIEWS,
  usageLines,
  type UsageLine,
  type UsageView,
} from "@t3tools/tessaya-shared/brainUsageLines";
import type { BrainCredential, BrainRole } from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { TextInput } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { ControlPill } from "../../components/ui/ControlPill";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { serverEnvironment } from "../../state/server";
import { tessayaWorkSessions } from "../../state/tessayaWorkSessions";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSettingsEnvironmentMenu } from "./components/SettingsEnvironmentFilterHeader";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { SettingsTextRow } from "./components/SettingsTextRow";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";

const RANGES = [
  { days: 1, label: "Today" },
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
] as const;
const VIEW_LABELS: Record<UsageView, string> = {
  feature: "Feature",
  persona: "Persona",
  surface: "Surface",
  model: "Model",
  day: "Day",
  login: "Login",
};
const OUTCOME_LABELS = { ok: null, failed: "failed", unmeasured: "no token count" } as const;
const INPUT_CLASS =
  "w-24 rounded-lg border border-border-subtle px-3 py-2 text-base text-foreground";
const tokens = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const callTime = new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" });
const money = (dollars: number) => `$${dollars < 1 ? dollars.toFixed(3) : dollars.toFixed(2)}`;
const readerZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const plural = (n: number, word: string) => `${n} ${n === 1 ? word : `${word}s`}`;
const roleLabel = (role: string) => BRAIN_ROLE_LABELS[role as BrainRole] ?? role;
const loginLabel = (credential: string) => credentialLabel(credential as BrainCredential);
const lineTitle = (view: UsageView, line: UsageLine) => {
  const t = line.total;
  if (view === "login") return roleLabel(t.role);
  if (view === "day") return t.day;
  return t[view] ?? "None";
};

export function SettingsBrainUsageRouteScreen() {
  const environmentMenu = useSettingsEnvironmentMenu();
  const { selectedTargets } = useSettingsEnvironmentFilter();
  const insets = useSafeAreaInsets();
  return (
    <SettingsScreen title="Brain usage" menus={[environmentMenu]}>
      <ScreenScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {selectedTargets.length === 0 ? (
          <Text className="text-foreground-muted">
            Connect an environment to see what her brain used.
          </Text>
        ) : (
          selectedTargets.map((environment) => (
            <UsageSections
              key={environment.environmentId}
              environmentId={environment.environmentId}
              settings={environment.serverConfig.settings}
              label={selectedTargets.length > 1 ? environment.label : null}
            />
          ))
        )}
      </ScreenScrollView>
    </SettingsScreen>
  );
}

function UsageSections(props: {
  readonly environmentId: EnvironmentId;
  readonly settings: ServerSettings;
  readonly label: string | null;
}) {
  const { environmentId, settings } = props;
  const read = useAtomCommand(tessayaWorkSessions.brainUsage, { reportFailure: false });
  const update = useAtomCommand(serverEnvironment.updateSettings, {
    label: "usage update",
    reportFailure: true,
  });
  const [days, setDays] = useState<number>(7);
  const [view, setView] = useState<UsageView>("feature");
  const [report, setReport] = useState<BrainUsageResult | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState<{
    readonly key: string;
    readonly calls: ReadonlyArray<BrainUsageCall> | "reading" | "failed";
  } | null>(null);
  const timeZone = readerZone();
  const refresh = (range: number) =>
    read({ environmentId, input: { days: range, timeZone } }).then((result) => {
      setFailed(result._tag !== "Success");
      if (result._tag === "Success") setReport(result.value);
    });
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
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- one read per environment and range; refresh closes over them
    void refresh(days);
  }, [environmentId, days]);
  const patch = (next: Parameters<typeof update>[0]["input"]["patch"]) =>
    void update({ environmentId, input: { patch: next } });

  const lines = report === null ? [] : usageLines(report.totals, view);
  const apiSpent = lines.reduce((sum, line) => sum + (line.dollars ?? 0), 0);
  const planTokens = (report?.totals ?? [])
    .filter((t) => t.billing === "subscription")
    .reduce((sum, t) => sum + t.input + t.cacheRead + t.cacheWrite + t.output, 0);
  const prefix = props.label === null ? "" : `${props.label} · `;
  const units = report?.units ?? [];
  const limits = report?.limits ?? [];
  const all = settings.brainSpendAlert.all;
  return (
    <>
      <SettingsSection title={`${prefix}What her brain used`}>
        <SettingsTextRow title="Range">
          {RANGES.map((range) => (
            <ControlPill
              key={range.days}
              variant={range.days === days ? "primary" : "pill"}
              label={range.label}
              onPress={() => {
                setOpen(null);
                setDays(range.days);
              }}
            />
          ))}
        </SettingsTextRow>
        <SettingsTextRow
          divider
          title={`API key: ${money(apiSpent)}`}
          description="What the Anthropic key spent, at list price."
        />
        <SettingsTextRow
          divider
          title={`Claude subscription: ${tokens.format(planTokens)} tokens`}
          description="Covered by your plan: tokens, not dollars."
        />
        <SettingsTextRow divider title="By">
          {USAGE_VIEWS.map((v) => (
            <ControlPill
              key={v}
              variant={v === view ? "primary" : "pill"}
              label={VIEW_LABELS[v]}
              onPress={() => {
                setOpen(null);
                setView(v);
              }}
            />
          ))}
        </SettingsTextRow>
        {failed ? (
          <SettingsTextRow divider title="This server could not read its usage." />
        ) : lines.length === 0 ? (
          <SettingsTextRow
            divider
            title={report === null ? "Reading…" : "Nothing used in this range."}
          />
        ) : (
          lines.map((line) => (
            <UsageLineRow
              key={line.key}
              title={lineTitle(view, line)}
              description={`${
                view === "login"
                  ? `${loginLabel(line.total.credential)} · ${line.total.model} · `
                  : ""
              }${plural(line.calls, "call")} · ${tokens.format(line.tokens)} tokens`}
              cost={line.dollars === null ? "Plan" : money(line.dollars)}
              open={open?.key === line.key ? open.calls : null}
              onToggle={() => void toggle(line)}
            />
          ))
        )}
      </SettingsSection>
      {(["schedule", "job"] as const).map((kind) => {
        const rows = units.filter((unit) => unit.kind === kind);
        if (rows.length === 0) return null;
        return (
          <SettingsSection
            key={kind}
            title={`${prefix}${kind === "schedule" ? "Per schedule" : "Per job"}`}
          >
            {rows.map((unit, i) => {
              const each = kind === "schedule" && unit.runs > 1 ? unit.runs : 1;
              const cost = unit.listDollars ?? unit.dollars;
              return (
                <SettingsTextRow
                  key={unit.id}
                  divider={i > 0}
                  title={`${unit.label ?? unit.id}: ${
                    cost === null
                      ? "Not priced"
                      : `${money(cost / each)}${each > 1 ? " a run" : ""}`
                  }`}
                  description={[
                    plural(unit.runs, "run"),
                    plural(unit.calls, "call"),
                    `${tokens.format(unit.tokens / each)} tokens${each > 1 ? " a run" : ""}`,
                    unit.dollars === null ? null : `API key ${money(unit.dollars)}`,
                  ]
                    .filter((part) => part !== null)
                    .join(" · ")}
                />
              );
            })}
          </SettingsSection>
        );
      })}
      <SettingsSection title={`${prefix}Near the limit`}>
        <SettingsSwitchRow
          label="Let background learning wait"
          subtitle="When the subscription has 15% or less left and no other login has room, background learning and memory upkeep wait for the reset. Talking and hard tasks go on."
          value={settings.brainDeferNearLimit}
          onValueChange={(on) => patch({ brainDeferNearLimit: on })}
        />
      </SettingsSection>
      <SettingsSection title={`${prefix}API spend alerts`}>
        {(
          [
            ["day", "A day"],
            ["month", "A month"],
          ] as const
        ).map(([period, title], i) => {
          const state = limits.find((l) => l.scope === "all" && l.period === period);
          return (
            <SettingsTextRow
              key={period}
              divider={i > 0}
              title={title}
              description={
                state === undefined
                  ? `Tell me when the API key passes this in a ${period}. Empty is off.`
                  : `${money(state.spent)} of ${money(state.limit)} so far${state.reached ? ": reached" : ""}.`
              }
            >
              <TextInput
                key={String(all?.[period] ?? "")}
                accessibilityLabel={`Spend alert, ${title.toLowerCase()}`}
                className={INPUT_CLASS}
                placeholderTextColorClassName="accent-foreground-muted"
                placeholder="Off"
                keyboardType="decimal-pad"
                defaultValue={all?.[period] === undefined ? "" : String(all[period])}
                onEndEditing={({ nativeEvent }) => {
                  const raw = nativeEvent.text.trim();
                  const value = raw === "" ? null : Number(raw);
                  if (value !== null && !(value >= 0.01)) return;
                  if (value === (all?.[period] ?? null)) return;
                  patch({ brainSpendAlert: { all: { [period]: value } } });
                }}
              />
            </SettingsTextRow>
          );
        })}
        {limits
          .filter((l) => l.scope !== "all")
          .map((l) => (
            <SettingsTextRow
              key={`${l.scope}-${l.period}`}
              divider
              title={`${roleLabel(l.scope)}, a ${l.period}`}
              description={`${money(l.spent)} of ${money(l.limit)} so far${l.reached ? ": reached" : ""}. Change it by voice.`}
            />
          ))}
      </SettingsSection>
    </>
  );
}

function UsageLineRow(props: {
  readonly title: string;
  readonly description: string;
  readonly cost: string;
  readonly open: ReadonlyArray<BrainUsageCall> | "reading" | "failed" | null;
  readonly onToggle: () => void;
}) {
  const { open } = props;
  return (
    <>
      <SettingsTextRow divider title={props.title} description={props.description}>
        <ControlPill
          variant={open === null ? "pill" : "primary"}
          label={props.cost}
          accessibilityLabel={`Calls for ${props.title}`}
          onPress={props.onToggle}
        />
      </SettingsTextRow>
      {open === null ? null : open === "reading" || open === "failed" || open.length === 0 ? (
        <SettingsTextRow
          title={
            open === "reading"
              ? "Reading…"
              : open === "failed"
                ? "This server could not read these calls."
                : "No calls found."
          }
        />
      ) : (
        open.map((call) => (
          <SettingsTextRow
            key={`${call.at}-${call.role}-${call.credential}-${call.turnId}-${call.jobId}`}
            title={`${callTime.format(new Date(call.at))} · ${call.feature} · ${
              call.dollars === null ? "Plan" : money(call.dollars)
            }`}
            description={[
              call.origin,
              call.surface,
              call.persona,
              call.model,
              loginLabel(call.credential),
              `${tokens.format(call.input + call.cacheRead + call.cacheWrite + call.output)} tokens`,
              OUTCOME_LABELS[call.outcome],
              call.turnId === null ? null : `turn ${call.turnId}`,
            ]
              .filter((fact) => fact !== null)
              .join(" · ")}
          />
        ))
      )}
    </>
  );
}
