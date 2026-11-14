import { useAtomValue } from "@effect/atom-react";
import type { TessayaAccountRecord } from "@t3tools/tessaya-contracts";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom, AsyncResult } from "effect/reactivity";

import { tessayaWorkSessions } from "./tessayaWorkSessions";

const NO_ACCOUNTS = Atom.make(AsyncResult.initial<never, never>(false));

/** One record per real account on the environment (baton.accounts.list). */
export function useTessayaAccounts(
  environmentId: EnvironmentId | null,
): ReadonlyArray<TessayaAccountRecord> {
  const result = useAtomValue(
    environmentId === null
      ? NO_ACCOUNTS
      : tessayaWorkSessions.accountsQuery({ environmentId, input: {} }),
  );
  return Option.getOrNull(AsyncResult.value(result))?.accounts ?? [];
}
