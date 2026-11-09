/**
 * One record per real account (ACCOUNTS-1), from T3's provider snapshots and the machine's account switcher (cswap).
 * Instances that sign in as the same email merge; so do instances bound to the same cswap slot. The default Claude
 * instance runs as whatever cswap has active, so it joins that login's record.
 */
import {
  BATON_DEFAULT_CLAUDE_INSTANCE,
  type BatonAccount,
  type BatonAccountHealth,
  type BatonAccountLimit,
  type BatonAccountRecord,
  type BatonSignInMethod,
  type BatonSignInMethodKind,
} from "@t3tools/baton-contracts";
import type { ServerProvider } from "@t3tools/contracts";

import { LIVE_INSTANCE } from "./liveThread.ts";

// cswap names a setup token it could not resolve to an address `setup-token-<n>@token.local`.
const realEmail = (email: string | null | undefined): string | null => {
  const trimmed = email?.trim().toLowerCase() ?? "";
  return trimmed === "" || trimmed.endsWith("@token.local") ? null : trimmed;
};

const isApiKey = (type: string | undefined) =>
  type !== undefined && type.toLowerCase().replace(/[^a-z]/g, "") === "apikey";

interface Room {
  readonly checkedAt: string | null;
  readonly fiveHour: BatonAccountLimit | null;
  readonly weekly: BatonAccountLimit | null;
}

const providerRoom = (provider: ServerProvider): Room | null => {
  const windows = provider.usageLimits?.windows ?? [];
  const pick = (kind: string): BatonAccountLimit | null => {
    const window = windows.find((candidate) => candidate.kind === kind);
    return window === undefined
      ? null
      : { usedPercent: window.usedPercent, resetsAt: window.resetsAt ?? null };
  };
  const room = { fiveHour: pick("session"), weekly: pick("weekly") };
  return room.fiveHour === null && room.weekly === null
    ? null
    : { ...room, checkedAt: provider.usageLimits?.checkedAt ?? null };
};

const poolRoom = (account: BatonAccount): Room | null => {
  const pick = (id: string): BatonAccountLimit | null => {
    const window = account.windows.find((candidate) => candidate.id === id);
    return window === undefined
      ? null
      : { usedPercent: window.usedPercent, resetsAt: window.resetsAt };
  };
  const room = { fiveHour: pick("five_hour"), weekly: pick("seven_day") };
  return room.fiveHour === null && room.weekly === null
    ? null
    : { ...room, checkedAt: account.usageCheckedAt };
};

interface Group {
  readonly id: string;
  readonly driver: ServerProvider["driver"];
  email: string | null;
  readonly providers: ServerProvider[];
  readonly pool: BatonAccount[];
  readonly methods: Array<BatonSignInMethod & { readonly slot: string | null }>;
}

export function unifyAccounts(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  /** cswap's Claude logins, or null where there is no switcher. */
  readonly pool: ReadonlyArray<BatonAccount> | null;
  /** Token instances' cswap slots, by instance id (BATON_CLAUDE_ACCOUNT_INSTANCES). */
  readonly slots: Readonly<Record<string, string>>;
}): ReadonlyArray<BatonAccountRecord> {
  const pool = input.pool ?? [];
  const active = pool.find((account) => account.active);
  // The default instance runs as cswap's active login only when nothing says otherwise: an instance that reports
  // another address is another person's login, and must never take the active slot (or merge with it).
  const slotOf = (instanceId: string | null, ownEmail: string | null = null): string | null => {
    if (instanceId === null) return null;
    const pinned = input.slots[instanceId];
    if (pinned !== undefined) return pinned;
    if (instanceId !== BATON_DEFAULT_CLAUDE_INSTANCE || active === undefined) return null;
    return ownEmail === null || ownEmail === realEmail(active.email) ? active.key : null;
  };
  const groups = new Map<string, Group>();
  const groupFor = (driver: Group["driver"], identity: string, email: string | null) => {
    const id = `${driver}:${identity}`;
    const existing = groups.get(id);
    if (existing !== undefined) return existing;
    const group: Group = { id, driver, email, providers: [], pool: [], methods: [] };
    groups.set(id, group);
    return group;
  };
  const addMethod = (
    group: Group,
    kind: BatonSignInMethodKind,
    instanceId: string | null,
    slot: string | null,
  ) => {
    if (group.methods.some((method) => method.kind === kind && method.slot === slot)) return;
    group.methods.push({ kind, instanceId, liveSwitch: false, slot });
  };

  for (const provider of input.providers) {
    if (provider.instanceId === LIVE_INSTANCE) continue;
    const ownEmail = realEmail(provider.auth.email);
    const slot = slotOf(provider.instanceId, ownEmail);
    const slotAccount = slot === null ? undefined : pool.find((account) => account.key === slot);
    const email = ownEmail ?? realEmail(slotAccount?.email);
    const identity = email ?? (slot === null ? provider.instanceId : `slot:${slot}`);
    const group = groupFor(provider.driver, identity, email);
    group.providers.push(provider);
    addMethod(
      group,
      isApiKey(provider.auth.type)
        ? "api-key"
        : input.slots[provider.instanceId] !== undefined
          ? "setup-token"
          : "browser",
      provider.instanceId,
      slot,
    );
  }

  for (const account of pool) {
    const email = realEmail(account.email);
    const claude = [...groups.values()].filter((candidate) => candidate.driver === "claudeAgent");
    // By address first: a slot only joins a login with no address of its own, never a different one.
    const group =
      (email === null ? undefined : claude.find((candidate) => candidate.email === email)) ??
      claude.find(
        (candidate) =>
          (email === null || candidate.email === null) &&
          candidate.methods.some((method) => method.slot === account.key),
      ) ??
      groupFor("claudeAgent" as Group["driver"], email ?? `slot:${account.key}`, email);
    group.pool.push(account);
    if (!group.methods.some((method) => method.slot === account.key))
      addMethod(group, email === null ? "setup-token" : "browser", null, account.key);
  }

  return [...groups.values()].map((group): BatonAccountRecord => {
    const instanceIds = group.providers.map((provider) => provider.instanceId);
    // Only a token is copied into a session's own dir (tessaya-claude --switch); a browser login cannot be.
    const live = group.methods.findIndex(
      (method) => method.kind !== "browser" && method.slot !== null,
    );
    const liveSwitchKey = group.methods[live]?.slot ?? null;
    const methods = group.methods.map(({ slot: _slot, ...method }, index) => ({
      ...method,
      liveSwitch: index === live,
    }));
    const named = group.providers.find(
      (provider) =>
        String(provider.instanceId) !== provider.driver && provider.displayName !== undefined,
    );
    const label =
      named?.displayName ??
      group.pool[0]?.label ??
      group.providers[0]?.displayName ??
      group.email?.split("@")[0] ??
      group.id;
    const rooms = [...group.providers.map(providerRoom), ...group.pool.map(poolRoom)]
      .filter((room): room is Room => room !== null)
      .toSorted((a, b) => (b.checkedAt ?? "").localeCompare(a.checkedAt ?? ""));
    const room = rooms[0] ?? { checkedAt: null, fiveHour: null, weekly: null };
    const { health, detail } = healthOf(group);
    return {
      id: group.id,
      driver: group.driver,
      label,
      email: group.email,
      instanceIds,
      isDefault: group.providers.some(
        (provider) => String(provider.instanceId) === provider.driver,
      ),
      methods,
      liveSwitchKey,
      health,
      healthDetail: detail,
      fiveHour: room.fiveHour,
      weekly: room.weekly,
      checkedAt: room.checkedAt,
    } as BatonAccountRecord;
  });
}

function healthOf(group: Group): {
  readonly health: BatonAccountHealth;
  readonly detail: string | null;
} {
  const enabled = group.providers.filter((provider) => provider.enabled);
  if (group.providers.length > 0 && enabled.length === 0)
    return { health: "paused", detail: "Paused · threads won't use it" };
  const signedOut =
    (enabled.length > 0 &&
      enabled.every((provider) => provider.auth.status === "unauthenticated")) ||
    group.pool.some((account) => account.unusableReason === "signed-out");
  if (signedOut) return { health: "signed-out", detail: "Signed out · sign in again" };
  const failing = enabled.length > 0 && enabled.every((provider) => provider.status === "error");
  if (failing) return { health: "error", detail: enabled[0]?.message ?? "Not working" };
  return { health: "ok", detail: null };
}

/**
 * A picker rail with one entry per provider, not per login: the selected instance stands for its provider (else the
 * default one), under the provider's own name. The terminal sessions are their own group, "Terminal".
 */
export function oneEntryPerProvider<
  E extends {
    readonly instanceId: string;
    readonly driverKind: string;
    readonly displayName: string;
    readonly isDefault: boolean;
  },
>(entries: ReadonlyArray<E>, selectedInstanceId: string): ReadonlyArray<E> {
  const byDriver = new Map<string, E[]>();
  for (const entry of entries) {
    const key = entry.instanceId === LIVE_INSTANCE ? LIVE_INSTANCE : entry.driverKind;
    byDriver.set(key, [...(byDriver.get(key) ?? []), entry]);
  }
  return [...byDriver.entries()].map(([key, group]) => {
    if (key === LIVE_INSTANCE) return { ...group[0]!, displayName: "Terminal" };
    const shown =
      group.find((entry) => entry.instanceId === selectedInstanceId) ??
      group.find((entry) => entry.isDefault) ??
      group[0]!;
    const name = (group.find((entry) => entry.isDefault) ?? shown).displayName;
    return shown.displayName === name ? shown : { ...shown, displayName: name };
  });
}
/** Why a running session may not be switched to this cswap slot, or null when it may: only a token moves live. */
export const liveSwitchRefusal = (
  accounts: ReadonlyArray<Pick<BatonAccountRecord, "liveSwitchKey">>,
  key: string,
): string | null =>
  accounts.some((account) => account.liveSwitchKey === key)
    ? null
    : "That account signs in through a browser, which cannot be moved into a running session. Add it as a setup token to switch to it live.";

/** The model an account pick lands on: the thread's own on the same provider, else the target's default. */
export const pickModelFor = (
  target: {
    readonly driverKind: string;
    readonly models: ReadonlyArray<{
      readonly slug: string;
      readonly isDefault?: boolean | undefined;
    }>;
  },
  threadDriver: string,
  threadModel: string,
): string =>
  target.driverKind === threadDriver
    ? threadModel
    : ((target.models.find((model) => model.isDefault === true) ?? target.models[0])?.slug ??
      threadModel);
