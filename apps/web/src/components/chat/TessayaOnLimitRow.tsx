/**
 * Whether working threads move to another Claude account at the limit (L-76), per environment: the
 * setting lives on each server, so a page showing two environments gets a switch for each.
 */
import { useAtomValue } from "@effect/atom-react";
import type { TessayaOnLimitSetting } from "@t3tools/tessaya-contracts";
import type { LimitPool } from "@t3tools/shared/usageLimits";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";

import { tessayaWorkSessions } from "../../state/tessayaWorkSessions";
import { useAtomCommand } from "../../state/use-atom-command";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";

type Environment = LimitPool["accounts"][number]["environments"][number];

function OnLimitSwitch({
  environment,
  showEnvironment,
}: {
  readonly environment: Environment;
  readonly showEnvironment: boolean;
}) {
  const query = useAtomValue(
    tessayaWorkSessions.onLimitQuery({ environmentId: environment.environmentId, input: {} }),
  );
  const set = useAtomCommand(tessayaWorkSessions.setOnLimit, { reportFailure: false });
  const [chosen, setChosen] = useState<TessayaOnLimitSetting | null>(null);
  const [busy, setBusy] = useState(false);
  const stored = Option.getOrNull(AsyncResult.value(query))?.policy ?? null;
  // An older server has no such setting, and gets no switch.
  if (stored === null) return null;
  const policy = chosen ?? stored;
  const change = (on: boolean) => {
    setBusy(true);
    void set({
      environmentId: environment.environmentId,
      input: { policy: on ? "auto" : "ask" },
    }).then((result) => {
      setBusy(false);
      if (result._tag === "Success") setChosen(result.value.policy);
      else toastManager.add({ type: "error", title: "Could not change the setting" });
    });
  };
  return (
    <label className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
      <span>
        Move working threads to the Claude account with the most room at the limit
        {showEnvironment ? ` (${environment.label})` : ""}
      </span>
      <Switch
        checked={policy === "auto"}
        disabled={busy}
        onCheckedChange={(checked) => change(Boolean(checked))}
      />
    </label>
  );
}

export function TessayaOnLimitRow({ pool }: { readonly pool: LimitPool }) {
  if (pool.driver !== "claudeAgent") return null;
  const environments = [
    ...new Map(
      pool.accounts
        .flatMap((account) => account.environments)
        .map((environment) => [environment.environmentId, environment]),
    ).values(),
  ];
  return (
    <div className="flex flex-col gap-2">
      {environments.map((environment) => (
        <OnLimitSwitch
          key={environment.environmentId}
          environment={environment}
          showEnvironment={environments.length > 1}
        />
      ))}
    </div>
  );
}
