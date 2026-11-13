// @effect-diagnostics nodeBuiltinImport:off
/**
 * The brain's routing table on the server (tessaya-ops research/BRAIN-DESIGN.md §13): every model call asks it which
 * login and model to use, read when the call is made, so a change takes effect without a restart.
 */
import * as NodePath from "node:path";

import { brainRoute, credentialLabel, type BrainRoute } from "@t3tools/baton-shared/brainRoutes";
import { DEFAULT_ROUTING } from "@t3tools/baton-shared/costRouting";
import { DEFAULT_SERVER_SETTINGS, type BrainRole } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
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
  const own = [route.use, route.fallback].find((c) => c === "subscription");
  return own === undefined
    ? {
        refused: `${route.role} is routed to ${credentialLabel(route.use)}, which this path can't use`,
      }
    : { model: route.model };
};
