// @effect-diagnostics nodeBuiltinImport:off
/**
 * The brain's routing table on the server (tessaya-ops research/BRAIN-DESIGN.md §13): every model call asks it which
 * login and model to use, read when the call is made, so a change takes effect without a restart.
 */
import * as NodePath from "node:path";

import { deferNearLimit, instancePool } from "@t3tools/tessaya-shared/accountRotation";
import {
  brainRoute,
  credentialLabel,
  credentialOf,
  type BrainRoute,
} from "@t3tools/tessaya-shared/brainRoutes";
import { BATON_DEFAULT_CLAUDE_INSTANCE, ProviderDriverKind } from "@t3tools/tessaya-contracts";
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

/** Work nobody is waiting on: it can wait for the reset. Talking, hard tasks and reading a sentence never wait. */
const DEFERRABLE: ReadonlySet<BrainRole> = new Set(["background", "consolidation"]);

/**
 * Why a role's call waits instead of running now (B-031), or null: background work on its row's subscription or instance
 * when it is within the warning band and no other login has room, while `brainDeferNearLimit` is on (the default).
 */
export const deferredRole = Effect.fn("BrainRoutes.deferredRole")(function* (role: BrainRole) {
  if (!DEFERRABLE.has(role)) return null;
  const settings = yield* Effect.serviceOption(ServerSettingsService);
  if (Option.isSome(settings)) {
    const current = yield* settings.value.getSettings.pipe(Effect.option);
    if (Option.isSome(current) && !current.value.brainDeferNearLimit) return null;
  }
  const pool = yield* Effect.serviceOption(AccountPoolService);
  if (Option.isNone(pool)) return null;
  const routed = yield* routeFor(role).pipe(Effect.option);
  if (Option.isNone(routed)) return null;
  const route = routed.value;
  const credential = credentialOf(route.use);
  // An API key is paid per call and has no window to wait for.
  if (credential.kind === "apiKey") return null;
  // A named instance is read as its own pool; without cswap (the laptop) so is the subscription's default instance.
  const read =
    credential.kind === "instance"
      ? yield* readInstancePool(credential.instanceId)
      : yield* pool.value
          .read(ProviderDriverKind.make("claudeAgent"))
          .pipe(Effect.catch(() => readInstancePool(BATON_DEFAULT_CLAUDE_INSTANCE)));
  const defer = read === null ? null : deferNearLimit(read);
  return defer === null
    ? null
    : `${role} waits for the reset${defer.until === null ? "" : ` at ${defer.until}`}: ${credentialLabel(route.use)} has ${Math.round(defer.headroomPercent)}% left and no other login has room`;
});
