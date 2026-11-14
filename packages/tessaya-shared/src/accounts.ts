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
} from "@t3tools/tessaya-contracts";
import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderDriverKind,
  type ServerProvider,
} from "@t3tools/contracts";

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
  /** Token instances' cswap slots, by instance id (TESSAYA_CLAUDE_ACCOUNT_INSTANCES). */
  readonly slots: Readonly<Record<string, string>>;
  /** Each instance's own stored credential, as credentialKind reads it; null when it holds none. */
  readonly credentialKinds?: Readonly<Record<string, CredentialKind | null>>;
  /** Each cswap slot's stored credential, as cswapTokenKinds reads it. */
  readonly slotKinds?: Readonly<Record<string, CredentialKind>>;
  /** The address each non-default instance last signed in as (its own .claude.json), when its probe has none. */
  readonly loginEmails?: Readonly<Record<string, string | null>>;
}): ReadonlyArray<BatonAccountRecord> {
  const pool = input.pool ?? [];
  const active = pool.find((account) => account.active);
  // The default instance takes the active slot only when its own address confirms it: unconfirmed, it is "this
  // machine's login", never a guessed account, and an instance reporting another address never takes the slot.
  const slotOf = (instanceId: string | null, ownEmail: string | null = null): string | null => {
    if (instanceId === null) return null;
    const pinned = input.slots[instanceId];
    if (pinned !== undefined) return pinned;
    if (instanceId !== BATON_DEFAULT_CLAUDE_INSTANCE || active === undefined) return null;
    return ownEmail !== null && ownEmail === realEmail(active.email) ? active.key : null;
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
    const ownEmail =
      realEmail(provider.auth.email) ??
      (String(provider.instanceId) === provider.driver
        ? null
        : realEmail(input.loginEmails?.[provider.instanceId]));
    const slot = slotOf(provider.instanceId, ownEmail);
    const slotAccount = slot === null ? undefined : pool.find((account) => account.key === slot);
    const email = ownEmail ?? realEmail(slotAccount?.email);
    const identity = email ?? (slot === null ? provider.instanceId : `slot:${slot}`);
    const group = groupFor(provider.driver, identity, email);
    group.providers.push(provider);
    // An instance whose own credential file holds no login (signed out) adds no sign-in method.
    const holdsNone =
      input.credentialKinds !== undefined &&
      provider.instanceId in input.credentialKinds &&
      input.credentialKinds[provider.instanceId] === null &&
      input.slots[provider.instanceId] === undefined &&
      !isApiKey(provider.auth.type);
    if (!holdsNone)
      addMethod(
        group,
        isApiKey(provider.auth.type)
          ? "api-key"
          : (input.credentialKinds?.[provider.instanceId] ??
              (input.slots[provider.instanceId] === undefined
                ? "browser"
                : (input.slotKinds?.[input.slots[provider.instanceId]!] ?? "setup-token"))),
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
      addMethod(
        group,
        input.slotKinds?.[account.key] ?? (email === null ? "setup-token" : "browser"),
        null,
        account.key,
      );
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
    const alias = group.pool[0]?.label;
    // cswap's alias is lowercase ("bob"); an account reads as a name.
    // A default instance's name ("Alice" on the laptop) is not its login: it runs whatever the machine has.
    const machineOnly =
      group.email === null &&
      group.pool.length === 0 &&
      group.providers.length > 0 &&
      group.providers.every((provider) => String(provider.instanceId) === provider.driver);
    const label = machineOnly
      ? "This machine's login"
      : (named?.displayName ??
        (alias === undefined ? undefined : alias.charAt(0).toUpperCase() + alias.slice(1)) ??
        group.email?.split("@")[0] ??
        group.providers[0]?.displayName ??
        group.id);
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
      active: group.pool.some((account) => account.active),
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
    // Terminal is its own group; so is each ACP agent, though they share one driver.
    const key =
      entry.instanceId === LIVE_INSTANCE || entry.driverKind === "acpRegistry"
        ? entry.instanceId
        : entry.driverKind;
    byDriver.set(key, [...(byDriver.get(key) ?? []), entry]);
  }
  return [...byDriver.entries()].map(([key, group]) => {
    if (key === LIVE_INSTANCE) return { ...group[0]!, displayName: "Terminal" };
    const shown =
      group.find((entry) => entry.instanceId === selectedInstanceId) ??
      group.find((entry) => entry.isDefault) ??
      group[0]!;
    if (group.length === 1) return shown;
    // The provider's name, never a login's (a default instance he named "Alice" runs whatever login the machine has),
    // and no per-login accent: the account rows say which login it is.
    const name =
      PROVIDER_DISPLAY_NAMES[shown.driverKind as ProviderDriverKind] ??
      (group.find((entry) => entry.isDefault) ?? shown).displayName;
    return { ...shown, displayName: name, accentColor: undefined };
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

/** The login a terminal session runs as: the one the catalog names (by address local part), else cswap's active one. */
export const sessionLoginKey = (
  pool: ReadonlyArray<Pick<BatonAccount, "key" | "email" | "active">>,
  login: string | null,
): string | null =>
  (login === null
    ? pool.find((account) => account.active)
    : pool.find((account) => account.email?.split("@")[0] === login)
  )?.key ?? null;

/** The account a thread runs as: a terminal thread by its session's login, any other by its instance. */
export const threadAccount = <A extends Pick<BatonAccountRecord, "instanceIds" | "liveSwitchKey">>(
  accounts: ReadonlyArray<A>,
  instanceId: string,
  loginKey: string | null,
): A | undefined =>
  instanceId === LIVE_INSTANCE
    ? accounts.find((account) => loginKey !== null && account.liveSwitchKey === loginKey)
    : accounts.find((account) => account.instanceIds.includes(instanceId));

/**
 * The picker's tick and the header chip agree: the tick is the account the thread runs as (its stored instance, and on
 * a terminal thread the session's own login), never a pick still waiting in the composer. A waiting pick on another
 * account comes back as `setTo`, for a "thread set to X" hint.
 */
export const accountTicks = <
  A extends Pick<BatonAccountRecord, "id" | "instanceIds" | "liveSwitchKey">,
>(
  accounts: ReadonlyArray<A>,
  input: {
    readonly storedInstanceId: string;
    readonly shownInstanceId: string;
    readonly loginKey: string | null;
  },
): { readonly runsAs: A | undefined; readonly setTo: A | undefined } => {
  const runsAs = threadAccount(accounts, input.storedInstanceId, input.loginKey);
  const shown =
    input.shownInstanceId === input.storedInstanceId
      ? runsAs
      : threadAccount(accounts, input.shownInstanceId, input.loginKey);
  return { runsAs, setTo: shown !== undefined && shown.id !== runsAs?.id ? shown : undefined };
};

export type CredentialKind = "setup-token" | "browser";

/**
 * What kind of login a stored Claude credential is, from its shape alone (never its value): a browser sign-in keeps
 * a refresh token; a setup token (claude setup-token, about a year) has none. Null when the file holds no login.
 */
export const credentialKind = (stored: unknown): CredentialKind | null => {
  if (typeof stored !== "object" || stored === null) return null;
  const oauth = (stored as { readonly claudeAiOauth?: unknown }).claudeAiOauth ?? stored;
  if (typeof oauth !== "object" || oauth === null) return null;
  const { accessToken, refreshToken } = oauth as {
    readonly accessToken?: unknown;
    readonly refreshToken?: unknown;
  };
  if (typeof accessToken !== "string" || accessToken.length === 0) return null;
  return typeof refreshToken === "string" && refreshToken.length > 0 ? "browser" : "setup-token";
};

/** Each cswap slot's kind, from `cswap list --token-status` ("refresh token no" is a setup token). */
export const cswapTokenKinds = (text: string): Readonly<Record<string, CredentialKind>> => {
  const kinds: Record<string, CredentialKind> = {};
  let slot: string | null = null;
  for (const line of text.split("\n")) {
    const head = /^\s*(\d+):\s/.exec(line);
    if (head !== null) slot = head[1]!;
    const refresh = /refresh token (yes|no)\b/.exec(line);
    if (slot !== null && refresh !== null)
      kinds[slot] = refresh[1] === "no" ? "setup-token" : "browser";
  }
  return kinds;
};

/**
 * Models are a provider's, not a login's: a login whose instance lists none (signed out, or not probed yet) shows its
 * provider's catalogue, so picking it never lands on an empty list. A pick still goes to that login's own instance.
 */
export function withProviderModels<K extends string, M>(
  byInstance: ReadonlyMap<K, ReadonlyArray<M>>,
  driverOf: (instanceId: K) => string | undefined,
): ReadonlyMap<K, ReadonlyArray<M>> {
  const filled = new Map(byInstance);
  for (const [instanceId, models] of byInstance) {
    if (models.length > 0) continue;
    const driver = driverOf(instanceId);
    if (driver === undefined || driver === "acpRegistry") continue;
    const sibling = [...byInstance].find(
      ([other, list]) => other !== instanceId && list.length > 0 && driverOf(other) === driver,
    );
    if (sibling !== undefined) filled.set(instanceId, sibling[1]);
  }
  return filled;
}

/**
 * The instance a tick on an account sends the thread to: one of its own, never the default Claude instance, which
 * runs whatever cswap's active login is and would follow a rotation. The default is offered only for the login it
 * runs as right now, and says so (runsAsActive). Null when this machine has no instance for it.
 */
export const accountPickTarget = (
  account: Pick<BatonAccountRecord, "driver" | "email" | "instanceIds" | "methods" | "active">,
): { readonly instanceId: string; readonly runsAsActive: boolean } | null => {
  const ordered = [
    account.methods.find((method) => method.liveSwitch)?.instanceId ?? null,
    ...account.instanceIds,
  ].filter((id): id is string => id !== null);
  if (account.driver !== "claudeAgent")
    return ordered[0] === undefined ? null : { instanceId: ordered[0], runsAsActive: false };
  const own = ordered.find((id) => id !== BATON_DEFAULT_CLAUDE_INSTANCE);
  if (own !== undefined) return { instanceId: own, runsAsActive: false };
  const machineLogin =
    account.email === null && account.instanceIds.includes(BATON_DEFAULT_CLAUDE_INSTANCE);
  return account.active === true || machineLogin
    ? { instanceId: BATON_DEFAULT_CLAUDE_INSTANCE, runsAsActive: true }
    : null;
};

/** The line under an account row: how a pick runs, or why it cannot be picked here. */
export const accountPickHint = (
  target: ReturnType<typeof accountPickTarget>,
  current: boolean,
): string | null =>
  target?.runsAsActive === true
    ? "Runs as this machine's active login"
    : target === null && !current
      ? "No instance here: add one in Settings"
      : null;
