/**
 * Settings → Accounts & providers (ACCOUNTS-4): one card per real account above T3's own provider list, merged by
 * email. Pausing, signing in and removing stay on the provider instance below, which "Open" selects.
 */
import { maskedEmail, roomDetail, roomTone } from "@t3tools/baton-shared/accountRoom";
import type { BatonAccountRecord, BatonSignInMethod } from "@t3tools/baton-contracts";
import {
  type EnvironmentId,
  PROVIDER_DISPLAY_NAMES,
  type ProviderDriverKind,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";

import { useNowMinute } from "../../hooks/useNowMinute";
import { useBatonAccounts } from "../chat/BatonPickerAccount";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
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
                  search: { environmentId: props.environmentId, instanceId },
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

/** The accounts on this environment, by provider, before T3's own provider list. */
export function BatonAccountsSettings(props: { readonly environmentId: EnvironmentId }) {
  const accounts = useBatonAccounts(props.environmentId);
  if (accounts.length === 0) return null;
  const drivers = [...new Set(accounts.map((account) => account.driver))];
  return (
    <>
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
