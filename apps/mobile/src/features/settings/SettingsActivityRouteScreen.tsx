/**
 * Settings → Activity, mirroring web's Settings → Activity (B-046): every action on the server and what caused it,
 * filterable; a row opens its "why" (the cause chain) and what it caused. Likely bugs and gaps sit on top. By voice,
 * `tessaya_activity` answers "what did you do" and "why did that happen".
 */
import type { EnvironmentId } from "@t3tools/contracts";
import type {
  TessayaActionEvent,
  TessayaActivityListResult,
  TessayaActivityWhyResult,
} from "@t3tools/tessaya-contracts";
import { useEffect, useState } from "react";
import { Pressable, TextInput } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { ControlPill } from "../../components/ui/ControlPill";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { tessayaWorkSessions } from "../../state/tessayaWorkSessions";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSettingsEnvironmentMenu } from "./components/SettingsEnvironmentFilterHeader";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsTextRow } from "./components/SettingsTextRow";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";

const RANGES = [
  { minutes: 60, label: "Hour" },
  { minutes: 1_440, label: "Day" },
  { minutes: 10_080, label: "7 days" },
] as const;
const FAMILIES = [
  "",
  "tool",
  "model",
  "rpc",
  "device",
  "room",
  "record",
  "outcome",
  "private",
] as const;
const INPUT_CLASS =
  "min-w-40 flex-1 rounded-lg border border-border-subtle px-3 py-2 text-base text-foreground";
const time = new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "medium" });
const who = (e: TessayaActionEvent) => {
  const name = e.actor.id ?? e.actor.kind;
  return e.actor.certainty < 1 ? `${name} (${Math.round(e.actor.certainty * 100)}%)` : name;
};
type Why = TessayaActivityWhyResult | "reading" | "failed";

export function SettingsActivityRouteScreen() {
  const environmentMenu = useSettingsEnvironmentMenu();
  const { selectedTargets } = useSettingsEnvironmentFilter();
  const insets = useSafeAreaInsets();
  return (
    <SettingsScreen title="Activity" menus={[environmentMenu]}>
      <ScreenScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {selectedTargets.length === 0 ? (
          <Text className="text-foreground-muted">
            Connect an environment to see what she did and why.
          </Text>
        ) : (
          selectedTargets.map((environment) => (
            <ActivitySections
              key={environment.environmentId}
              environmentId={environment.environmentId}
              label={selectedTargets.length > 1 ? environment.label : null}
            />
          ))
        )}
      </ScreenScrollView>
    </SettingsScreen>
  );
}

function ActivitySections(props: {
  readonly environmentId: EnvironmentId;
  readonly label: string | null;
}) {
  const { environmentId } = props;
  const list = useAtomCommand(tessayaWorkSessions.activityList, { reportFailure: false });
  const why = useAtomCommand(tessayaWorkSessions.activityWhy, { reportFailure: false });
  const [minutes, setMinutes] = useState<number>(60);
  const [family, setFamily] = useState<string>("");
  const [text, setText] = useState("");
  const [result, setResult] = useState<TessayaActivityListResult | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState<{ readonly id: string; readonly why: Why } | null>(null);
  const refresh = () =>
    list({
      environmentId,
      input: {
        sinceMinutes: minutes,
        limit: 300,
        ...(family === "" ? {} : { kind: family }),
        ...(text.trim() === "" ? {} : { text: text.trim() }),
      },
    }).then((r) => {
      setFailed(r._tag !== "Success");
      if (r._tag === "Success") setResult(r.value);
    });
  const toggle = async (id: string) => {
    if (open?.id === id) return setOpen(null);
    setOpen({ id, why: "reading" });
    const r = await why({ environmentId, input: { id } });
    const answer = r._tag === "Success" ? r.value : "failed";
    setOpen((current) => (current?.id === id ? { id, why: answer } : current));
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the server's log once per environment, range and family
  useEffect(() => {
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- one read per environment, range and family; refresh closes over them
    void refresh();
  }, [environmentId, minutes, family]);
  const prefix = props.label === null ? "" : `${props.label} · `;
  const openOutside = open !== null && !result?.events.some((e) => e.id === open.id);

  return (
    <>
      {result !== null && result.findings.length > 0 ? (
        <SettingsSection title={`${prefix}Likely bugs and gaps`}>
          {result.findings.map((f, i) => (
            <SettingsTextRow
              key={`${f.rule}|${f.key}`}
              divider={i > 0}
              title={f.title}
              description={`${f.count}× · last ${time.format(new Date(f.lastAt))}`}
            >
              {f.eventIds.length === 0 ? null : (
                <ControlPill
                  variant="pill"
                  label="Why"
                  onPress={() => void toggle(f.eventIds.at(-1)!)}
                />
              )}
            </SettingsTextRow>
          ))}
        </SettingsSection>
      ) : null}
      {openOutside ? (
        <SettingsSection title={`${prefix}Why`}>
          <WhyView why={open.why} />
        </SettingsSection>
      ) : null}
      <SettingsSection title={`${prefix}What she did`}>
        <SettingsTextRow title="Range">
          {RANGES.map((range) => (
            <ControlPill
              key={range.minutes}
              variant={range.minutes === minutes ? "primary" : "pill"}
              label={range.label}
              onPress={() => setMinutes(range.minutes)}
            />
          ))}
        </SettingsTextRow>
        <SettingsTextRow divider title="Kind">
          {FAMILIES.map((f) => (
            <ControlPill
              key={f}
              variant={f === family ? "primary" : "pill"}
              label={f === "" ? "All" : f}
              onPress={() => setFamily(f)}
            />
          ))}
        </SettingsTextRow>
        <SettingsTextRow divider title="Find">
          <TextInput
            accessibilityLabel="Search the log"
            className={INPUT_CLASS}
            placeholderTextColorClassName="accent-foreground-muted"
            placeholder="Tool, device, setting…"
            returnKeyType="search"
            value={text}
            onChangeText={setText}
            onSubmitEditing={() => void refresh()}
          />
          <ControlPill variant="pill" label="Find" onPress={() => void refresh()} />
        </SettingsTextRow>
        {failed ? (
          <SettingsTextRow divider title="Couldn't read the log." />
        ) : result === null ? (
          <SettingsTextRow divider title="Reading…" />
        ) : result.events.length === 0 ? (
          <SettingsTextRow divider title="Nothing in this window." />
        ) : (
          result.events.map((e) => (
            <Pressable
              key={e.id}
              accessibilityRole="button"
              accessibilityState={{ expanded: open?.id === e.id }}
              onPress={() => void toggle(e.id)}
            >
              <SettingsTextRow
                divider
                title={`${e.kind} · ${e.subject}`}
                description={[
                  time.format(new Date(e.at)),
                  who(e),
                  e.outcome === "ok" ? null : e.outcome,
                ]
                  .filter((part) => part !== null)
                  .join(" · ")}
              />
              {open?.id === e.id ? <WhyView why={open.why} /> : null}
            </Pressable>
          ))
        )}
        {result !== null && result.dropped > 0 ? (
          <SettingsTextRow
            divider
            title={`${result.dropped} events were dropped since this server started (the writer fell behind).`}
          />
        ) : null}
      </SettingsSection>
    </>
  );
}

function WhyView({ why }: { readonly why: Why }) {
  if (why === "reading") return <SettingsTextRow title="Tracing…" />;
  if (why === "failed") return <SettingsTextRow title="Couldn't trace it." />;
  return (
    <SettingsTextRow
      title={why.lines[0] ?? ""}
      description={[
        ...why.lines.slice(1),
        why.effects.length === 0
          ? null
          : `Led to: ${why.effects
              .map((e) => `${e.kind}${e.subject === "" ? "" : ` (${e.subject})`}`)
              .join(", ")}`,
      ]
        .filter((line) => line !== null)
        .join("\n")}
    />
  );
}
