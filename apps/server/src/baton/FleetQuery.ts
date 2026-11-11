/* oxlint-disable t3code/no-low-value-comments -- Baton file predating upstream's rule (D82) */
/**
 * The environment's own answer to "what is everything doing?".
 *
 * Reads the same shell snapshot the clients stream, joins it to the work
 * sessions, and derives each state with the shared rules — so the server and a
 * client looking at the same instant agree.
 *
 * One input it cannot supply: `lastVisitedAt`. When *this user* last opened a
 * thread is client state and the environment has never been told. The server
 * therefore passes null, which makes its `done_unseen` mean "a turn completed
 * and nothing has happened since" rather than "you have not seen it". A client
 * building the same fleet locally passes its real value and gets the stricter
 * answer. See the maintainers' decision log D17.
 */
import {
  type AdoptedSessionCandidate,
  ProviderDriverKind,
  type BatonFleet,
  type BatonFleetAdopted,
} from "@t3tools/baton-contracts";
import {
  buildBatonFleet,
  filterFleetNeedsUser,
  type FleetThreadInput,
} from "@t3tools/baton-shared/fleet";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { AccountPoolService } from "./AccountPoolService.ts";
import { BatonEngine, batonStateInputFromShell } from "./BatonEngine.ts";
import { AdoptedSessionService } from "./AdoptedSessionService.ts";
import { readClaudeLiveSessions } from "./ClaudeLiveSessions.ts";
import { projectRefWithin } from "./ProjectRef.ts";
import { WorkSessionService } from "./WorkSessionService.ts";

/** A provider window at 100% is the account saying it is out, not a guess. */
const isExhausted = (usedPercent: number): boolean => usedPercent >= 100;

// shortcut: one Herdr discovery per 15 s for the whole server, because fleet.get
// is read on every repaint and discovery is several CLI calls; upgrade to
// Herdr's socket event stream when the adapter subscribes instead of polling.
const HERDR_CACHE_MS = 15_000;
// A repository lookup runs git, which a slow disk can hold for up to the runner's 60 s; the fleet answers without it.
const PROJECT_REF_BUDGET = "2 seconds";
let herdrCache: {
  at: number;
  candidates: ReadonlyArray<AdoptedSessionCandidate>;
  account: string | null;
} | null = null;

export const getFleet = Effect.fn("fabric.getFleet")(function* (input: {
  readonly includeArchived?: boolean | undefined;
  readonly needsUserOnly?: boolean | undefined;
}) {
  const workSessions = yield* WorkSessionService;
  const engine = yield* BatonEngine;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const adoptedSessions = yield* AdoptedSessionService;

  const sessions = yield* workSessions.list(
    input.includeArchived === undefined ? {} : { includeArchived: input.includeArchived },
  );

  const threads = new Map<string, FleetThreadInput>();
  for (const thread of yield* engine.threadShells) {
    const state = batonStateInputFromShell(thread);
    threads.set(thread.id, {
      threadId: thread.id,
      title: thread.title,
      branch: thread.branch,
      worktreePath: thread.worktreePath,
      hasPendingApprovals: state.hasPendingApprovals,
      hasPendingUserInput: state.hasPendingUserInput,
      sessionStatus: state.sessionStatus,
      sessionLastError: state.sessionLastError,
      backgroundLiveness: state.backgroundLiveness,
      latestTurnState: state.latestTurnState,
      latestTurnCompletedAt: state.latestTurnCompletedAt,
      updatedAt: state.updatedAt,
    });
  }

  const providers = yield* providerRegistry.getProviders.pipe(
    Effect.catchCause(() => Effect.succeed([])),
  );
  const exhausted = new Set<string>();
  for (const provider of providers) {
    const windows = provider.usageLimits?.windows ?? [];
    if (windows.some((window) => isExhausted(window.usedPercent))) {
      exhausted.add(provider.instanceId);
    }
  }

  // §9's adopted sessions: terminals Baton did not start. They belong in the
  // fleet for the same reason a thread does — the user asked "what is
  // everything doing" — and the entry's state takes them into account, so a
  // blocked Herdr pane makes the *work* say it needs you.
  const adoptedRows = yield* adoptedSessions
    .list({})
    .pipe(Effect.catchCause(() => Effect.succeed([])));
  const adopted = new Map<string, BatonFleetAdopted[]>();
  for (const session of adoptedRows) {
    if (session.workSessionId === null) continue;
    const existing = adopted.get(session.workSessionId);
    const row: BatonFleetAdopted = {
      id: session.id,
      runtime: session.runtime,
      label: session.label,
      state: session.state,
      canSendInput: session.capabilities.sendInput,
    };
    if (existing === undefined) adopted.set(session.workSessionId, [row]);
    else existing.push(row);
  }

  const nowMs = yield* Clock.currentTimeMillis;
  if (herdrCache === null || nowMs - herdrCache.at > HERDR_CACHE_MS) {
    const discovered = yield* adoptedSessions.discover.pipe(
      Effect.catchCause(() => Effect.succeed({ available: false, reason: "", candidates: [] })),
    );
    // Every session on this machine shares one config dir (D57), so the pool's
    // active account is the account behind all of them.
    const pool = yield* Effect.serviceOption(AccountPoolService);
    const account =
      pool._tag === "None"
        ? null
        : yield* pool.value.read(ProviderDriverKind.make("claudeAgent")).pipe(
            Effect.map((read) => read.accounts.find((entry) => entry.active)?.label ?? null),
            Effect.catchCause(() => Effect.succeed(null)),
          );
    herdrCache = { at: nowMs, candidates: discovered.candidates, account };
  }

  const built = buildBatonFleet({
    workSessions: sessions,
    threads,
    // The environment answering the question is by definition reachable.
    environmentOnline: true,
    exhaustedProviderInstanceIds: exhausted,
    lastVisitedAt: () => null,
    adopted,
    observedAt: DateTime.formatIso(yield* DateTime.now),
  });

  const live = yield* readClaudeLiveSessions({ account: herdrCache.account });
  const claudeSessions = yield* Effect.forEach(
    live,
    (session) =>
      Effect.map(projectRefWithin(session.cwd, PROJECT_REF_BUDGET), (project) => ({
        ...session,
        project,
      })),
    { concurrency: 4 },
  );
  const herdr = yield* Effect.forEach(
    herdrCache.candidates,
    (candidate) =>
      candidate.cwd == null
        ? Effect.succeed(candidate)
        : Effect.map(projectRefWithin(candidate.cwd, PROJECT_REF_BUDGET), (project) => ({
            ...candidate,
            project,
          })),
    { concurrency: 4 },
  );
  const fleet: BatonFleet = { ...built, herdr, claudeSessions };
  const result: BatonFleet = input.needsUserOnly === true ? filterFleetNeedsUser(fleet) : fleet;
  return result;
});
