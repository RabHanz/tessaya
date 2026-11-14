/**
 * Each account's limits for Baton's window (D140): one row per account, with the machines it is on,
 * found the way T3's pooled tile finds it. Differing readings take the freshest check, else the
 * higher used percent.
 */
import type { TessayaUsageSummary } from "@t3tools/tessaya-contracts";
import { accountKeyResolver, type AccountReport } from "@t3tools/shared/usageLimits";

interface ProviderLike {
  readonly instanceId: string;
  readonly driver?: AccountReport["driver"] | undefined;
  readonly displayName?: string | undefined;
  readonly enabled: boolean;
  readonly auth?:
    | { readonly email?: string | undefined; readonly workspaceId?: string | undefined }
    | undefined;
  readonly usageLimits?:
    | {
        readonly checkedAt?: string | undefined;
        readonly credentialFingerprint?: string | undefined;
        readonly windows: ReadonlyArray<{
          readonly kind: "session" | "weekly" | "monthly" | "other";
          readonly label: string;
          readonly usedPercent: number;
          readonly resetsAt?: string | undefined;
        }>;
      }
    | undefined;
}

const KIND_LABEL = { session: "Session", weekly: "Week", monthly: "Month" } as const;

type Window = TessayaUsageSummary["windows"][number];
interface Reading {
  readonly account: string;
  readonly box: string;
  readonly at: number;
  readonly windows: ReadonlyArray<Window>;
  readonly key: string | null;
}

/** The fresher reading wins; with no times, the higher used percent. */
const preferred = (a: { readonly at: number; readonly window: Window }, b: typeof a) =>
  a.at !== b.at
    ? a.at > b.at
      ? a
      : b
    : (a.window.usedPercent ?? 0) >= (b.window.usedPercent ?? 0)
      ? a
      : b;

export function tessayaUsageSummaries(
  environments: ReadonlyArray<{
    readonly box: string;
    readonly providers: ReadonlyArray<ProviderLike>;
  }>,
): ReadonlyArray<TessayaUsageSummary> {
  const withLimits = environments.flatMap((env) =>
    env.providers
      .filter((p) => p.enabled && p.usageLimits !== undefined && p.usageLimits.windows.length > 0)
      .map((provider) => ({ env, provider })),
  );
  const resolveKey = accountKeyResolver(
    withLimits.flatMap(({ provider }) =>
      provider.driver === undefined
        ? []
        : [
            {
              driver: provider.driver,
              email: provider.auth?.email,
              workspaceId: provider.auth?.workspaceId,
              usageLimits: provider.usageLimits as AccountReport["usageLimits"],
            },
          ],
    ),
  );
  const readings: Reading[] = withLimits.map(({ env, provider }) => {
    const limits = provider.usageLimits!;
    const key =
      provider.driver === undefined
        ? null
        : resolveKey({
            driver: provider.driver,
            email: provider.auth?.email,
            workspaceId: provider.auth?.workspaceId,
            usageLimits: limits as AccountReport["usageLimits"],
          });
    const account = provider.displayName ?? provider.instanceId;
    return {
      account,
      box: env.box,
      at: Date.parse(limits.checkedAt ?? "") || 0,
      // No identity at all: the name is all there is to group by.
      key: key ?? `name:${account.toLowerCase()}`,
      windows: limits.windows.map((w) => ({
        label: w.kind === "other" ? w.label : KIND_LABEL[w.kind],
        usedPercent: w.usedPercent,
        resetsAt: w.resetsAt ?? null,
      })),
    };
  });
  const groups = new Map<string, Reading[]>();
  for (const reading of readings)
    groups.set(reading.key!, [...(groups.get(reading.key!) ?? []), reading]);
  return [...groups.values()].map((group) => {
    const boxes = [...new Set(group.map((r) => r.box))];
    const labels = [...new Set(group.flatMap((r) => r.windows.map((w) => w.label)))];
    const windows = labels.map((label): Window => {
      const candidates = group.flatMap((r) =>
        r.windows.filter((w) => w.label === label).map((window) => ({ at: r.at, window })),
      );
      return candidates.reduce(preferred).window;
    });
    return { account: group[0]!.account, box: boxes.join(" + "), boxes, windows };
  });
}
