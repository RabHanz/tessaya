// @effect-diagnostics nodeBuiltinImport:off
/** One record per real account (ACCOUNTS-1), for the picker, the header, Settings, mobile and agents alike. */
import {
  BATON_CLAUDE_ACCOUNT_INSTANCES,
  type BatonAccountsListResult,
} from "@t3tools/baton-contracts";
import {
  credentialKind,
  cswapTokenKinds,
  unifyAccounts,
  type CredentialKind,
} from "@t3tools/baton-shared/accounts";
import { ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Duration from "effect/Duration";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { AccountPoolService, makeTokenStatusReader } from "./AccountPoolService.ts";

/** Each Claude instance's own stored credential kind, read from its config dir's file shape (never its value). */
const instanceCredentialKinds = (
  providers: ReadonlyArray<ServerProvider>,
): Record<string, CredentialKind | null> =>
  Object.fromEntries(
    providers
      .filter((provider) => provider.driver === "claudeAgent")
      .map((provider) => {
        const home =
          provider.runtimePaths?.homePath ??
          (String(provider.instanceId) === provider.driver
            ? (process.env.CLAUDE_CONFIG_DIR ?? NodePath.join(NodeOS.homedir(), ".claude"))
            : null);
        if (home === null) return [provider.instanceId, null];
        try {
          const stored: unknown = JSON.parse(
            NodeFS.readFileSync(NodePath.join(home, ".credentials.json"), "utf8"),
          );
          return [provider.instanceId, credentialKind(stored)];
        } catch {
          return [provider.instanceId, null];
        }
      }),
  );

export class BatonAccounts extends Context.Service<
  BatonAccounts,
  { readonly list: Effect.Effect<BatonAccountsListResult> }
>()("t3/baton/BatonAccounts") {}

export const layer = Layer.effect(
  BatonAccounts,
  Effect.gen(function* () {
    const registry = yield* ProviderRegistry.ProviderRegistry;
    const pool = yield* AccountPoolService;
    // cswap's token status changes only when a login is added or replaced; one read per few minutes is plenty.
    const slotKinds = yield* Effect.cachedWithTTL(
      makeTokenStatusReader(yield* ChildProcessSpawner.ChildProcessSpawner)().pipe(
        Effect.map(cswapTokenKinds),
      ),
      Duration.minutes(5),
    );
    const list = Effect.fn("BatonAccounts.list")(function* () {
      const providers = yield* registry.getProviders;
      // No switcher on this machine is a fact, not a failure: the instances still make accounts.
      const logins = yield* pool.read(ProviderDriverKind.make("claudeAgent")).pipe(
        Effect.map((read) => read.accounts),
        Effect.orElseSucceed(() => null),
      );
      return {
        accounts: unifyAccounts({
          providers,
          pool: logins,
          slots: BATON_CLAUDE_ACCOUNT_INSTANCES,
          credentialKinds: instanceCredentialKinds(providers),
          slotKinds: logins === null ? {} : yield* slotKinds,
        }),
      };
    });
    return BatonAccounts.of({ list: list() });
  }),
);
