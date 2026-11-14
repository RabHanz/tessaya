/**
 * One level under a picker account row (B-032): the row's tap moves this thread; this moves every session on this
 * machine, on the machines he ticks, or on every paired machine that has the same login.
 */
import { useAtomValue } from "@effect/atom-react";
import type { TessayaAccountRecord } from "@t3tools/tessaya-contracts";
import { machinesWithLogin } from "@t3tools/tessaya-shared/accounts";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom, AsyncResult } from "effect/reactivity";
import { ChevronDownIcon } from "lucide-react";
import { useState } from "react";

import { tessayaWorkSessions } from "../../state/tessayaWorkSessions";
import { useEnvironments } from "../../state/environments";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { useLoginOnMachines } from "./TessayaTileSwitch";

/** Each machine's logins, read only while the panel is open. */
const machineLoginsAtom = Atom.family((ids: string) =>
  Atom.make((get) =>
    (JSON.parse(ids) as ReadonlyArray<EnvironmentId>).map(
      (environmentId) =>
        [
          environmentId,
          Option.getOrNull(
            AsyncResult.value(get(tessayaWorkSessions.accountsQuery({ environmentId, input: {} }))),
          )?.accounts ?? [],
        ] as const,
    ),
  ).pipe(Atom.withLabel(`baton-machine-logins:${ids}`)),
);

function useMachinesWithLogin(account: TessayaAccountRecord, here: EnvironmentId) {
  const { environments } = useEnvironments();
  const machines = environments.map(({ environmentId, label }) => ({ environmentId, label }));
  const others = machines.filter((machine) => machine.environmentId !== here);
  const logins = new Map(
    useAtomValue(machineLoginsAtom(JSON.stringify(others.map((machine) => machine.environmentId)))),
  );
  return machinesWithLogin(
    machines.find((machine) => machine.environmentId === here) ?? {
      environmentId: here,
      label: "This machine",
    },
    others,
    (machine) => logins.get(machine.environmentId) ?? [],
    account.email,
  );
}

function ReachPanel(props: {
  readonly account: TessayaAccountRecord;
  readonly loginKey: string;
  readonly environmentId: EnvironmentId;
}) {
  const machines = useMachinesWithLogin(props.account, props.environmentId);
  const { busy, switchOn } = useLoginOnMachines();
  const [chosen, setChosen] = useState<ReadonlySet<EnvironmentId> | null>(null);
  const login = { key: props.loginKey, email: props.account.email, label: props.account.label };
  const picked = machines.filter((machine) => chosen?.has(machine.environmentId));
  const toggle = (environmentId: EnvironmentId, on: boolean) =>
    setChosen((previous) => {
      const next = new Set(previous);
      if (on) next.add(environmentId);
      else next.delete(environmentId);
      return next;
    });
  return (
    <div data-testid="account-reach" className="basis-full px-1.5 pb-1.5 text-2xs">
      <div className="flex flex-wrap items-center gap-1">
        <span className="me-auto text-muted-foreground">Every session on</span>
        <Button
          size="xs"
          variant="outline"
          disabled={busy || props.account.active === true}
          data-testid="account-reach-machine"
          onClick={() => switchOn(machines.slice(0, 1), login)}
        >
          {props.account.active === true ? "This machine ✓" : "This machine"}
        </Button>
        {machines.length > 1 ? (
          <>
            <Button
              size="xs"
              variant="outline"
              disabled={busy}
              data-testid="account-reach-all"
              onClick={() => switchOn(machines, login)}
            >
              All {machines.length}
            </Button>
            <Button
              size="xs"
              variant="ghost"
              aria-expanded={chosen !== null}
              data-testid="account-reach-choose"
              onClick={() => setChosen(chosen === null ? new Set() : null)}
            >
              Choose
            </Button>
          </>
        ) : null}
      </div>
      {chosen === null ? null : (
        <div className="mt-1 flex flex-col gap-0.5">
          {machines.map((machine) => (
            <label
              key={machine.environmentId}
              className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-0.5 hover:bg-accent"
            >
              <Checkbox
                checked={chosen.has(machine.environmentId)}
                onCheckedChange={(on) => toggle(machine.environmentId, on)}
              />
              <span className="min-w-0 truncate text-foreground">{machine.label}</span>
            </label>
          ))}
          <Button
            size="xs"
            variant="outline"
            className="self-end"
            disabled={busy || picked.length === 0}
            data-testid="account-reach-switch-chosen"
            onClick={() => switchOn(picked, login)}
          >
            {picked.length === 0 ? "Tick a machine" : `Switch ${picked.length}`}
          </Button>
        </div>
      )}
    </div>
  );
}

/** The row's trailing chevron and, opened, the machine choices; nothing for a login that can't move machines. */
export function TessayaAccountReach(props: {
  readonly account: TessayaAccountRecord;
  readonly environmentId: EnvironmentId | null;
}) {
  const [open, setOpen] = useState(false);
  const { account, environmentId } = props;
  if (account.driver !== "claudeAgent" || account.liveSwitchKey === null || environmentId === null)
    return null;
  return (
    <>
      <Button
        size="icon-tiny"
        variant="ghost"
        aria-expanded={open}
        aria-label={`Use ${account.label} on this machine or others`}
        data-testid="account-reach-toggle"
        onClick={() => setOpen(!open)}
      >
        <ChevronDownIcon className={open ? "rotate-180" : undefined} />
      </Button>
      {open ? (
        <ReachPanel
          account={account}
          loginKey={account.liveSwitchKey}
          environmentId={environmentId}
        />
      ) : null}
    </>
  );
}
