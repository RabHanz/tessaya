/**
 * Settings → Home, mirroring web's HomeSettings: connect Tessaya to Home Assistant (the token goes into the server's
 * secret store and never comes back), see and undo what she made and did there, answer what waits for a yes, and
 * move a device up or down a tier.
 */
import type {
  BatonHomeCallResult,
  HomeActionRow,
  HomeAutomationRow,
  HomeStatus,
} from "@t3tools/tessaya-contracts";
import {
  actionLine,
  automationActions,
  automationLine,
  homeStatusLine,
} from "@t3tools/tessaya-shared/homeView";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useState, type ReactNode } from "react";
import { TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { ControlPill } from "../../components/ui/ControlPill";
import { Menu } from "../../components/ui/Menu";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { batonWorkSessions } from "../../state/batonWorkSessions";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSettingsEnvironmentMenu } from "./components/SettingsEnvironmentFilterHeader";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";

type Tier = "auto" | "ask" | "never";
interface HomeView {
  readonly status: HomeStatus | null;
  readonly automations: ReadonlyArray<HomeAutomationRow>;
  readonly actions: ReadonlyArray<HomeActionRow>;
  readonly pending: ReadonlyArray<HomeActionRow>;
  readonly overrides: Readonly<Record<string, Tier>>;
}
const EMPTY: HomeView = { status: null, automations: [], actions: [], pending: [], overrides: {} };
const TIER_TEXT = { auto: "Does it", ask: "Asks first", never: "Never" } as const;
const TIERS = ["auto", "ask", "never"] as const;
const OP_TEXT = {
  pause: "Pause",
  resume: "Resume",
  delete: "Delete",
  undo: "Undo delete",
} as const;
const QUIET = { reportFailure: false } as const;
const INPUT_CLASS = "rounded-lg border border-border-subtle px-3 py-2 text-base text-foreground";

export function SettingsHomeRouteScreen() {
  const environmentMenu = useSettingsEnvironmentMenu();
  const { selectedTargets } = useSettingsEnvironmentFilter();
  const insets = useSafeAreaInsets();
  return (
    <SettingsScreen title="Home" menus={[environmentMenu]}>
      <ScreenScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {selectedTargets.length === 0 ? (
          <Text className="text-foreground-muted">Connect an environment to set up Home.</Text>
        ) : (
          selectedTargets.map((environment) => (
            <HomeSections
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

function HomeSections({
  environmentId,
  label,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string | null;
}) {
  const homeCall = useAtomCommand(batonWorkSessions.homeCall, QUIET);
  // One method; the kind sets its scope on the server (act is operate, answer is the approval scope).
  const via =
    (kind: "read" | "act" | "answer") =>
    (value: {
      readonly environmentId: EnvironmentId;
      readonly input: { readonly op: string; readonly args: Record<string, unknown> };
    }) =>
      homeCall({ environmentId: value.environmentId, input: { kind, ...value.input } });
  const read = via("read");
  const act = via("act");
  const answer = via("answer");
  const [view, setView] = useState<HomeView>(EMPTY);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState("");
  const [fallback, setFallback] = useState("");
  const [token, setToken] = useState("");
  const [entity, setEntity] = useState("");

  const value = async (op: string, args: Record<string, unknown> = {}) => {
    const result = await read({ environmentId, input: { op, args } });
    return result._tag === "Success" && result.value.ok ? result.value.value : null;
  };
  const refresh = async () => {
    const [status, automations, actions, pending, overrides] = await Promise.all([
      value("status"),
      value("automations", { all: true }),
      value("actions", { limit: 15 }),
      value("pending"),
      value("overrides"),
    ]);
    setView({
      status: (status as HomeStatus | null) ?? null,
      automations: (automations as ReadonlyArray<HomeAutomationRow> | null) ?? [],
      actions: (actions as ReadonlyArray<HomeActionRow> | null) ?? [],
      pending: (pending as ReadonlyArray<HomeActionRow> | null) ?? [],
      overrides: (overrides as HomeView["overrides"] | null) ?? {},
    });
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the server's house state once per environment
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect, react/exhaustive-effect-dependencies -- refresh closes over this environment only
    void refresh();
  }, [environmentId]);

  const run = async (
    command: typeof act,
    op: string,
    args: Record<string, unknown>,
    done: (value: unknown) => string,
  ) => {
    if (busy) return;
    setBusy(true);
    setNote("");
    const result = await command({ environmentId, input: { op, args } });
    const reply: BatonHomeCallResult | null = result._tag === "Success" ? result.value : null;
    setNote(
      reply === null
        ? "Couldn’t reach this environment. Try again."
        : reply.ok
          ? done(reply.value)
          : (reply.error ?? "That was not done."),
    );
    setBusy(false);
    await refresh();
  };
  const lineOf = (v: unknown) =>
    typeof v === "object" && v !== null && "line" in v
      ? String((v as { line: unknown }).line)
      : "Done.";
  const status = view.status;
  const connected = status !== null && status.state !== "off";
  const mine = view.automations.filter((a) => a.mine);
  const his = view.automations.filter((a) => !a.mine);
  const prefix = label === null ? "" : `${label} · `;

  return (
    <>
      <SettingsSection title={`${prefix}Home Assistant`}>
        <Row
          title="Home Assistant"
          description={homeStatusLine(status)}
          trailing={
            connected ? (
              <ControlPill
                variant="pill"
                label="Disconnect"
                disabled={busy}
                onPress={() =>
                  void run(act, "disconnect", {}, () => "Disconnected. The token was removed.")
                }
              />
            ) : null
          }
        />
        <View className="gap-2 border-t border-border-subtle px-4 py-3">
          <Text textRole="footnote" className="text-foreground-muted">
            Home Assistant’s address from this server, and a second route to the same house if you
            have one. The token is a long-lived access token of an administrator (Home Assistant →
            Profile → Security).
          </Text>
          <TextInput
            accessibilityLabel="Home Assistant address"
            className={INPUT_CLASS}
            placeholderTextColorClassName="accent-foreground-muted"
            placeholder="http://homeassistant.local:8123"
            keyboardType="url"
            autoCapitalize="none"
            autoCorrect={false}
            editable={!busy}
            value={url}
            onChangeText={setUrl}
          />
          <TextInput
            accessibilityLabel="Second address (optional)"
            className={INPUT_CLASS}
            placeholderTextColorClassName="accent-foreground-muted"
            placeholder="Second address (optional)"
            keyboardType="url"
            autoCapitalize="none"
            autoCorrect={false}
            editable={!busy}
            value={fallback}
            onChangeText={setFallback}
          />
          <TextInput
            accessibilityLabel="Access token"
            className={INPUT_CLASS}
            placeholderTextColorClassName="accent-foreground-muted"
            placeholder={connected ? "Saved. Enter a new token to replace it." : "Access token"}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            editable={!busy}
            value={token}
            onChangeText={setToken}
          />
          <View className="flex-row">
            <ControlPill
              variant="primary"
              label={connected ? "Replace and test" : "Connect and test"}
              disabled={busy || url.trim() === "" || token.trim() === ""}
              onPress={() =>
                void run(
                  act,
                  "connect",
                  {
                    url: url.trim(),
                    token: token.trim(),
                    ...(fallback.trim() === "" ? {} : { fallbackUrl: fallback.trim() }),
                  },
                  (v) => {
                    setToken("");
                    return homeStatusLine(v as HomeStatus);
                  },
                )
              }
            />
          </View>
          {note === "" ? null : (
            <Text accessibilityLiveRegion="polite" className="text-sm text-foreground-muted">
              {note}
            </Text>
          )}
        </View>
      </SettingsSection>

      {view.pending.length === 0 ? null : (
        <SettingsSection title={`${prefix}Waiting for your yes`}>
          {view.pending.map((row, index) => (
            <Row
              key={row.id}
              divider={index > 0}
              title={row.line}
              description={`${row.why} · ${actionLine(row)}`}
              trailing={
                <>
                  <ControlPill
                    variant="primary"
                    label="Yes, do it"
                    disabled={busy}
                    onPress={() => void run(answer, "answer", { id: row.id, yes: true }, lineOf)}
                  />
                  <ControlPill
                    variant="pill"
                    label="No"
                    disabled={busy}
                    onPress={() => void run(answer, "answer", { id: row.id, yes: false }, lineOf)}
                  />
                </>
              }
            />
          ))}
        </SettingsSection>
      )}

      {connected ? (
        <SettingsSection title={`${prefix}Tessaya’s automations`}>
          {mine.length === 0 ? (
            <Text className="p-4 text-foreground-muted">She hasn’t made any yet.</Text>
          ) : (
            mine.map((row, index) => (
              <Row
                key={row.id}
                divider={index > 0}
                title={row.alias}
                description={`${automationLine(row)}${row.request === null || row.request === "" ? "" : ` · “${row.request}”`}`}
                trailing={automationActions(row).map((op) => (
                  <ControlPill
                    key={op}
                    variant={op === "delete" ? "danger" : "pill"}
                    label={OP_TEXT[op]}
                    disabled={busy}
                    onPress={() =>
                      void run(
                        act,
                        op === "undo" ? "undo" : "automationSet",
                        op === "undo" ? { id: row.id } : { id: row.id, op },
                        lineOf,
                      )
                    }
                  />
                ))}
              />
            ))
          )}
          {his.length === 0 ? null : (
            <Row
              divider
              title="Your own automations"
              description={`${his.length} in Home Assistant. Tessaya asks before changing any of them.`}
            />
          )}
        </SettingsSection>
      ) : null}

      {connected ? (
        <SettingsSection title={`${prefix}Recent home actions`}>
          {view.actions.length === 0 ? (
            <Text className="p-4 text-foreground-muted">Nothing yet.</Text>
          ) : (
            view.actions.map((row, index) => (
              <Row
                key={row.id}
                divider={index > 0}
                title={row.line}
                description={actionLine(row)}
                trailing={
                  row.canUndo ? (
                    <ControlPill
                      variant="pill"
                      label="Undo"
                      disabled={busy}
                      onPress={() => void run(act, "undo", { id: row.id }, lineOf)}
                    />
                  ) : null
                }
              />
            ))
          )}
        </SettingsSection>
      ) : null}

      {connected ? (
        <SettingsSection title={`${prefix}Asks first`}>
          <View className="gap-2 px-4 py-3">
            <Text textRole="footnote" className="text-foreground-muted">
              Lights, fans, media and harmless switches she just does. Locks, the alarm, sirens,
              garage and doors, cameras, pumps, heaters and ovens, heating outside 16–28 °C, more
              than five devices at once and restarting Home Assistant ask you first. Some things she
              never does. Change one device here by its entity id.
            </Text>
            <TextInput
              accessibilityLabel="Entity id"
              className={INPUT_CLASS}
              placeholderTextColorClassName="accent-foreground-muted"
              placeholder="switch.study_heater"
              autoCapitalize="none"
              autoCorrect={false}
              editable={!busy}
              value={entity}
              onChangeText={setEntity}
            />
            <View className="flex-row flex-wrap gap-2">
              {TIERS.map((tier) => (
                <ControlPill
                  key={tier}
                  variant="pill"
                  label={TIER_TEXT[tier]}
                  disabled={busy || entity.trim() === ""}
                  onPress={() =>
                    void run(act, "override", { entityId: entity.trim(), tier }, () => "Saved.")
                  }
                />
              ))}
            </View>
          </View>
          {Object.entries(view.overrides).map(([entityId, tier]) => (
            <Row
              key={entityId}
              divider
              title={entityId}
              description={TIER_TEXT[tier]}
              trailing={
                <Menu
                  accessible
                  accessibilityRole="button"
                  accessibilityLabel={`${entityId} tier`}
                  title={entityId}
                  actions={[
                    ...TIERS.map((next) => ({
                      id: next,
                      title: TIER_TEXT[next],
                      state: next === tier ? ("on" as const) : ("off" as const),
                      attributes: { disabled: busy },
                    })),
                    { id: "reset", title: "Reset to default", attributes: { disabled: busy } },
                  ]}
                  onPressAction={({ nativeEvent }) => {
                    const next = nativeEvent.event;
                    if (next === "reset")
                      void run(
                        act,
                        "override",
                        { entityId, tier: null },
                        () => "Back to the default.",
                      );
                    else if (next !== tier && TIERS.some((t) => t === next))
                      void run(act, "override", { entityId, tier: next }, () => "Saved.");
                  }}
                >
                  <ControlPill icon="ellipsis" accessibilityLabel={`${entityId} tier`} />
                </Menu>
              }
            />
          ))}
        </SettingsSection>
      ) : null}
    </>
  );
}

function Row(props: {
  readonly title: string;
  readonly description: string;
  readonly trailing?: ReactNode;
  readonly divider?: boolean;
}) {
  return (
    <View
      className={
        props.divider
          ? "min-h-16 gap-3 border-t border-border-subtle px-4 py-3"
          : "min-h-16 gap-3 px-4 py-3"
      }
    >
      <View accessible className="min-w-0 gap-0.5">
        <Text textRole="body" className="text-foreground">
          {props.title}
        </Text>
        <Text textRole="footnote" className="text-foreground-muted">
          {props.description}
        </Text>
      </View>
      {props.trailing ? <View className="flex-row flex-wrap gap-2">{props.trailing}</View> : null}
    </View>
  );
}
