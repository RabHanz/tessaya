/* oxlint-disable t3code/no-low-value-comments -- Baton file predating upstream's rule (D82) */
import * as Schema from "effect/Schema";

import { IsoDateTime, ThreadId, TrimmedNonEmptyString } from "@t3tools/contracts";
import { ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import { WorkSessionId } from "./workSession.ts";
import { alsoReads } from "./renamed.ts";

/**
 * The accounts one config directory can run as (§6.1, corrected).
 *
 * A provider thread is bound to its **config directory**, not to an account:
 * the credential file inside that directory can be replaced while the session
 * id, the transcript and the resume cursor stay exactly where they were. That
 * is what the Director already does by hand between his three Claude logins,
 * and it is why rotation — not a handoff capsule — is the primary way work
 * continues past a limit. The capsule path remains for the cases rotation
 * genuinely cannot serve: a different config directory, or another provider.
 */

// Legacy names (D71): every Baton RPC method keeps its "fabric." wire name, so installed clients keep working.
export const BATON_ACCOUNT_WS_METHODS = {
  /** Read the pool. A read: it changes nothing and costs one process. */
  accountPool: "fabric.account.pool",
  /** Swap the credential in the config directory, between turns. */
  accountUse: "fabric.account.use",
  /** Whether a thread moves to another account by itself when its account nears its limit. */
  onLimit: "fabric.account.onLimit",
  setOnLimit: "fabric.account.setOnLimit",
  /** Whether automatic rotation leaves this thread on its account, and setting that. */
  threadKept: "fabric.account.threadKept",
  threadKeep: "fabric.account.threadKeep",
  /** Each instance's weekly figure, for cloud tasks on this computer (D2). A read. */
  weekly: "fabric.account.weekly",
} as const;

export const BATON_DEFAULT_CLAUDE_INSTANCE = "claudeAgent";

/**
 * cswap slots of the token instances, by provider instance id. Empty until a machine says which it
 * has: the server reads `TESSAYA_CLAUDE_ACCOUNT_INSTANCES` (JSON, `{"claudeAgent_work":"4"}`) at start;
 * the old `BATON_` name still works.
 */
export const BATON_CLAUDE_ACCOUNT_INSTANCES: Record<string, string> = {};

export const setClaudeAccountInstances = (map: Readonly<Record<string, string>>): void => {
  for (const key of Object.keys(BATON_CLAUDE_ACCOUNT_INSTANCES))
    delete BATON_CLAUDE_ACCOUNT_INSTANCES[key];
  Object.assign(BATON_CLAUDE_ACCOUNT_INSTANCES, map);
};

/** Identifies an account inside a pool. Opaque: the adapter chooses the form. */
export const TessayaAccountKey = TrimmedNonEmptyString;
export type TessayaAccountKey = typeof TessayaAccountKey.Type;

/** Why an account cannot be rotated to right now. */
export const TessayaAccountUnusableReason = Schema.Literals([
  "signed-out",
  "limits-unknown",
  "disabled",
  "spent",
]);
export type TessayaAccountUnusableReason = typeof TessayaAccountUnusableReason.Type;

export const TessayaAccountWindow = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  usedPercent: Schema.Number,
  resetsAt: Schema.NullOr(IsoDateTime),
});
export type TessayaAccountWindow = typeof TessayaAccountWindow.Type;

export const TessayaAccount = Schema.Struct({
  key: TessayaAccountKey,
  /** What a person calls it: the alias they set, else the address's local part. */
  label: TrimmedNonEmptyString,
  email: Schema.NullOr(Schema.String),
  organizationName: Schema.NullOr(Schema.String),
  active: Schema.Boolean,
  usable: Schema.Boolean,
  unusableReason: Schema.NullOr(TessayaAccountUnusableReason),
  /**
   * Percent of the **tightest** window still free. An account at 4% of its
   * five-hour window and 99% of its weekly one has 1% of headroom, and moving
   * work onto it buys minutes.
   */
  headroomPercent: Schema.NullOr(Schema.Number),
  windows: Schema.Array(TessayaAccountWindow),
  usageCheckedAt: Schema.NullOr(IsoDateTime),
});
export type TessayaAccount = typeof TessayaAccount.Type;

/** Where the pool comes from, so a surface can say what it is driving. */
// Legacy name (D71): "fabric" is a stored source value, so it is kept.
export const TessayaAccountPoolSource = Schema.Union([
  Schema.Literals(["cswap", "instances"]),
  alsoReads("fabric", "tessaya"),
]);
export type TessayaAccountPoolSource = typeof TessayaAccountPoolSource.Type;

export const TessayaAccountPool = Schema.Struct({
  driver: ProviderDriverKind,
  source: TessayaAccountPoolSource,
  /** The directory whose credential is swapped. One pool per directory. */
  configDir: TrimmedNonEmptyString,
  accounts: Schema.Array(TessayaAccount),
  checkedAt: IsoDateTime,
});
export type TessayaAccountPool = typeof TessayaAccountPool.Type;

export const TessayaAccountRotationReason = Schema.Literals(["manual", "limit", "policy"]);
export type TessayaAccountRotationReason = typeof TessayaAccountRotationReason.Type;

export const TessayaAccountRotation = Schema.Struct({
  fromKey: Schema.NullOr(TessayaAccountKey),
  fromLabel: Schema.NullOr(TrimmedNonEmptyString),
  toKey: TessayaAccountKey,
  toLabel: TrimmedNonEmptyString,
  reason: TessayaAccountRotationReason,
  /** The work session this was done for, when it was done for one. */
  workSessionId: Schema.NullOr(WorkSessionId),
  /** Free in the tightest window of the account moved to, at the time. */
  toHeadroomPercent: Schema.NullOr(Schema.Number),
  rotatedAt: IsoDateTime,
});
export type TessayaAccountRotation = typeof TessayaAccountRotation.Type;

export const TessayaAccountPoolInput = Schema.Struct({
  driver: Schema.optional(ProviderDriverKind),
});
export type TessayaAccountPoolInput = typeof TessayaAccountPoolInput.Type;

export const TessayaAccountUseInput = Schema.Struct({
  key: TessayaAccountKey,
  /** When set, the login with this address on the receiving machine, whose slot may differ from `key`. */
  email: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(320))),
  reason: Schema.optional(TessayaAccountRotationReason),
  /** Named so the rotation lands on that work's timeline. */
  workSessionId: Schema.optional(WorkSessionId),
  driver: Schema.optional(ProviderDriverKind),
});
export type TessayaAccountUseInput = typeof TessayaAccountUseInput.Type;

/** "auto" moves a working thread to the instance with the most room; "ask" leaves it where it is. */
export const TessayaOnLimitSetting = Schema.Literals(["auto", "ask"]);
export type TessayaOnLimitSetting = typeof TessayaOnLimitSetting.Type;

export const TessayaOnLimitInput = Schema.Struct({});
export const TessayaOnLimitResult = Schema.Struct({ policy: TessayaOnLimitSetting });
export type TessayaOnLimitResult = typeof TessayaOnLimitResult.Type;
export const TessayaSetOnLimitInput = Schema.Struct({ policy: TessayaOnLimitSetting });
export type TessayaSetOnLimitInput = typeof TessayaSetOnLimitInput.Type;

export const TessayaThreadKeptInput = Schema.Struct({ threadId: ThreadId });
export const TessayaThreadKeepInput = Schema.Struct({ threadId: ThreadId, keep: Schema.Boolean });
export type TessayaThreadKeepInput = typeof TessayaThreadKeepInput.Type;
export const TessayaThreadKeepResult = Schema.Struct({ keep: Schema.Boolean });

export const TessayaInstanceWeekly = Schema.Struct({
  instanceId: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  email: Schema.NullOr(Schema.String),
  weeklyPercent: Schema.NullOr(Schema.Number),
  resetsAt: Schema.NullOr(Schema.String),
});
export type TessayaInstanceWeekly = typeof TessayaInstanceWeekly.Type;
export const TessayaAccountWeeklyInput = Schema.Struct({ driver: ProviderDriverKind });
export const TessayaAccountWeeklyResult = Schema.Struct({
  instances: Schema.Array(TessayaInstanceWeekly),
});

/** The weekly window each enabled instance of a driver reports, as T3's provider snapshot has it. */
export const instancesWeekly = (
  providers: ReadonlyArray<ServerProvider>,
  driver: string,
): ReadonlyArray<TessayaInstanceWeekly> =>
  providers
    .filter((provider) => provider.driver === driver && provider.enabled)
    .map((provider) => {
      const week = provider.usageLimits?.windows.find((window) => window.kind === "weekly");
      return {
        instanceId: provider.instanceId,
        label: provider.displayName ?? provider.instanceId,
        email: provider.auth.email ?? null,
        weeklyPercent: week?.usedPercent ?? null,
        resetsAt: week?.resetsAt ?? null,
      };
    });

export const TessayaAccountUseResult = Schema.Struct({
  rotation: TessayaAccountRotation,
  pool: TessayaAccountPool,
  /** Claude: the sessions in their own config dirs that moved with the machine login, and those that did not. */
  sessions: Schema.optionalKey(Schema.Struct({ switched: Schema.Number, failed: Schema.Number })),
});
export type TessayaAccountUseResult = typeof TessayaAccountUseResult.Type;

export const TessayaThreadAccountUseResult = Schema.Struct({
  instanceId: TrimmedNonEmptyString,
  /** `next-turn` when a turn is running: it is never cut, and the move waits for it to end. */
  timing: Schema.Literals(["now", "next-turn"]),
});
export type TessayaThreadAccountUseResult = typeof TessayaThreadAccountUseResult.Type;

/** Free in the tightest window. The tightest one is what runs out first. */
export function headroomFromWindows(
  windows: ReadonlyArray<{ readonly usedPercent: number }>,
): number | null {
  if (windows.length === 0) return null;
  const worst = windows.reduce(
    (highest, window) => (window.usedPercent > highest ? window.usedPercent : highest),
    0,
  );
  return Math.max(0, 100 - worst);
}

/** One Claude instance as an account (L-76): its own reported windows, its key the instance id. */
export const instanceAccount = (provider: ServerProvider, active: boolean): TessayaAccount => {
  const windows = (provider.usageLimits?.windows ?? []).map((window) => ({
    id: window.id,
    label: window.label,
    usedPercent: window.usedPercent,
    resetsAt: window.resetsAt ?? null,
  }));
  const headroom = headroomFromWindows(windows);
  const signedOut = provider.auth.status === "unauthenticated";
  return {
    key: provider.instanceId,
    label: provider.displayName ?? provider.instanceId,
    email: provider.auth.email ?? null,
    organizationName: null,
    active,
    usable: !signedOut && headroom !== null,
    unusableReason: signedOut ? "signed-out" : headroom === null ? "limits-unknown" : null,
    headroomPercent: headroom,
    windows,
    usageCheckedAt: provider.usageLimits?.checkedAt ?? null,
  } as TessayaAccount;
};

/**
 * The cswap account an instance runs as: its token's slot, or whatever cswap has active for the default
 * instance. Any other instance is unknown, so a token instance with no slot never borrows the active login's limits.
 */
export function accountForInstance<A extends Pick<TessayaAccount, "key" | "active">>(
  instanceId: string,
  accounts: ReadonlyArray<A>,
): A | undefined {
  const key = BATON_CLAUDE_ACCOUNT_INSTANCES[instanceId];
  if (key !== undefined) return accounts.find((account) => account.key === key);
  return instanceId === BATON_DEFAULT_CLAUDE_INSTANCE
    ? accounts.find((account) => account.active)
    : undefined;
}

/** When a spent account has quota again: the last of its full windows to reset. */
export function accountReturnsAt(
  account: Pick<TessayaAccount, "headroomPercent" | "windows">,
): string | null {
  if (account.headroomPercent !== 0) return null;
  return (
    account.windows
      .filter((window) => window.usedPercent >= 100 && window.resetsAt !== null)
      .map((window) => window.resetsAt as string)
      .toSorted()
      .at(-1) ?? null
  );
}

/** Why no thread may move to this account now, or null when it may. */
export function accountRefusal(
  account: Pick<TessayaAccount, "label" | "unusableReason" | "headroomPercent" | "windows">,
): string | null {
  if (account.unusableReason === "signed-out") return `${account.label} is signed out`;
  if (account.headroomPercent !== 0) return null;
  const returnsAt = accountReturnsAt(account);
  return returnsAt === null
    ? `${account.label} has no quota left`
    : `${account.label} has no quota left until ${returnsAt.slice(0, 16).replace("T", " ")} UTC`;
}

export class TessayaAccountPoolUnavailableError extends Schema.TaggedError<TessayaAccountPoolUnavailableError>()(
  "FabricAccountPoolUnavailableError",
  { driver: ProviderDriverKind, detail: TrimmedNonEmptyString },
) {
  override get message(): string {
    return `No account pool for ${this.driver} on this machine: ${this.detail}`;
  }
}

export class TessayaAccountRotationRefusedError extends Schema.TaggedError<TessayaAccountRotationRefusedError>()(
  "FabricAccountRotationRefusedError",
  {
    key: TessayaAccountKey,
    reason: Schema.Literals(["unknown-account", "unusable", "already-active", "turn-in-flight"]),
    detail: Schema.NullOr(TrimmedNonEmptyString),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "unknown-account":
        return `No account '${this.key}' in this pool.`;
      case "unusable":
        return `Account '${this.key}' cannot be used: ${this.detail ?? "it is signed out or its limits cannot be read"}.`;
      case "already-active":
        return `Account '${this.key}' is already the one in use.`;
      case "turn-in-flight":
        return `A turn is running. The account changes between turns, never inside one.`;
    }
  }
}

export class TessayaAccountRotationFailedError extends Schema.TaggedError<TessayaAccountRotationFailedError>()(
  "FabricAccountRotationFailedError",
  { key: TessayaAccountKey, detail: TrimmedNonEmptyString },
) {
  override get message(): string {
    return `Could not switch to account '${this.key}': ${this.detail}`;
  }
}
