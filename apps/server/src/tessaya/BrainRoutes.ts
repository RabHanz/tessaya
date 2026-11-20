// @effect-diagnostics nodeBuiltinImport:off
/**
 * The brain's routing table on the server (tessaya-ops research/BRAIN-DESIGN.md §13): every model call asks it which
 * login and model to use, read when the call is made, so a change takes effect without a restart.
 */
import * as NodePath from "node:path";

import {
  DEFAULT_ROTATION_THRESHOLDS,
  deferNearLimit,
  instancePool,
  rankRotationTargets,
} from "@t3tools/tessaya-shared/accountRotation";
import {
  brainRoute,
  credentialLabel,
  credentialOf,
  type BrainRoute,
} from "@t3tools/tessaya-shared/brainRoutes";
import {
  BATON_CLAUDE_ACCOUNT_INSTANCES,
  BATON_DEFAULT_CLAUDE_INSTANCE,
  ProviderDriverKind,
  type TessayaAccountPool,
} from "@t3tools/tessaya-contracts";
import { DEFAULT_ROUTING } from "@t3tools/tessaya-shared/costRouting";
import { DEFAULT_SERVER_SETTINGS, type BrainRole } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { AccountPoolService } from "./AccountPoolService.ts";
import { readRouting } from "./OperatingSystemPack.ts";

/**
 * A role's row, from the settings and `routing.json` of the caller's server. Read from the caller's context so plain
 * functions (a job's parts, the sentence reader) can ask without carrying the services in their types; without them
 * (a unit test) the table's unset rows apply, and the log says so.
 */
export const routeFor = Effect.fn("BrainRoutes.routeFor")(function* (role: BrainRole) {
  const settings = yield* Effect.serviceOption(ServerSettingsService);
  const config = yield* Effect.serviceOption(ServerConfig.ServerConfig);
  if (Option.isNone(settings))
    yield* Effect.logWarning("brain: no server settings here; the table's unset rows apply", {
      role,
    });
  return brainRoute(
    Option.isSome(settings) ? yield* settings.value.getSettings : DEFAULT_SERVER_SETTINGS,
    role,
    Option.isSome(config)
      ? readRouting(NodePath.dirname(config.value.dbPath)).cheap
      : DEFAULT_ROUTING.cheap,
  );
});

/**
 * The model a subscription-only path (a one-shot `claude -p`) runs a role on, or why it can't: the row's own login
 * when it is the server's subscription, else the subscription it names as its fallback. A row that names only an API
 * key is refused, never quietly run on the subscription.
 */
export const onSubscription = (
  route: BrainRoute,
): { readonly model: string } | { readonly refused: string } => {
  // shortcut: only the server's own Claude login ("") runs one-shots; named accounts arrive with the warm pool (B1b).
  // Its default instance is the same login; any other instance is another provider or config dir this path can't run.
  const own = [route.use, route.fallback].find(
    (c) => c === "subscription" || c === `instance:${BATON_DEFAULT_CLAUDE_INSTANCE}`,
  );
  return own === undefined
    ? {
        refused: `${route.role} is routed to ${credentialLabel(route.use)}, which this path can't use`,
      }
    : { model: route.model };
};

/** Any provider's instance as a pool of its own (instancePool), from this server's providers; null when unknown. */
export const readInstancePool = Effect.fn("BrainRoutes.readInstancePool")(function* (
  instanceId: string,
) {
  const registry = yield* Effect.serviceOption(ProviderRegistry.ProviderRegistry);
  if (Option.isNone(registry)) return null;
  const now = DateTime.formatIso(yield* DateTime.now);
  return instancePool(yield* registry.value.getProviders, instanceId, now);
});

/**
 * Where her own spoken and typed turns run when the machine login is at its limit: another account's instance config
 * dir with room, for that turn's session only. The machine login is never switched and no thread moves, so with
 * rotation off everywhere (Director, 20 Nov: on_limit=ask) she still answers. Null: the machine login as before.
 */
export const failoverDir = (
  pool: Pick<TessayaAccountPool, "accounts">,
  instances: Readonly<Record<string, string>>,
  homes: ReadonlyArray<{ readonly instanceId: string; readonly home: string | undefined }>,
): { readonly dir: string; readonly account: string } | null => {
  const active = pool.accounts.find((a) => a.active);
  if (
    active === undefined ||
    (active.usable &&
      (active.headroomPercent ?? 100) > DEFAULT_ROTATION_THRESHOLDS.rotateHeadroomPercent)
  )
    return null;
  for (const target of rankRotationTargets(
    pool,
    DEFAULT_ROTATION_THRESHOLDS.minimumTargetHeadroomPercent,
  )) {
    const instance = Object.entries(instances).find(([, slot]) => slot === target.key)?.[0];
    const dir = homes.find((h) => h.instanceId === instance)?.home;
    if (dir !== undefined) return { dir, account: target.label };
  }
  return null;
};

/** The config dir her brain's session runs in this turn (failoverDir), read from the pool and this server's instances. */
export const brainConfigDir = Effect.fn("BrainRoutes.brainConfigDir")(function* () {
  const pool = yield* Effect.serviceOption(AccountPoolService);
  const registry = yield* Effect.serviceOption(ProviderRegistry.ProviderRegistry);
  if (Option.isNone(pool) || Option.isNone(registry)) return null;
  const read = yield* pool.value.read(ProviderDriverKind.make("claudeAgent")).pipe(Effect.option);
  if (Option.isNone(read)) return null;
  const providers = yield* registry.value.getProviders;
  return failoverDir(
    read.value,
    BATON_CLAUDE_ACCOUNT_INSTANCES,
    providers.map((p) => ({ instanceId: String(p.instanceId), home: p.runtimePaths?.homePath })),
  );
});

/** Work nobody is waiting on: it can wait for the reset. Talking, hard tasks and reading a sentence never wait. */
const DEFERRABLE: ReadonlySet<BrainRole> = new Set(["background", "consolidation"]);

/**
 * The account `instanceId` runs on, when it is within the warning band and no other login has room (B-031): its reset
 * and headroom, or null to go on. Off when `brainDeferNearLimit` is off. Talking never asks; background work and jobs do.
 */
export const accountPause = Effect.fn("BrainRoutes.accountPause")(function* (instanceId: string) {
  const settings = yield* Effect.serviceOption(ServerSettingsService);
  if (Option.isSome(settings)) {
    const current = yield* settings.value.getSettings.pipe(Effect.option);
    if (Option.isSome(current) && !current.value.brainDeferNearLimit) return null;
  }
  const pool = yield* Effect.serviceOption(AccountPoolService);
  // The default instance is cswap's machine login where cswap exists; elsewhere (the laptop) its reported limits.
  const read =
    instanceId === BATON_DEFAULT_CLAUDE_INSTANCE && Option.isSome(pool)
      ? yield* pool.value
          .read(ProviderDriverKind.make("claudeAgent"))
          .pipe(Effect.catch(() => readInstancePool(instanceId)))
      : yield* readInstancePool(instanceId);
  return read === null ? null : deferNearLimit(read);
});

/** Why a role's call waits instead of running now (B-031), or null: background work on its row's subscription or instance. */
export const deferredRole = Effect.fn("BrainRoutes.deferredRole")(function* (role: BrainRole) {
  if (!DEFERRABLE.has(role)) return null;
  const routed = yield* routeFor(role).pipe(Effect.option);
  if (Option.isNone(routed)) return null;
  const route = routed.value;
  const credential = credentialOf(route.use);
  // An API key is paid per call and has no window to wait for.
  if (credential.kind === "apiKey") return null;
  const defer = yield* accountPause(
    credential.kind === "instance" ? credential.instanceId : BATON_DEFAULT_CLAUDE_INSTANCE,
  );
  return defer === null
    ? null
    : `${role} waits for the reset${defer.until === null ? "" : ` at ${defer.until}`}: ${credentialLabel(route.use)} has ${Math.round(defer.headroomPercent)}% left and no other login has room`;
});
