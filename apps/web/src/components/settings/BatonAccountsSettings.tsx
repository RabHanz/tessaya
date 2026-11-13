/**
 * Settings → Accounts & providers (ACCOUNTS-4): one card per real account above T3's own provider list, merged by
 * email. Pausing, signing in and removing stay on the provider instance below, which "Open" selects.
 */
import { maskedEmail, roomDetail, roomTone } from "@t3tools/baton-shared/accountRoom";
import { pickModelFor } from "@t3tools/baton-shared/accounts";
import { createModelSelection } from "@t3tools/shared/model";
import type { BatonAccountRecord, BatonSignInMethod } from "@t3tools/baton-contracts";
import {
  type EnvironmentId,
  PROVIDER_DISPLAY_NAMES,
  ProviderInstanceId,
  type ProviderDriverKind,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";

import { useNowMinute } from "../../hooks/useNowMinute";
import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { useEnvironmentProviders } from "../../state/environments";
import { useBatonAccounts } from "../../state/batonAccounts";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Radio, RadioGroup } from "../ui/radio-group";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const METHOD_TEXT: Record<BatonSignInMethod["kind"], { badge: string; detail: string }> = {
  "setup-token": { badge: "token", detail: "Long-lived token" },
  browser: { badge: "browser", detail: "Browser sign-in" },
  "api-key": { badge: "API key", detail: "API key" },
};

const HEALTH_TEXT = {
  ok: "Working",
  "signed-out": "Signed out · sign in again on its provider below",
  paused: "Paused by you · threads won't use it",
  error: "Not working",
} as const;

const methodLine = (account: BatonAccountRecord, method: BatonSignInMethod) =>
  [
    METHOD_TEXT[method.kind].detail,
    method.instanceId !== null && method.instanceId === account.driver
      ? "this machine's default login"
      : null,
    method.liveSwitch ? "used for live switching" : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");

function AccountCard(props: {
  readonly account: BatonAccountRecord;
  readonly environmentId: EnvironmentId;
}) {
  const { account } = props;
  const now = Date.parse(`${useNowMinute()}:00Z`);
  const navigate = useNavigate();
  const room = roomDetail(account, now);
  const tone = roomTone(account);
  const instanceId = account.instanceIds[0];
  return (
    <SettingsGroup data-testid="settings-account">
      <SettingsRow
        title={
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <span className="truncate">{account.label}</span>
            {account.methods.map((method) => (
              <Badge key={method.kind} size="sm" variant="outline">
                {METHOD_TEXT[method.kind].badge}
              </Badge>
            ))}
            {account.isDefault ? (
              <Badge size="sm" variant="secondary">
                Default
              </Badge>
            ) : null}
            {account.health === "paused" ? (
              <Badge size="sm" variant="warning">
                Paused
              </Badge>
            ) : null}
          </span>
        }
        description={[
          account.email === null ? null : maskedEmail(account.email),
          account.instanceIds.length > 1
            ? `Merged ${account.instanceIds.length} logins with this email`
            : null,
        ]
          .filter((part) => part !== null)
          .join(" · ")}
        control={
          instanceId === undefined ? null : (
            <Button
              size="xs"
              variant="outline"
              onClick={() =>
                void navigate({
                  to: "/settings/providers",
                  search: {
                    environmentId: props.environmentId,
                    instanceId: ProviderInstanceId.make(instanceId),
                  },
                })
              }
            >
              Open
            </Button>
          )
        }
      />
      <SettingsRow
        title="Sign-in methods"
        description={account.methods.map((method) => (
          <span key={method.kind} className="block">
            {METHOD_TEXT[method.kind].badge}: {methodLine(account, method)}
          </span>
        ))}
      />
      <SettingsRow
        title="Health"
        description={
          account.health === "error"
            ? (account.healthDetail ?? HEALTH_TEXT.error)
            : HEALTH_TEXT[account.health]
        }
      />
      {room.length === 0 ? null : (
        <SettingsRow
          title="Used"
          status={
            tone === "ok" ? null : (
              <Badge size="sm" variant={tone === "limit" ? "error" : "warning"}>
                {tone === "limit" ? "At limit" : "80% or more used"}
              </Badge>
            )
          }
          description={room.map((line) => (
            <span key={line} className="block">
              {line}
            </span>
          ))}
        />
      )}
      <SettingsRow
        title="Switching"
        description={
          account.liveSwitchKey === null
            ? "Threads can move here; a terminal session cannot switch to it live"
            : "Threads and terminal sessions can switch to this account"
        }
      />
    </SettingsGroup>
  );
}

/** Which account new threads start on: T3's own default model setting, put on that account's instance. */
function NewThreadDefaults(props: {
  readonly environmentId: EnvironmentId;
  readonly accounts: ReadonlyArray<BatonAccountRecord>;
}) {
  const current = useEnvironmentSettings(
    props.environmentId,
    (settings) => settings.defaultModelSelection,
  );
  const updateSettings = useUpdateEnvironmentSettings(props.environmentId);
  const where = useEnvironmentSettings(props.environmentId, (settings) => settings.newSessionsRun);
  const providers = useEnvironmentProviders().get(props.environmentId) ?? [];
  const usable = props.accounts.filter(
    (account) => account.instanceIds.length > 0 && account.health !== "paused",
  );
  const selected =
    current === null
      ? null
      : (usable.find((account) => account.instanceIds.includes(current.instanceId)) ?? null);
  const choose = (id: string | null) => {
    const account = usable.find((candidate) => candidate.id === id);
    if (account === undefined) {
      updateSettings({ defaultModelSelection: null });
      return;
    }
    const instanceId =
      account.methods.find((method) => method.liveSwitch)?.instanceId ?? account.instanceIds[0]!;
    const target = providers.find((provider) => provider.instanceId === instanceId);
    if (target === undefined) return;
    const model = pickModelFor(
      { driverKind: target.driver, models: target.models },
      current === null
        ? ""
        : (providers.find((provider) => provider.instanceId === current.instanceId)?.driver ?? ""),
      current?.model ?? "",
    );
    updateSettings({
      defaultModelSelection: createModelSelection(ProviderInstanceId.make(instanceId), model),
    });
  };
  return (
    <SettingsSection title="Defaults for new threads">
      <SettingsGroup>
        <SettingsRow
          title="Account"
          description="New threads start on this account and its provider. Automatic uses T3's own default."
          control={
            <Select value={selected?.id ?? "automatic"} onValueChange={(value) => choose(value)}>
              <SelectTrigger size="sm" aria-label="Account for new threads">
                <SelectValue>
                  {(value: string | null) =>
                    usable.find((account) => account.id === value)?.label ?? "Automatic"
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem value="automatic">Automatic</SelectItem>
                {usable.map((account) => (
                  <SelectItem key={account.id} value={account.id}>
                    {PROVIDER_DISPLAY_NAMES[account.driver as ProviderDriverKind] ?? account.driver}{" "}
                    · {account.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          title="Where new sessions run"
          description="A new session from the sessions list. One started in a Herdr pane shows up under Terminal either way."
          control={
            <RadioGroup
              value={where ?? "tessaya"}
              onValueChange={(value) =>
                updateSettings({ newSessionsRun: value === "terminal" ? "terminal" : "tessaya" })
              }
              aria-label="Where new sessions run"
            >
              <label className="flex items-center gap-2 text-sm">
                <Radio value="tessaya" />
                In Tessaya (recommended)
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Radio value="terminal" />
                In a terminal
              </label>
            </RadioGroup>
          }
        />
      </SettingsGroup>
    </SettingsSection>
  );
}

/** How the two kinds of session differ, for the picker's Terminal group. */
function TerminalSessionsExplainer() {
  return (
    <SettingsSection title="Terminal sessions">
      <SettingsGroup>
        <SettingsRow
          title="Tessaya"
          description="Runs inside Tessaya. Full history, account switching and handover."
        />
        <SettingsRow
          title="Terminal"
          description="Runs in a terminal pane. Tessaya types into it and reads it; it switches accounts while it runs, and a model or effort change waits until it is idle."
        />
      </SettingsGroup>
    </SettingsSection>
  );
}

/** The accounts on this environment, by provider, before T3's own provider list. */
export function BatonAccountsSettings(props: { readonly environmentId: EnvironmentId }) {
  const accounts = useBatonAccounts(props.environmentId);
  if (accounts.length === 0) return null;
  const drivers = [...new Set(accounts.map((account) => account.driver))];
  return (
    <>
      <NewThreadDefaults environmentId={props.environmentId} accounts={accounts} />
      <TerminalSessionsExplainer />
      {drivers.map((driver) => (
        <SettingsSection
          key={driver}
          title={`${PROVIDER_DISPLAY_NAMES[driver as ProviderDriverKind] ?? driver} accounts`}
        >
          {accounts
            .filter((account) => account.driver === driver)
            .map((account) => (
              <AccountCard key={account.id} account={account} environmentId={props.environmentId} />
            ))}
        </SettingsSection>
      ))}
    </>
  );
}
