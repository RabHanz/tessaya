// @effect-diagnostics nodeBuiltinImport:off
/** One record per real account (ACCOUNTS-1), for the picker, the header, Settings, mobile and agents alike. */
import {
  BATON_CLAUDE_ACCOUNT_INSTANCES,
  type TessayaAccountsListResult,
} from "@t3tools/tessaya-contracts";
import {
  credentialKind,
  cswapTokenKinds,
  unifyAccounts,
  type CredentialKind,
} from "@t3tools/tessaya-shared/accounts";
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

const readJson = (file: string): unknown => JSON.parse(NodeFS.readFileSync(file, "utf8"));

/**
 * Each Claude instance's login as its config dir shows it, never a value: the kind of its stored credential (null
 * for a file that exists but holds none) and, for a non-default instance, the address its .claude.json names. A
 * missing or unreadable file is left out, as unknown: macOS keeps the login in the Keychain, some setups in the env.
 */
const instanceLogins = (providers: ReadonlyArray<ServerProvider>) => {
  const credentialKinds: Record<string, CredentialKind | null> = {};
  const loginEmails: Record<string, string | null> = {};
  for (const provider of providers) {
    if (provider.driver !== "claudeAgent") continue;
    const isDefault = String(provider.instanceId) === provider.driver;
    const home =
      provider.runtimePaths?.homePath ??
      (isDefault
        ? (process.env.CLAUDE_CONFIG_DIR ?? NodePath.join(NodeOS.homedir(), ".claude"))
        : null);
    if (home === null) continue;
    try {
      credentialKinds[provider.instanceId] = credentialKind(
        readJson(NodePath.join(home, ".credentials.json")),
      );
    } catch {}
    if (isDefault) continue;
    try {
      const config = readJson(NodePath.join(home, ".claude.json")) as {
        readonly oauthAccount?: { readonly emailAddress?: unknown };
      };
      const email = config.oauthAccount?.emailAddress;
      if (typeof email === "string") loginEmails[provider.instanceId] = email;
    } catch {}
  }
  return { credentialKinds, loginEmails };
};

export class TessayaAccounts extends Context.Service<
  TessayaAccounts,
  { readonly list: Effect.Effect<TessayaAccountsListResult> }
>()("t3/tessaya/TessayaAccounts") {}

export const layer = Layer.effect(
  TessayaAccounts,
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
          ...instanceLogins(providers),
          slotKinds: logins === null ? {} : yield* slotKinds,
        }),
      };
    });
    return TessayaAccounts.of({ list: list() });
  }),
);
