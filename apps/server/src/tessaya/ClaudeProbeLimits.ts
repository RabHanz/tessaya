/**
 * Claude limits for setup tokens (D92): `get_usage` gives a token no windows, so cswap's reading from
 * Baton's probe (D90) goes into the provider snapshot. `checkedAt` keeps the reading's own time so the
 * panel can state its age. A login that reports its own windows is left alone.
 */
import {
  accountForInstance,
  type TessayaAccount,
  type TessayaAccountPool,
} from "@t3tools/tessaya-contracts";
import { ProviderDriverKind, type ServerProviderUsageLimits } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { makeUsageLimits } from "@t3tools/provider-core/server/usageLimits";

import { makePoolReader } from "./AccountPoolService.ts";

const WINDOW_SHAPE: Readonly<
  Record<string, { kind: "session" | "weekly"; label: string; mins: number }>
> = {
  five_hour: { kind: "session", label: "Session", mins: 5 * 60 },
  seven_day: { kind: "weekly", label: "Weekly", mins: 7 * 24 * 60 },
};

export function limitsFromAccount(
  account: TessayaAccount | undefined,
): ServerProviderUsageLimits | undefined {
  if (account === undefined || account.usageCheckedAt === null) return undefined;
  const windows = account.windows.flatMap((window) => {
    const shape = WINDOW_SHAPE[window.id];
    return shape === undefined
      ? []
      : [
          {
            id: window.id,
            kind: shape.kind,
            label: shape.label,
            windowDurationMins: shape.mins,
            usedPercent: window.usedPercent,
            ...(window.resetsAt === null ? {} : { resetsAt: window.resetsAt }),
          },
        ];
  });
  return windows.length === 0
    ? undefined
    : {
        ...makeUsageLimits({ checkedAt: account.usageCheckedAt, windows }),
        // The slot, never the token: slots match across machines, so T3 merges one tile per account.
        credentialFingerprint: account.key,
      };
}

/** A default instance has no name of its own, so it shows the account it is running as. */
export function accountDisplayName(account: TessayaAccount): string {
  return `${account.label.charAt(0).toUpperCase()}${account.label.slice(1)}`;
}

/**
 * The instance as the account cswap reads for it. A box's own login gives way to the account's email:
 * T3 keys on email first, so one login would split that account into its own tile. stampIdentity runs
 * next and puts back a name the instance was configured with.
 */
export function withAccount<P extends { readonly auth: { readonly email?: string | undefined } }>(
  provider: P,
  account: TessayaAccount | undefined,
): P {
  const usageLimits = limitsFromAccount(account);
  if (account === undefined || usageLimits === undefined) return provider;
  const { email: _login, ...auth } = provider.auth;
  return {
    ...provider,
    auth: account.email === null ? auth : { ...auth, email: account.email },
    usageLimits,
    displayName: accountDisplayName(account),
  } as P;
}

/** Fills in limits only where the login reports none; a missing cswap changes nothing. */
export const withProbeLimits = <
  P extends {
    readonly usageLimits?: ServerProviderUsageLimits | undefined;
    readonly auth: { readonly email?: string | undefined };
  },
>(
  instanceId: string,
  provider: P,
): Effect.Effect<P, never, ChildProcessSpawner.ChildProcessSpawner> => {
  if (provider.usageLimits?.unavailable?.reason !== "unsupported") return Effect.succeed(provider);
  return Effect.flatMap(ChildProcessSpawner.ChildProcessSpawner, (spawner) =>
    makePoolReader(spawner)(ProviderDriverKind.make("claudeAgent")).pipe(
      Effect.map((pool: TessayaAccountPool) =>
        withAccount(provider, accountForInstance(instanceId, pool.accounts)),
      ),
      Effect.catchCause(() => Effect.succeed(provider)),
    ),
  );
};
