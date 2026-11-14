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

type Machine = { readonly environmentId: EnvironmentId; readonly label: string };
type Login = { readonly key: string; readonly email?: string | null; readonly label: string };

/** A Claude login on the named machines, each through its own environment's command, with one toast for all. */
export function useLoginOnMachines() {
  const use = useAtomCommand(batonWorkSessions.accountUse, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const switchOn = (machines: ReadonlyArray<Machine>, login: Login) => {
    setBusy(true);
    void Promise.all(
      machines.map((machine) =>
        use({
          environmentId: machine.environmentId,
          input: {
            key: login.key,
            reason: "manual",
            ...(login.email ? { email: login.email } : {}),
          },
        }).then((result) => (result._tag === "Success" ? result.value.sessions : machine.label)),
      ),
    ).then((results) => {
      setBusy(false);
      const failed = results.filter((result) => typeof result === "string");
      const [only] = results;
      if (failed.length === 0)
        toastManager.add({
          type: "success",
          title:
            results.length === 1
              ? `${machines[0]!.label} now runs as ${login.label}`
              : `${results.length} machines now run as ${login.label}`,
          ...(results.length === 1 && typeof only !== "string"
            ? { description: machineSwitchDetail(only) }
            : {}),
        });
      else if (results.length === 1)
        toastManager.add({ type: "error", title: `Could not switch to ${login.label}` });
      else
        toastManager.add({
          type: "warning",
          title: `${login.label} on ${results.length - failed.length} of ${results.length} machines`,
          description: `Not switched: ${failed.join(", ")}`,
        });
    });
  };
  return { busy, switchOn };
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
  const { busy, switchOn } = useLoginOnMachines();
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
        onClick={() => switchOn([environment], target)}
      >
        Use on this machine
      </Button>
    </span>
  );
}

/** The same switch on every paired machine that has this login. */
function UseEverywhere(props: {
  readonly environments: LimitAccount["environments"];
  readonly accountKey: string;
  readonly email: string | undefined;
  readonly label: string;
}) {
  const { busy, switchOn } = useLoginOnMachines();
  return (
    <Button
      size="xs"
      variant="outline"
      className="self-end"
      disabled={busy}
      data-testid="tile-switch-account-everywhere"
      onClick={() =>
        switchOn(props.environments, {
          key: props.accountKey,
          email: props.email ?? null,
          label: props.label,
        })
      }
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
