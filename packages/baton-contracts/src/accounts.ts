import * as Schema from "effect/Schema";

import { IsoDateTime, ProviderDriverKind, TrimmedNonEmptyString } from "@t3tools/contracts";

/**
 * One real account per login (ACCOUNTS-1): provider instances that sign in as the same email are one account with
 * several sign-in methods, e.g. the machine's own Claude login and a setup token for that same address.
 * Never carries a credential, only how one is held.
 */
export const BATON_ACCOUNTS_WS_METHODS = {
  list: "baton.accounts.list",
} as const;

/** How an instance holds its login: a long-lived setup token, a browser (OAuth) sign-in, or an API key. */
export const BatonSignInMethodKind = Schema.Literals(["setup-token", "browser", "api-key"]);
export type BatonSignInMethodKind = typeof BatonSignInMethodKind.Type;

export const BatonSignInMethod = Schema.Struct({
  kind: BatonSignInMethodKind,
  /** The provider instance that signs in this way; null for a login only the account switcher (cswap) holds. */
  instanceId: Schema.NullOr(TrimmedNonEmptyString),
  /** The method a running terminal session is switched with. At most one per account. */
  liveSwitch: Schema.Boolean,
});
export type BatonSignInMethod = typeof BatonSignInMethod.Type;

export const BatonAccountLimit = Schema.Struct({
  usedPercent: Schema.Number,
  resetsAt: Schema.NullOr(Schema.String),
});
export type BatonAccountLimit = typeof BatonAccountLimit.Type;

export const BatonAccountHealth = Schema.Literals(["ok", "signed-out", "paused", "error"]);
export type BatonAccountHealth = typeof BatonAccountHealth.Type;

export const BatonAccountRecord = Schema.Struct({
  /** `<driver>:<email>`, or `<driver>:<instance id>` for a login with no address. */
  id: TrimmedNonEmptyString,
  driver: ProviderDriverKind,
  label: TrimmedNonEmptyString,
  email: Schema.NullOr(Schema.String),
  /** Every enabled-or-paused instance that runs as this account. */
  instanceIds: Schema.Array(TrimmedNonEmptyString),
  /** Includes the provider's default instance (the machine's own login). */
  isDefault: Schema.Boolean,
  methods: Schema.Array(BatonSignInMethod),
  /** The account switcher's key a terminal session is moved with (liveSetAccount), or null when it cannot be. */
  liveSwitchKey: Schema.NullOr(TrimmedNonEmptyString),
  health: BatonAccountHealth,
  healthDetail: Schema.NullOr(Schema.String),
  fiveHour: Schema.NullOr(BatonAccountLimit),
  weekly: Schema.NullOr(BatonAccountLimit),
  checkedAt: Schema.NullOr(IsoDateTime),
});
export type BatonAccountRecord = typeof BatonAccountRecord.Type;

export const BatonAccountsListInput = Schema.Struct({});
export const BatonAccountsListResult = Schema.Struct({
  accounts: Schema.Array(BatonAccountRecord),
});
export type BatonAccountsListResult = typeof BatonAccountsListResult.Type;
