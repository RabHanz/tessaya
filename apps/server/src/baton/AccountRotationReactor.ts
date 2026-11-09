/* oxlint-disable t3code/no-low-value-comments -- Baton file predating upstream's rule (D82) */
/**
 * The trigger for automatic account rotation (D63, L-76).
 *
 * T3 threads: an account is a provider instance, and its limits are the ones the provider reports in
 * the instance's snapshot. Every tick, each instance with working threads is weighed against the
 * instances that share its transcripts (the same continuation group), and when the tested policy
 * (`decideRotation`) says rotate, those threads move through ThreadAccountMoves: at once when idle,
 * at the end of the turn when one is running. Idle threads stay where he put them.
 *
 * Terminal sessions (Herdr) still run on cswap's machine login, so that login rotates as before and
 * idle panes are respawned on it. On by the Settings row (AccountRotationPolicy).
 *
 * shortcut: a poll, not a subscription to the limit event. Upgrade when provider runtime events
 * carry the limit to a reactor.
 */
import { BATON_DEFAULT_CLAUDE_INSTANCE, ProviderDriverKind } from "@t3tools/baton-contracts";
import {
  activeAccount,
  decideRotation,
  type BatonOnLimitPolicy,
  type RotationDecision,
} from "@t3tools/baton-shared/accountRotation";
import {
  instanceAccount,
  type BatonAccount,
  type BatonAccountPool,
} from "@t3tools/baton-contracts";
import {
  isListedThreadLineage,
  isLiveSubagentShell,
  type OrchestrationV2ThreadShell,
  type ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";

import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { AccountPoolService } from "./AccountPoolService.ts";
import { AccountRotationPolicy } from "./AccountRotationPolicy.ts";
import { BatonEngine } from "./BatonEngine.ts";
import { isLiveThreadId } from "@t3tools/baton-shared/liveThread";
import {
  isThreadConfigDir,
  readAllProfileLiveSessions,
  readClaudeLiveSessions,
  threadDirSlot,
} from "./ClaudeLiveSessions.ts";
import { liveSetAccount } from "./LiveActions.ts";
import { respawnClaudeInPane } from "./HerdrRespawn.ts";
import { ThreadAccountMoves } from "./ThreadAccountMoves.ts";

const DRIVER = ProviderDriverKind.make("claudeAgent");
const TICK = "2 minutes";

/** The reset time of the active account's tightest window: the limit that is running out. */
export const sourceWindowResetsAt = (pool: BatonAccountPool): string | null => {
  const from = activeAccount(pool);
  if (from === null || from.windows.length === 0) return null;
  const tightest = from.windows.toSorted((a, b) => b.usedPercent - a.usedPercent)[0];
  return tightest?.resetsAt ?? null;
};

/** A spent window is a reported limit, which outranks any headroom estimate. */
export const limitReached = (pool: BatonAccountPool): boolean =>
  (activeAccount(pool)?.windows ?? []).some((window) => window.usedPercent >= 100);

/** One tick, pure: what the policy says given the pool and the last automatic rotation. */
export const rotationTick = (input: {
  readonly pool: BatonAccountPool;
  readonly policy: BatonOnLimitPolicy;
  readonly lastAutoRotationAt: string | null;
  readonly now: string;
}): RotationDecision =>
  decideRotation({
    pool: input.pool,
    policy: input.policy,
    lastAutoRotationAt: input.lastAutoRotationAt,
    sourceWindowResetsAt: sourceWindowResetsAt(input.pool),
    limitReached: limitReached(input.pool),
    now: input.now,
  });

// An automatic pick needs a fresh reading: a target read longer ago than this counts as unknown.
const TARGET_FRESH_MS = 30 * 60_000;

const freshOrUnknown = (account: BatonAccount, nowMs: number): BatonAccount =>
  account.active ||
  account.usageCheckedAt === null ||
  nowMs - Date.parse(account.usageCheckedAt) <= TARGET_FRESH_MS
    ? account
    : { ...account, usable: false, unusableReason: "limits-unknown", headroomPercent: null };

/** The accounts a thread on `instanceId` can resume on: Claude instances sharing its transcripts. */
export const instancePool = (
  providers: ReadonlyArray<ServerProvider>,
  instanceId: string,
  now: string,
  exclude: ReadonlySet<string> = new Set(),
): BatonAccountPool | null => {
  const source = providers.find((provider) => provider.instanceId === instanceId);
  if (source === undefined || source.driver !== DRIVER) return null;
  const group = source.continuation?.groupKey;
  const peers = providers.filter(
    (provider) =>
      provider.instanceId === instanceId ||
      (provider.driver === DRIVER &&
        provider.enabled &&
        provider.installed &&
        !exclude.has(provider.instanceId) &&
        group !== undefined &&
        provider.continuation?.groupKey === group),
  );
  const nowMs = Date.parse(now);
  return {
    driver: DRIVER,
    source: "instances",
    configDir: group ?? instanceId,
    accounts: peers.map((provider) =>
      freshOrUnknown(instanceAccount(provider, provider.instanceId === instanceId), nowMs),
    ),
    checkedAt: now,
  } as BatonAccountPool;
};

/** A thread doing work now, or stopped by a limit; an idle thread keeps the account he chose. */
export const threadIsWorking = (shell: OrchestrationV2ThreadShell): boolean =>
  shell.archivedAt === null &&
  shell.deletedAt === null &&
  isListedThreadLineage(shell.lineage) &&
  (isLiveSubagentShell(shell) || (shell.limitRecovery ?? null) !== null);

export interface ThreadMove {
  readonly threadId: OrchestrationV2ThreadShell["id"];
  readonly from: BatonAccount | null;
  readonly target: BatonAccount;
  readonly reason: "limit" | "policy";
}

/**
 * Pure: which working threads move where. The cooldown and the once-per-window rule are per thread, so
 * one thread's move never holds back new work on the same account. A thread is left alone when he has
 * already chosen another instance for it, a move is waiting, or he keeps it where it is (`held`).
 */
export const planThreadMoves = (input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly shells: ReadonlyArray<OrchestrationV2ThreadShell>;
  readonly lastAutoRotationAt: ReadonlyMap<string, string>;
  readonly held: ReadonlySet<string>;
  /** Instances that are neither a source nor a target here (the default one while cswap rotates it). */
  readonly exclude: ReadonlySet<string>;
  readonly now: string;
}): ReadonlyArray<ThreadMove> => {
  const pools = new Map<string, BatonAccountPool | null>();
  const poolFor = (instanceId: string) => {
    if (!pools.has(instanceId))
      pools.set(instanceId, instancePool(input.providers, instanceId, input.now, input.exclude));
    return pools.get(instanceId) ?? null;
  };
  return input.shells.flatMap((shell): ReadonlyArray<ThreadMove> => {
    const instanceId = shell.providerInstanceId;
    if (
      !threadIsWorking(shell) ||
      input.held.has(shell.id) ||
      shell.modelSelection.instanceId !== instanceId ||
      input.exclude.has(instanceId)
    )
      return [];
    const pool = poolFor(instanceId);
    if (pool === null) return [];
    const decision = rotationTick({
      pool,
      policy: "auto",
      lastAutoRotationAt: input.lastAutoRotationAt.get(shell.id) ?? null,
      now: input.now,
    });
    return decision.outcome === "rotate"
      ? [
          {
            threadId: shell.id,
            from: decision.from,
            target: decision.target,
            reason: decision.reason,
          },
        ]
      : [];
  });
};

/**
 * Pure: which live sessions in their own config dirs move where (LIVE-ACCOUNT). Each is weighed on its own login, so
 * one thread near its limit moves alone and nothing else does; a kept thread stays.
 */
export const planLiveSessionMoves = (input: {
  readonly pool: BatonAccountPool;
  readonly sessions: ReadonlyArray<{ readonly sessionId: string; readonly slot: string }>;
  readonly kept: (sessionId: string) => boolean;
  readonly lastAutoRotationAt: ReadonlyMap<string, string>;
  readonly now: string;
}): ReadonlyArray<{ readonly sessionId: string; readonly target: BatonAccount }> =>
  input.sessions.flatMap((session) => {
    if (input.kept(session.sessionId)) return [];
    const own = {
      ...input.pool,
      accounts: input.pool.accounts.map((account) => ({
        ...account,
        active: account.key === session.slot,
      })),
    };
    if (!own.accounts.some((account) => account.active)) return [];
    const decision = rotationTick({
      pool: own,
      policy: "auto",
      lastAutoRotationAt: input.lastAutoRotationAt.get(session.sessionId) ?? null,
      now: input.now,
    });
    return decision.outcome === "rotate"
      ? [{ sessionId: session.sessionId, target: decision.target }]
      : [];
  });

export const make = Effect.gen(function* () {
  const policy = yield* AccountRotationPolicy;
  const pool = yield* AccountPoolService;
  const registry = yield* ProviderRegistry.ProviderRegistry;
  const engine = yield* BatonEngine;
  const moves = yield* ThreadAccountMoves;
  const threadRotatedAt = new Map<string, string>();
  const sessionRotatedAt = new Map<string, string>();

  // Live sessions in their own config dirs move one by one, while they run (LIVE-ACCOUNT).
  const moveLiveSessions = Effect.fn("AccountRotationReactor.moveLiveSessions")(function* (
    now: string,
    current: BatonAccountPool,
  ) {
    const held = yield* moves.held;
    const sessions = (yield* readAllProfileLiveSessions()).flatMap((session) => {
      const slot = isThreadConfigDir(session.configDir) ? threadDirSlot(session.configDir) : null;
      return slot === null ? [] : [{ sessionId: session.sessionId, slot }];
    });
    const planned = planLiveSessionMoves({
      pool: current,
      sessions,
      kept: (sessionId) =>
        [...held].some(
          (threadId) => isLiveThreadId(threadId) && threadId.endsWith(`:${sessionId}`),
        ),
      lastAutoRotationAt: sessionRotatedAt,
      now,
    });
    for (const move of planned) {
      const result = yield* liveSetAccount(
        { sessionId: move.sessionId, accountKey: move.target.key },
        current.accounts,
      );
      // A refused move waits out the same cooldown as a done one, so it is tried (and logged) once per 15 minutes,
      // and the policy's floor, hysteresis and once-per-window rule keep two tight accounts from trading it back.
      sessionRotatedAt.set(move.sessionId, now);
      if (result.state === "switched")
        yield* Effect.logInfo("Tessaya moved a live session to another account near its limit", {
          sessionId: move.sessionId,
          to: move.target.label,
        });
      else
        yield* Effect.logWarning("Tessaya could not move a live session near its limit", {
          sessionId: move.sessionId,
          to: move.target.label,
          state: result.state,
          detail: result.detail,
        });
    }
  });
  let lastAutoRotationAt: string | null = null;

  const moveThreads = Effect.fn("AccountRotationReactor.moveThreads")(function* (
    now: string,
    exclude: ReadonlySet<string>,
  ) {
    const planned = planThreadMoves({
      providers: yield* registry.getProviders,
      shells: yield* engine.threadShells,
      lastAutoRotationAt: threadRotatedAt,
      held: yield* moves.held,
      exclude,
      now,
    });
    for (const move of planned) {
      const result = yield* moves
        .request({ threadId: move.threadId, instanceId: move.target.key })
        .pipe(Effect.option);
      if (result._tag === "None") continue;
      // Recorded only once the move took, so a failed one is tried again on the next tick.
      threadRotatedAt.set(move.threadId, now);
      yield* Effect.logInfo("Tessaya moved a thread to another account on a limit", {
        threadId: move.threadId,
        from: move.from?.label ?? null,
        to: move.target.label,
        reason: move.reason,
      });
    }
  });

  // The machine login his terminal sessions run on (cswap).
  const rotateTerminalLogin = Effect.fn("AccountRotationReactor.rotateTerminalLogin")(function* (
    now: string,
    current: BatonAccountPool,
  ) {
    const decision = rotationTick({
      pool: current,
      policy: "auto",
      lastAutoRotationAt,
      now,
    });
    if (decision.outcome !== "rotate") return;
    yield* pool.activate({
      driver: DRIVER,
      key: decision.target.key,
      reason: decision.reason,
      workSessionId: null,
    });
    lastAutoRotationAt = now;
    // D69: sessions living in Herdr panes are restarted on the new account with
    // the same conversation. Busy ones are left alone: a session that is still
    // working has not hit the limit.
    const live = yield* readClaudeLiveSessions({ account: decision.target.label });
    for (const session of live) {
      if (session.herdrPane === null || session.status === "busy") continue;
      const result = yield* respawnClaudeInPane({
        paneRef: session.herdrPane,
        sessionId: session.sessionId,
      });
      yield* Effect.logInfo("Tessaya respawned a Herdr Claude session", result);
    }
    yield* Effect.logInfo("Tessaya rotated the terminal sessions' Claude account on a limit", {
      from: decision.from?.label ?? null,
      to: decision.target.label,
      reason: decision.reason,
    });
  });

  const tick = Effect.gen(function* () {
    if ((yield* policy.read) !== "auto") return;
    const now = DateTime.formatIso(yield* DateTime.now);
    // A machine without cswap has no terminal login to rotate, which is not worth a log line.
    const terminal = yield* pool.read(DRIVER).pipe(Effect.option);
    // While cswap rotates the default instance's login, native moves leave that instance out.
    const exclude = new Set(terminal._tag === "Some" ? [BATON_DEFAULT_CLAUDE_INSTANCE] : []);
    yield* moveThreads(now, exclude).pipe(Effect.ignoreCause({ log: true }));
    if (terminal._tag === "Some") {
      yield* moveLiveSessions(now, terminal.value).pipe(Effect.ignoreCause({ log: true }));
      yield* rotateTerminalLogin(now, terminal.value).pipe(Effect.ignoreCause({ log: true }));
    }
  });

  yield* tick.pipe(Effect.repeat(Schedule.spaced(TICK)), Effect.forkScoped);
});

export const layer = Layer.effectDiscard(make);
