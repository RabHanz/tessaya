/**
 * Every live session on this server and on each linked environment, as Baton's window lists them (GEN-6), so
 * the desktop reads them through its door with T3's window closed. A peer is read with its outside tool
 * `tessaya_fleet`, redacted there; each row carries the access of the link it came over.
 */
import {
  BatonFleetResult,
  type BatonFleet,
  type BatonSessionsAcrossResult,
  type WorkSessionError,
} from "@t3tools/baton-contracts";
import {
  batonSessionSummaries,
  buildBatonProjects,
  workAccount,
  type BatonSessionRow,
} from "@t3tools/baton-shared/batonProjects";
import { batonProjectKey } from "@t3tools/baton-shared/jobPlacement";
import type {
  AuthMcpClientAccess,
  EnvironmentId,
  OrchestrationProjectShell,
  PeerLinkSummary,
  ServerProvider,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { AdoptedSessionService } from "./AdoptedSessionService.ts";
import { BatonEngine } from "./BatonEngine.ts";
import * as FleetQuery from "./FleetQuery.ts";
import { WorkSessionService } from "./WorkSessionService.ts";

const PEER_TIMEOUT = "8 seconds";

export interface ListedEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly fleet: BatonFleet;
  /** Null for this server; a peer's rows are typed into only over a real client session, never the link. */
  readonly access: AuthMcpClientAccess | null;
}

/** The rows for every environment that answered; a linked server resolved its own rows' projects and accounts. */
export const summariesAcross = (input: {
  readonly environments: ReadonlyArray<ListedEnvironment>;
  readonly projects: ReadonlyArray<OrchestrationProjectShell>;
  readonly providers: ReadonlyArray<ServerProvider>;
}): BatonSessionsAcrossResult["sessions"] => {
  const here = input.environments.find((env) => env.access === null)?.environmentId;
  const projects = new Map(input.projects.map((project) => [project.id as string, project]));
  const labels = new Map(
    input.providers.map((provider) => [provider.instanceId as string, provider.displayName]),
  );
  const access = new Map(input.environments.map((env) => [env.environmentId, env.access]));
  const account = (row: BatonSessionRow): string | null => {
    if (row.kind === "claude") return row.account;
    if (row.kind !== "work") return null;
    return row.environmentId === here
      ? workAccount(row.entry, (id) => labels.get(id))
      : (row.entry.account ?? null);
  };
  const groups = buildBatonProjects({
    environments: input.environments.map((env) => ({
      environmentId: env.environmentId,
      environmentLabel: env.label,
      entries: env.fleet.entries,
      herdr: env.fleet.herdr ?? [],
      claude: env.fleet.claudeSessions ?? [],
    })),
    resolveWorkProject: (environmentId, projectId) => {
      const project = environmentId === here ? projects.get(projectId) : undefined;
      return project === undefined ? null : batonProjectKey(project);
    },
  });
  // Summaries come out in the groups' row order.
  const rows = groups.flatMap((group) => group.rows);
  return batonSessionSummaries(groups, account).map((summary, i) => ({
    ...summary,
    // A row whose environment is not known is treated as the most restricted link, never as this server's.
    access: access.has(rows[i]!.environmentId) ? access.get(rows[i]!.environmentId)! : "read-only",
  }));
};

/** Each usable link's fleet; one that fails or is slow is reported, and the others are still listed. */
export const peerFleets = Effect.fn("BatonSessionsAcross.peerFleets")(function* (
  links: ReadonlyArray<PeerLinkSummary>,
) {
  const mcp = yield* PeerMcpClient.PeerMcpClient;
  const usable = links.filter((link) => link.status !== "expired");
  const answers = yield* Effect.forEach(
    usable,
    (link) =>
      mcp
        .call({
          environmentId: link.environmentId,
          tool: "tessaya_fleet",
          arguments: {},
          limits: { runtimeMode: "approval-required", interactionMode: "default" },
          success: BatonFleetResult,
        })
        .pipe(
          Effect.timeout(PEER_TIMEOUT),
          Effect.map(({ fleet }) => ({ link, fleet })),
          Effect.orElseSucceed(() => ({ link, fleet: null })),
        ),
    { concurrency: "unbounded" },
  );
  return {
    listed: answers.flatMap(({ link, fleet }): ReadonlyArray<ListedEnvironment> =>
      fleet === null
        ? []
        : [{ environmentId: link.environmentId, label: link.label, fleet, access: link.access }],
    ),
    unreachable: [
      ...links.filter((link) => link.status === "expired"),
      ...answers.flatMap(({ link, fleet }) => (fleet === null ? [link] : [])),
    ].map((link) => ({ environmentId: link.environmentId as string, label: link.label })),
  };
});

/**
 * One run shared by every caller and kept for `ttlMs`. Unlike `Effect.cachedWithTTL`, a caller that gives up (the
 * desktop's door stops at 20 s) does not abandon the run, so a slow listing finishes once instead of restarting forever.
 */
export const sharedRun = Effect.fn("BatonSessionsAcross.sharedRun")(function* <A, E>(
  run: Effect.Effect<A, E>,
  ttlMs: number,
) {
  const scope = yield* Scope.Scope;
  let kept: { readonly at: number; readonly exit: Exit.Exit<A, E> } | null = null;
  let running: Fiber.Fiber<A, E> | null = null;
  return Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    if (kept !== null && now - kept.at < ttlMs) return yield* kept.exit;
    running ??= yield* run.pipe(
      Effect.onExit((exit) =>
        Effect.map(Clock.currentTimeMillis, (at) => {
          kept = { at, exit };
          running = null;
        }),
      ),
      Effect.forkIn(scope),
    );
    return yield* Fiber.join(running);
  });
});

export class BatonSessionsAcross extends Context.Service<
  BatonSessionsAcross,
  {
    /** `hereOnly`: this server's own rows alone, cheap and fresh, for a check just before typing. */
    readonly list: (input: {
      readonly hereOnly?: boolean | undefined;
    }) => Effect.Effect<BatonSessionsAcrossResult, WorkSessionError>;
  }
>()("t3/baton/BatonSessionsAcross") {}

export const make = Effect.gen(function* () {
  const local = yield* Effect.context<
    | WorkSessionService
    | BatonEngine
    | ProviderRegistry.ProviderRegistry
    | AdoptedSessionService
    | ServerEnvironment.ServerEnvironment
    | PeerLinks.PeerLinks
    | PeerMcpClient.PeerMcpClient
  >();
  const list = Effect.fn("BatonSessionsAcross.list")(function* (hereOnly: boolean) {
    const descriptor = yield* (yield* ServerEnvironment.ServerEnvironment).getDescriptor;
    const fleet = yield* FleetQuery.getFleet({});
    const engine = yield* BatonEngine;
    const peerLinks = yield* PeerLinks.PeerLinks;
    // Linked environments switched off in settings are not read at all.
    const links =
      !hereOnly && (yield* peerLinks.enabled)
        ? yield* peerLinks.list.pipe(Effect.orElseSucceed(() => []))
        : [];
    const peers = yield* peerFleets(links);
    return {
      here: { environmentId: descriptor.environmentId, label: descriptor.label },
      sessions: summariesAcross({
        environments: [
          { environmentId: descriptor.environmentId, label: descriptor.label, fleet, access: null },
          ...peers.listed,
        ],
        projects: yield* engine.projects,
        providers: yield* (yield* ProviderRegistry.ProviderRegistry).getProviders,
      }),
      unreachable: peers.unreachable,
    };
  });
  // Callers share one listing in flight and its answer for a few seconds, so a looping client cannot multiply peer calls.
  const across = yield* sharedRun(Effect.provideContext(list(false), local), 5_000);
  const here = Effect.provideContext(list(true), local);
  return BatonSessionsAcross.of({
    list: Effect.fn("BatonSessionsAcross.listFor")(function* (input) {
      return yield* input.hereOnly === true ? here : across;
    }),
  });
});

export const layer = Layer.effect(BatonSessionsAcross, make);
