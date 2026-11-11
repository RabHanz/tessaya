/**
 * Settings → Home: connect Tessaya to Home Assistant (the token goes into the server's secret store and never comes
 * back), see what she made and did there, and undo it; answer what waits for a yes; move a device up or down a tier.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import type {
  BatonHomeCallResult,
  HomeActionRow,
  HomeAutomationRow,
  HomeStatus,
} from "@t3tools/baton-contracts";
import {
  actionLine,
  automationActions,
  automationLine,
  homeStatusLine,
} from "@t3tools/baton-shared/homeView";
import { useEffect, useState } from "react";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { batonWorkSessions } from "../../state/batonWorkSessions";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SecretInput } from "./SecretInput";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";

interface HomeView {
  readonly status: HomeStatus | null;
  readonly automations: ReadonlyArray<HomeAutomationRow>;
  readonly actions: ReadonlyArray<HomeActionRow>;
  readonly pending: ReadonlyArray<HomeActionRow>;
  readonly overrides: Readonly<Record<string, "auto" | "ask" | "never">>;
}
const EMPTY: HomeView = { status: null, automations: [], actions: [], pending: [], overrides: {} };
const TIER_TEXT = { auto: "Does it", ask: "Asks first", never: "Never" } as const;

export function HomeSettingsPanel() {
  const { environment } = useSettingsScope();
  return (
    <SettingsPageContainer>
      {environment?.connection.phase === "connected" ? (
        <HomeSections key={environment.environmentId} environmentId={environment.environmentId} />
      ) : (
        <p className="px-4 py-3 text-sm text-muted-foreground">
          Connect an environment to set up Home.
        </p>
      )}
    </SettingsPageContainer>
  );
}

function HomeSections({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const quiet = { reportFailure: false } as const;
  const homeCall = useAtomCommand(batonWorkSessions.homeCall, quiet);
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
    // oxlint-disable-next-line react/set-state-in-effect, react/exhaustive-effect-dependencies -- one read of the server's house state per environment; refresh closes over it
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

  return (
    <>
      <SettingsSection {...searchableSetting("home-assistant")}>
        <SettingsRow
          title="Home Assistant"
          description={homeStatusLine(status)}
          control={
            connected ? (
              <Button
                size="xs"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void run(act, "disconnect", {}, () => "Disconnected. The token was removed.")
                }
              >
                Disconnect
              </Button>
            ) : null
          }
        />
        <SettingsRow
          title="Address"
          description="Home Assistant's address from this server, a second route to it if you have one, and an administrator's long-lived access token (Profile → Security)."
        >
          <div className="flex flex-col gap-2 pt-2">
            <Input
              value={url}
              placeholder="http://homeassistant.local:8123"
              onChange={(e) => setUrl(e.target.value)}
            />
            <Input
              value={fallback}
              placeholder="Second address (optional)"
              onChange={(e) => setFallback(e.target.value)}
            />
            <SecretInput
              configured={connected}
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
            <div>
              <Button
                size="xs"
                disabled={busy || url.trim() === "" || token.trim() === ""}
                onClick={() =>
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
              >
                {connected ? "Replace and test" : "Connect and test"}
              </Button>
            </div>
          </div>
        </SettingsRow>
        {note === "" ? null : <p className="px-4 pb-3 text-sm text-muted-foreground">{note}</p>}
      </SettingsSection>

      {view.pending.length === 0 ? null : (
        <SettingsSection title="Waiting for your yes">
          {view.pending.map((row) => (
            <SettingsRow
              key={row.id}
              title={row.line}
              description={`${row.why} · ${actionLine(row)}`}
              control={
                <span className="flex gap-1.5">
                  <Button
                    size="xs"
                    disabled={busy}
                    onClick={() => void run(answer, "answer", { id: row.id, yes: true }, lineOf)}
                  >
                    Yes, do it
                  </Button>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void run(answer, "answer", { id: row.id, yes: false }, lineOf)}
                  >
                    No
                  </Button>
                </span>
              }
            />
          ))}
        </SettingsSection>
      )}

      {connected ? (
        <SettingsSection title="Tessaya’s automations">
          {mine.length === 0 ? (
            <p className="px-4 py-3 text-sm text-muted-foreground">She hasn’t made any yet.</p>
          ) : (
            mine.map((row) => (
              <SettingsRow
                key={row.id}
                title={row.alias}
                description={`${automationLine(row)}${row.request === null || row.request === "" ? "" : ` · “${row.request}”`}`}
                control={
                  <span className="flex gap-1.5">
                    {automationActions(row).map((op) => (
                      <Button
                        key={op}
                        size="xs"
                        variant="outline"
                        disabled={busy}
                        onClick={() =>
                          void run(
                            act,
                            op === "undo" ? "undo" : "automationSet",
                            op === "undo" ? { id: row.id } : { id: row.id, op },
                            lineOf,
                          )
                        }
                      >
                        {op === "pause"
                          ? "Pause"
                          : op === "resume"
                            ? "Resume"
                            : op === "delete"
                              ? "Delete"
                              : "Undo delete"}
                      </Button>
                    ))}
                  </span>
                }
              />
            ))
          )}
          {his.length === 0 ? null : (
            <SettingsRow
              title="Your own automations"
              description={`${his.length} in Home Assistant. Tessaya asks before changing any of them.`}
            />
          )}
        </SettingsSection>
      ) : null}

      {connected ? (
        <SettingsSection title="Recent home actions">
          {view.actions.length === 0 ? (
            <p className="px-4 py-3 text-sm text-muted-foreground">Nothing yet.</p>
          ) : (
            view.actions.map((row) => (
              <SettingsRow
                key={row.id}
                title={row.line}
                description={actionLine(row)}
                control={
                  row.canUndo ? (
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={busy}
                      onClick={() => void run(act, "undo", { id: row.id }, lineOf)}
                    >
                      Undo
                    </Button>
                  ) : null
                }
              />
            ))
          )}
        </SettingsSection>
      ) : null}

      {connected ? (
        <SettingsSection title="Asks first">
          <SettingsRow
            title="What she does by herself"
            description="Lights, fans and media she just does. Locks, alarm, doors, cameras, pumps, heaters, heating outside 16–28 °C and big changes ask you first. Set one device by its entity id."
          >
            <div className="flex gap-2 pt-2">
              <Input
                value={entity}
                placeholder="switch.study_heater"
                onChange={(e) => setEntity(e.target.value)}
              />
              {(["auto", "ask", "never"] as const).map((tier) => (
                <Button
                  key={tier}
                  size="xs"
                  variant="outline"
                  disabled={busy || entity.trim() === ""}
                  onClick={() =>
                    void run(act, "override", { entityId: entity.trim(), tier }, () => "Saved.")
                  }
                >
                  {TIER_TEXT[tier]}
                </Button>
              ))}
            </div>
          </SettingsRow>
          {Object.entries(view.overrides).map(([entityId, tier]) => (
            <SettingsRow
              key={entityId}
              title={entityId}
              description={TIER_TEXT[tier]}
              resetAction={
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    void run(
                      act,
                      "override",
                      { entityId, tier: null },
                      () => "Back to the default.",
                    )
                  }
                >
                  Reset
                </Button>
              }
              control={
                <Select
                  value={tier}
                  onValueChange={(next) =>
                    void run(act, "override", { entityId, tier: next }, () => "Saved.")
                  }
                >
                  <SelectTrigger size="sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value="auto">Does it</SelectItem>
                    <SelectItem value="ask">Asks first</SelectItem>
                    <SelectItem value="never">Never</SelectItem>
                  </SelectPopup>
                </Select>
              }
            />
          ))}
        </SettingsSection>
      ) : null}
      <RoomBrainSection environmentId={environmentId} />
    </>
  );
}

const ROOM_BRAIN_LABELS = {
  auto: "Automatic",
  api: "Anthropic API key",
  subscription: "Claude subscription",
} as const;

/** How the R1's turns reach Claude; it applies from the next turn, with no restart. */
function RoomBrainSection({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const roomBrain = useEnvironmentSettings(environmentId, (settings) => settings.roomBrain);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  return (
    <SettingsSection title="The R1 desk device">
      <SettingsRow
        {...searchableSetting("room-brain")}
        title="Room brain"
        description="Automatic uses your Anthropic key from Settings → APIs for the quickest answers, and your Claude subscription if the key fails. Changes apply from the next thing you say."
        control={
          <Select
            value={roomBrain ?? "auto"}
            onValueChange={(value) =>
              updateSettings({
                roomBrain: value === "api" || value === "subscription" ? value : "auto",
              })
            }
          >
            <SelectTrigger size="sm" aria-label="Room brain">
              <SelectValue>
                {(value: string | null) =>
                  ROOM_BRAIN_LABELS[(value ?? "auto") as keyof typeof ROOM_BRAIN_LABELS]
                }
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {(["auto", "api", "subscription"] as const).map((way) => (
                <SelectItem key={way} value={way}>
                  {ROOM_BRAIN_LABELS[way]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
    </SettingsSection>
  );
}
