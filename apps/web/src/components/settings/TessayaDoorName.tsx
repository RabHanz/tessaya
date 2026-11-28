/**
 * A linked machine's name on the household's front door (TessayaDoor): shown only on the brain that is the door,
 * where naming a machine makes it reachable from anywhere at `<name>.<domain>`, and clearing it takes it off again.
 */
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { msg, useGT, useMessages } from "gt-react";
import { useState } from "react";

import { tessayaWorkSessions } from "../../state/tessayaWorkSessions";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";

const ERRORS = {
  "not-a-door": msg("This environment is not the household's door."),
  "invalid-name": msg("Use one word of letters, digits or dashes, not the door's own name."),
  taken: msg("Another machine already has that name."),
  "not-linked": msg("That machine is no longer linked here."),
} as const;

export function TessayaDoorName({
  environmentId,
  machineId,
}: {
  readonly environmentId: EnvironmentId;
  readonly machineId: EnvironmentId;
}) {
  const gt = useGT();
  const m = useMessages();
  const query = useAtomValue(tessayaWorkSessions.doorNamesQuery({ environmentId, input: {} }));
  const canName = useAtomValue(tessayaWorkSessions.doorSetName.permissionAtom(environmentId));
  const setName = useAtomCommand(tessayaWorkSessions.doorSetName, { reportFailure: false });
  const [saved, setSaved] = useState<{
    readonly domain: string | null;
    readonly names: Readonly<Record<string, string>>;
  } | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const door = saved ?? Option.getOrNull(AsyncResult.value(query));
  // Not the door (or an older server): no field.
  if (door === null || door.domain === null) return null;
  const current = door.names[machineId] ?? "";
  const value = draft ?? current;
  const save = (name: string | null) => {
    setBusy(true);
    void setName({ environmentId, input: { environmentId: machineId, name } }).then((result) => {
      setBusy(false);
      if (result._tag !== "Success")
        return toastManager.add({ type: "error", title: gt("Could not change the public name") });
      if (result.value.error !== null)
        return toastManager.add({ type: "error", title: m(ERRORS[result.value.error]) });
      setSaved(result.value.names);
      setDraft(null);
    });
  };
  return (
    <div className="flex flex-wrap items-center gap-2 pt-1 text-xs text-muted-foreground">
      <span>{gt("Public name")}</span>
      <Input
        aria-label={gt("Public name")}
        className="h-7 w-28"
        value={value}
        disabled={!canName || busy}
        placeholder={gt("none", { $context: "no public name set" })}
        onChange={(event) => setDraft(event.target.value)}
      />
      <span className="truncate">.{door.domain}</span>
      {canName && value.trim() !== current ? (
        <Button
          size="xs"
          variant="outline"
          disabled={busy}
          onClick={() => save(value.trim() || null)}
        >
          {value.trim() === ""
            ? gt("Remove", { $context: "verb, takes the machine off the door" })
            : gt("Save", { $context: "verb" })}
        </Button>
      ) : null}
    </div>
  );
}
