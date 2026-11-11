/* oxlint-disable t3code/no-em-dash-copy, t3code/no-low-value-comments, t3code/prefer-effect-fn -- Baton file predating upstream's rule (D82) */
// @effect-diagnostics effectFnOpportunity:off flatMapConditionalToFilterOrFail:off preferSchemaOverJson:off instanceOfSchema:off preferSucceedSomeOrNone:off
/**
 * The accounts one config directory can run as, and moving between them.
 *
 * **Why this exists at all, and why it is not a handoff.** A provider thread is
 * bound to its config directory, not to an account: upstream's own rule is that
 * a thread may switch "only between instances with the same config directory".
 * Swapping the credential *inside* that directory therefore keeps the session
 * id, the transcript, the resume cursor and the working directory exactly where
 * they were — which is what the Director already does by hand between three
 * Claude logins. The capsule handoff (§6.1) remains for what this cannot do: a
 * different config directory, or a different provider.
 *
 * **Why the switch is delegated rather than reimplemented.** `cswap` owns a
 * store with a lock, per-account credential backups and an atomic publish step
 * whose own comment is "nothing can fail after the file is published". Writing
 * into that store from here would race it and could lose a credential. So the
 * adapter reads its documented JSON and asks *it* to switch. Where cswap is
 * absent there is no pool yet, and the surface says so rather than pretending.
 *
 * @module baton/AccountPoolService
 */
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  BatonAccountPoolUnavailableError,
  BatonAccountRotationFailedError,
  BatonAccountRotationRefusedError,
  headroomFromWindows,
  ProviderDriverKind,
  type BatonAccount,
  type BatonAccountPool,
  type BatonAccountRotation,
  type BatonAccountRotationReason,
  type WorkSessionId,
} from "@t3tools/baton-contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { collectStreamAsString } from "@t3tools/provider-core/server/snapshotProbe";

/** cswap's `--json` contract, which carries its own `schemaVersion`. */
const CswapUsageWindow = Schema.Struct({
  pct: Schema.optional(Schema.Union([Schema.Number, Schema.Null])),
  resetsAt: Schema.optional(Schema.Union([Schema.String, Schema.Null])),
});

const CswapAccount = Schema.Struct({
  number: Schema.Number,
  email: Schema.optional(Schema.Union([Schema.String, Schema.Null])),
  alias: Schema.optional(Schema.Union([Schema.String, Schema.Null])),
  organizationName: Schema.optional(Schema.Union([Schema.String, Schema.Null])),
  active: Schema.optional(Schema.Boolean),
  usageStatus: Schema.optional(Schema.Union([Schema.String, Schema.Null])),
  usageFetchedAt: Schema.optional(Schema.Union([Schema.String, Schema.Null])),
  usage: Schema.optional(
    Schema.Union([
      Schema.Struct({
        fiveHour: Schema.optional(Schema.Union([CswapUsageWindow, Schema.Null])),
        sevenDay: Schema.optional(Schema.Union([CswapUsageWindow, Schema.Null])),
        sevenDayOpus: Schema.optional(Schema.Union([CswapUsageWindow, Schema.Null])),
      }),
      Schema.Null,
    ]),
  ),
});

const CswapList = Schema.Struct({
  schemaVersion: Schema.Number,
  activeAccountNumber: Schema.optional(Schema.Union([Schema.Number, Schema.Null])),
  accounts: Schema.Array(CswapAccount),
});

const decodeCswapList = Schema.decodeUnknownOption(Schema.fromJsonString(CswapList));

/** The schema this adapter was written against. A newer one is read, not trusted blindly. */
const SUPPORTED_CSWAP_SCHEMA = 1;

export class AccountPoolService extends Context.Service<
  AccountPoolService,
  {
    /**
     * The accounts available to this driver's config directory, newest usage
     * first. Fails when the machine has no pool at all, which is not an error
     * so much as a fact a surface has to state.
     */
    readonly read: (
      driver: ProviderDriverKind,
    ) => Effect.Effect<BatonAccountPool, BatonAccountPoolUnavailableError>;
    /** Swap the credential in that directory. Never called inside a turn. */
    readonly activate: (input: {
      readonly driver: ProviderDriverKind;
      readonly key: string;
      readonly reason: BatonAccountRotationReason;
      readonly workSessionId: WorkSessionId | null;
    }) => Effect.Effect<
      { readonly rotation: BatonAccountRotation; readonly pool: BatonAccountPool },
      | BatonAccountPoolUnavailableError
      | BatonAccountRotationRefusedError
      | BatonAccountRotationFailedError
    >;
  }
>()("t3/baton/AccountPoolService") {}

const CSWAP_BINARY = process.env.T3CODE_CSWAP_BINARY ?? "cswap";

const windowsOf = (account: typeof CswapAccount.Type) => {
  const usage = account.usage ?? null;
  if (usage === null) return [];
  const entries: Array<{
    readonly id: string;
    readonly label: string;
    readonly usedPercent: number;
    readonly resetsAt: string | null;
  }> = [];
  const add = (
    id: string,
    label: string,
    window: typeof CswapUsageWindow.Type | null | undefined,
  ) => {
    const pct = window?.pct;
    if (typeof pct !== "number") return;
    entries.push({ id, label, usedPercent: pct, resetsAt: window?.resetsAt ?? null });
  };
  add("five_hour", "5h", usage.fiveHour ?? null);
  add("seven_day", "7d", usage.sevenDay ?? null);
  add("seven_day_opus", "7d (large model)", usage.sevenDayOpus ?? null);
  return entries;
};

/**
 * `relogin_required` is the interesting one: the account is still listed, still
 * has its identity, and cannot be used until somebody signs it in. Two of the
 * three accounts on the Director's local box are in exactly that state.
 */
const usability = (
  account: typeof CswapAccount.Type,
  headroom: number | null,
): { readonly usable: boolean; readonly reason: BatonAccount["unusableReason"] } => {
  const status = account.usageStatus ?? null;
  if (status === "relogin_required" || status === "login_required") {
    return { usable: false, reason: "signed-out" };
  }
  if (status === "disabled") return { usable: false, reason: "disabled" };
  if (headroom === null) return { usable: false, reason: "limits-unknown" };
  return { usable: true, reason: null };
};

const toBatonAccount = (
  account: typeof CswapAccount.Type,
  activeNumber: number | null,
): BatonAccount => {
  const windows = windowsOf(account);
  const headroom = headroomFromWindows(windows);
  const { usable, reason } = usability(account, headroom);
  const email = account.email?.trim() || null;
  const label = account.alias?.trim() || email?.split("@")[0] || `Account ${account.number}`;
  return {
    key: String(account.number),
    label,
    email,
    organizationName: account.organizationName?.trim() || null,
    active: account.active === true || activeNumber === account.number,
    usable,
    unusableReason: reason,
    headroomPercent: headroom,
    windows,
    usageCheckedAt: account.usageFetchedAt?.trim() || null,
  };
};

const runCswapWith =
  (spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]) => (args: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const child = yield* spawner.spawn(ChildProcess.make(CSWAP_BINARY, [...args]));
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          collectStreamAsString(child.stdout),
          collectStreamAsString(child.stderr),
          child.exitCode.pipe(Effect.map(Number)),
        ],
        { concurrency: "unbounded" },
      );
      return { stdout: stdout ?? "", stderr: stderr ?? "", code: exitCode };
    }).pipe(Effect.scoped);

/** `cswap list --token-status`: each slot's credential described (kind, expiry, refresh token), never its value. */
export const makeTokenStatusReader =
  (spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]) => (): Effect.Effect<string> =>
    runCswapWith(spawner)(["list", "--token-status"]).pipe(
      Effect.map((result) => (result.code === 0 ? result.stdout : "")),
      // cswap fetches usage over the network; a hung call must not hold the accounts list.
      Effect.timeout(Duration.seconds(5)),
      Effect.orElseSucceed(() => ""),
    );

/** Reads cswap's pool. Exported for the provider snapshot, which needs the same reading (D92). */
export const makePoolReader =
  (spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]) => (driver: ProviderDriverKind) =>
    Effect.gen(function* () {
      const runCswap = runCswapWith(spawner);
      if (driver !== "claudeAgent") {
        return yield* new BatonAccountPoolUnavailableError({
          driver,
          detail: "only Claude accounts can be rotated in place today",
        });
      }
      const result = yield* runCswap(["list", "--json"]).pipe(
        Effect.catch((cause) =>
          Effect.succeed({ stdout: "", stderr: String(cause), code: 127 } as const),
        ),
      );
      if (result.code !== 0 || result.stdout.trim().length === 0) {
        return yield* new BatonAccountPoolUnavailableError({
          driver,
          detail:
            result.code === 127
              ? "no account switcher is installed here (cswap)"
              : `the account switcher exited ${result.code}`,
        });
      }
      // The banner cswap prints when an upgrade is available precedes the JSON.
      const jsonStart = result.stdout.indexOf("{");
      const decoded =
        jsonStart === -1 ? undefined : decodeCswapList(result.stdout.slice(jsonStart));
      if (decoded === undefined || decoded._tag === "None") {
        return yield* new BatonAccountPoolUnavailableError({
          driver,
          detail: "the account switcher's output could not be read",
        });
      }
      const listing = decoded.value;
      if (listing.schemaVersion !== SUPPORTED_CSWAP_SCHEMA) {
        return yield* new BatonAccountPoolUnavailableError({
          driver,
          detail: `the account switcher reports schema ${listing.schemaVersion}, and this build reads ${SUPPORTED_CSWAP_SCHEMA}`,
        });
      }
      const activeNumber = listing.activeAccountNumber ?? null;
      const env = yield* HostProcess.Environment;
      return {
        driver,
        source: "cswap" as const,
        configDir: env.CLAUDE_CONFIG_DIR ?? `${env.HOME ?? "~"}/.claude`,
        accounts: listing.accounts.map((account) => toBatonAccount(account, activeNumber)),
        checkedAt: DateTime.formatIso(yield* DateTime.now),
      } as BatonAccountPool;
    });

export const make = Effect.gen(function* () {
  // Acquired once, so the service's own methods carry no requirement.
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const runCswap = runCswapWith(spawner);
  const readPool = makePoolReader(spawner);

  const activate: AccountPoolService["Service"]["activate"] = (input) =>
    Effect.gen(function* () {
      const pool = yield* readPool(input.driver);
      const target = pool.accounts.find((account) => account.key === input.key);
      if (target === undefined) {
        return yield* new BatonAccountRotationRefusedError({
          key: input.key,
          reason: "unknown-account",
          detail: null,
        });
      }
      if (target.active) {
        return yield* new BatonAccountRotationRefusedError({
          key: input.key,
          reason: "already-active",
          detail: null,
        });
      }
      // A person may still choose an account whose limits are unreadable; they
      // may not choose one that is signed out, because it cannot answer.
      if (target.unusableReason === "signed-out" || target.unusableReason === "disabled") {
        return yield* new BatonAccountRotationRefusedError({
          key: input.key,
          reason: "unusable",
          detail:
            target.unusableReason === "signed-out"
              ? "its stored login has expired — sign it in, then try again"
              : "it is held out of rotation",
        });
      }
      const from = pool.accounts.find((account) => account.active) ?? null;

      const switched = yield* runCswap(["switch", input.key]).pipe(
        Effect.catch((cause) =>
          Effect.succeed({ stdout: "", stderr: String(cause), code: 127 } as const),
        ),
      );
      if (switched.code !== 0) {
        return yield* new BatonAccountRotationFailedError({
          key: input.key,
          detail: switched.stderr.trim().slice(0, 300) || `the switcher exited ${switched.code}`,
        });
      }

      // Trust the store, not the exit code: read it back and check who is active.
      const after = yield* readPool(input.driver);
      const nowActive = after.accounts.find((account) => account.active) ?? null;
      if (nowActive === null || nowActive.key !== input.key) {
        return yield* new BatonAccountRotationFailedError({
          key: input.key,
          detail: `the switcher reported success and ${nowActive?.label ?? "nothing"} is active`,
        });
      }

      return {
        rotation: {
          fromKey: from?.key ?? null,
          fromLabel: from?.label ?? null,
          toKey: nowActive.key,
          toLabel: nowActive.label,
          reason: input.reason,
          workSessionId: input.workSessionId,
          toHeadroomPercent: nowActive.headroomPercent,
          rotatedAt: DateTime.formatIso(yield* DateTime.now),
        } as BatonAccountRotation,
        pool: after,
      };
    });

  return AccountPoolService.of({ read: readPool, activate });
});

export const layer = Layer.effect(AccountPoolService, make);
