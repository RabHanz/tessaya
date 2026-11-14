/**
 * "Use on this machine" in a limits tile (D94). His terminal sessions run on cswap's machine
 * login, which T3 threads do not need since L-76; this goes when terminal sessions resume natively.
 * cswap is per machine, so a tile merged across environments gets a row for each.
 */
import { useAtomValue } from "@effect/atom-react";
import type { BatonAccount } from "@t3tools/tessaya-contracts";
import type { EnvironmentId } from "@t3tools/contracts";
import type { LimitAccount } from "@t3tools/shared/usageLimits";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";

import { batonWorkSessions } from "../../state/batonWorkSessions";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

function useAccountSwitch(environmentId: EnvironmentId) {
  const use = useAtomCommand(batonWorkSessions.accountUse, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const switchTo = (account: BatonAccount) => {
    setBusy(true);
    void use({ environmentId, input: { key: account.key, reason: "manual" } }).then((result) => {
      setBusy(false);
      toastManager.add(
        result._tag === "Success"
          ? {
              type: "success",
              title: `This machine now runs as ${account.label}`,
              description: machineSwitchDetail(result.value.sessions),
            }
          : { type: "error", title: `Could not switch to ${account.label}` },
      );
    });
  };
  return { busy, switchTo };
}

/** What moved with the machine login: sessions on it follow at once, those in their own dirs were moved. */
const machineSwitchDetail = (sessions?: { readonly switched: number; readonly failed: number }) =>
  [
    "Its Claude login and the sessions on it.",
    sessions === undefined || sessions.switched === 0
      ? null
      : `${sessions.switched} session${sessions.switched === 1 ? "" : "s"} with their own login moved too.`,
    sessions === undefined || sessions.failed === 0 ? null : `${sessions.failed} did not move.`,
  ]
    .filter(Boolean)
    .join(" ");

function blockedReason(account: BatonAccount): string | null {
  if (account.active) return "In use";
  if (account.headroomPercent === 0) return "Spent";
  if (account.unusableReason === "signed-out") return "Signed out";
  if (account.unusableReason === "disabled") return "Held out";
  return null;
}

function SwitchRow({
  environment,
  accountKey,
  showEnvironment,
}: {
  readonly environment: LimitAccount["environments"][number];
  readonly accountKey: string;
  readonly showEnvironment: boolean;
}) {
  const pool = useAtomValue(
    batonWorkSessions.accountPoolQuery({ environmentId: environment.environmentId, input: {} }),
  );
  const { busy, switchTo } = useAccountSwitch(environment.environmentId);
  const accounts = Option.getOrNull(AsyncResult.value(pool))?.accounts ?? [];
  const target = accounts.find((account) => account.key === accountKey);
  if (target === undefined) return null;
  const blocked = blockedReason(target);
  return (
    <span className="flex min-h-6 items-center gap-2 text-muted-foreground">
      <span className="min-w-0 truncate">
        {[showEnvironment ? environment.label : null, blocked].filter(Boolean).join(" · ")}
      </span>
      <Button
        size="xs"
        variant="outline"
        className="ms-auto shrink-0"
        disabled={busy || blocked !== null}
        data-testid="tile-switch-account"
        onClick={() => switchTo(target)}
      >
        Use on this machine
      </Button>
    </span>
  );
}

/** The same switch on every paired machine that has this login, each through its own environment's command. */
function UseEverywhere(props: {
  readonly environments: LimitAccount["environments"];
  readonly accountKey: string;
  readonly email: string | undefined;
  readonly label: string;
}) {
  const use = useAtomCommand(batonWorkSessions.accountUse, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const switchAll = () => {
    setBusy(true);
    void Promise.all(
      props.environments.map((environment) =>
        use({
          environmentId: environment.environmentId,
          input: {
            key: props.accountKey,
            reason: "manual",
            ...(props.email === undefined ? {} : { email: props.email }),
          },
        }).then((result) => (result._tag === "Success" ? null : environment.label)),
      ),
    ).then((missed) => {
      setBusy(false);
      const failed = missed.filter((label) => label !== null);
      toastManager.add(
        failed.length === 0
          ? { type: "success", title: `Every machine now runs as ${props.label}` }
          : {
              type: "warning",
              title: `${props.label} on ${props.environments.length - failed.length} of ${props.environments.length} machines`,
              description: `Not switched: ${failed.join(", ")}`,
            },
      );
    });
  };
  return (
    <Button
      size="xs"
      variant="outline"
      className="self-end"
      disabled={busy}
      data-testid="tile-switch-account-everywhere"
      onClick={switchAll}
    >
      Use on every machine
    </Button>
  );
}

export function BatonTileSwitch({ account }: { readonly account: LimitAccount }) {
  const accountKey = account.limits.credentialFingerprint;
  if (account.driver !== "claudeAgent" || accountKey === undefined) return null;
  return (
    <div className="flex flex-col gap-1 border-t border-border/60 pt-2.5">
      {account.environments.map((environment) => (
        <SwitchRow
          key={environment.environmentId}
          environment={environment}
          accountKey={accountKey}
          showEnvironment={account.environments.length > 1}
        />
      ))}
      {account.environments.length > 1 ? (
        <UseEverywhere
          environments={account.environments}
          accountKey={accountKey}
          email={account.email}
          label={account.displayName ?? account.email ?? "this login"}
        />
      ) : null}
    </div>
  );
}
