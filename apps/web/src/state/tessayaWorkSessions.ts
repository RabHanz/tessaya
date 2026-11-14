/**
 * Baton's client state in the web app: the shared atoms, and every environment's fleet read as
 * one value for the sidebar block.
 */
import { useAtomValue } from "@effect/atom-react";
import type { TessayaFleet, EnvironmentId } from "@t3tools/tessaya-contracts";
import { createTessayaWorkSessionAtoms } from "@t3tools/tessaya-shared/workSessionAtoms";
import * as Option from "effect/Option";
import { Atom, AsyncResult } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";

export const tessayaWorkSessions = createTessayaWorkSessionAtoms(connectionAtomRuntime);

export interface EnvironmentFleet {
  readonly environmentId: EnvironmentId;
  /** Null until the first answer (or the persisted one from the last visit) arrives. */
  readonly fleet: TessayaFleet | null;
}

/** Keyed by the comma-joined environment ids, so one atom serves one sidebar's set. */
const fleetsAtom = Atom.family((key: string) =>
  Atom.make((get): ReadonlyArray<EnvironmentFleet> =>
    key
      .split(",")
      .filter((id) => id.length > 0)
      .map((id) => {
        const environmentId = id as EnvironmentId;
        const result = get(tessayaWorkSessions.fleetQuery({ environmentId, input: {} }));
        return {
          environmentId,
          fleet: Option.getOrNull(Option.map(AsyncResult.value(result), (value) => value.fleet)),
        };
      }),
  ),
);

export function useTessayaFleets(
  environmentIds: ReadonlyArray<EnvironmentId>,
): ReadonlyArray<EnvironmentFleet> {
  return useAtomValue(fleetsAtom(environmentIds.join(",")));
}
