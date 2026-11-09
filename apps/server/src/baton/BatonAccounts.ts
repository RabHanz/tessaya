/** One record per real account (ACCOUNTS-1), for the picker, the header, Settings, mobile and agents alike. */
import {
  BATON_CLAUDE_ACCOUNT_INSTANCES,
  type BatonAccountsListResult,
} from "@t3tools/baton-contracts";
import { unifyAccounts } from "@t3tools/baton-shared/accounts";
import { ProviderDriverKind } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { AccountPoolService } from "./AccountPoolService.ts";

export class BatonAccounts extends Context.Service<
  BatonAccounts,
  { readonly list: Effect.Effect<BatonAccountsListResult> }
>()("t3/baton/BatonAccounts") {}

export const layer = Layer.effect(
  BatonAccounts,
  Effect.gen(function* () {
    const registry = yield* ProviderRegistry.ProviderRegistry;
    const pool = yield* AccountPoolService;
    const list = Effect.fn("BatonAccounts.list")(function* () {
      const providers = yield* registry.getProviders;
      // No switcher on this machine is a fact, not a failure: the instances still make accounts.
      const logins = yield* pool.read(ProviderDriverKind.make("claudeAgent")).pipe(
        Effect.map((read) => read.accounts),
        Effect.orElseSucceed(() => null),
      );
      return {
        accounts: unifyAccounts({ providers, pool: logins, slots: BATON_CLAUDE_ACCOUNT_INSTANCES }),
      };
    });
    return BatonAccounts.of({ list: list() });
  }),
);
