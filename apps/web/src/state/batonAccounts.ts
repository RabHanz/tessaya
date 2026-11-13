import { useAtomValue } from "@effect/atom-react";
import type { BatonAccountRecord } from "@t3tools/baton-contracts";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom, AsyncResult } from "effect/reactivity";

import { batonWorkSessions } from "./batonWorkSessions";

const NO_ACCOUNTS = Atom.make(AsyncResult.initial<never, never>(false));

/** One record per real account on the environment (baton.accounts.list). */
export function useBatonAccounts(
  environmentId: EnvironmentId | null,
): ReadonlyArray<BatonAccountRecord> {
  const result = useAtomValue(
    environmentId === null
      ? NO_ACCOUNTS
      : batonWorkSessions.accountsQuery({ environmentId, input: {} }),
  );
  return Option.getOrNull(AsyncResult.value(result))?.accounts ?? [];
}
