/* oxlint-disable t3code/no-low-value-comments -- Baton file predating upstream's rule (D82) */
// @effect-diagnostics nodeBuiltinImport:off
/**
 * Handlers for `BatonRpcGroup` (the `fabric.*` methods). Mounted in `ws.ts` beside upstream's
 * handlers by `vendor-patches/t3code/0002-server-hooks.patch`; the domain lives in the services,
 * and this file only routes. Everything that touches upstream's engine goes through `BatonEngine`.
 *
 * The services arrive through `BatonRuntime`, a reference with a null default, so building the
 * routes needs nothing Baton-specific: upstream's own ws tests compile and run unchanged, and a
 * server without Baton's layer answers `fabric.*` with a defect naming why.
 */
import { teamBoard } from "./BatonTeamBoard.ts";
import {
  BATON_ACCOUNT_WS_METHODS,
  BATON_ACCOUNTS_WS_METHODS,
  BATON_ADOPTED_WS_METHODS,
  BATON_JOB_WS_METHODS,
  BATON_HANDOFF_WS_METHODS,
  BATON_INTENT_WS_METHODS,
  BATON_LIVE_WS_METHODS,
  BATON_COMMITMENT_WS_METHODS,
  BATON_PHONE_WS_METHODS,
  BATON_CLOUD_WS_METHODS,
  BATON_HOME_WS_METHODS,
  BATON_SESSIONS_WS_METHODS,
  BATON_WEAVE_WS_METHODS,
  BATON_MEMORY_WS_METHODS,
  BATON_ORCHESTRATION_WS_METHODS,
  BATON_RECORD_WS_METHODS,
  BATON_DICTATION_WS_METHODS,
  BATON_DESKTOP_SETTINGS_WS_METHODS,
  BATON_WATCH_WS_METHODS,
  BATON_WS_METHODS,
  BatonJobPlacementError,
  BatonRpcGroup,
  type BatonJobHandoffInput,
  instancesWeekly,
  isProviderAvailable,
  OrchestrationFiringNotFoundError,
  ProviderDriverKind,
  WorkSessionHandoffRefusedError,
  type WorkSessionHandoffInput,
  tessayaSpelling,
  type TessayaSpelling,
} from "@t3tools/baton-contracts";
import { fleetForOutside } from "@t3tools/baton-shared/fleetForOutside";
import { batonProjectKey, handoffTarget } from "@t3tools/baton-shared/jobPlacement";
import { workAccount } from "@t3tools/baton-shared/batonProjects";
import { watchFleet } from "@t3tools/baton-shared/watch";
import { DictationCleanupError, type ModelSelection, ProviderInstanceId } from "@t3tools/contracts";
import * as NodePath from "node:path";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type * as RpcGroup from "effect/rpc/RpcGroup";

import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { AccountPoolService } from "./AccountPoolService.ts";
import { BatonAccounts } from "./BatonAccounts.ts";
import { liveSwitchRefusal } from "@t3tools/baton-shared/accounts";
import { AccountRotationPolicy } from "./AccountRotationPolicy.ts";
import { AdoptedSessionService } from "./AdoptedSessionService.ts";
import { BatonEngine } from "./BatonEngine.ts";
import * as ServerConfig from "../config.ts";
import { BatonJobService } from "./BatonJobService.ts";
import { importFolder } from "./BatonMemoryImport.ts";
import { pullAction, searchHistory } from "./BatonMemoryPull.ts";
import { BatonMemoryLearning } from "./BatonMemoryLearning.ts";
import { BatonWeaveService } from "./BatonWeaveService.ts";
import { BatonCloudService } from "./BatonCloudService.ts";
import { BatonSessionCatalogService } from "./BatonSessionCatalogService.ts";
import { BatonPhoneInbox, phoneCall } from "./BatonPhoneInbox.ts";
import { BatonCommitmentService } from "./BatonCommitmentService.ts";
import { BatonRecordService } from "./BatonRecordService.ts";
import { BatonDesktopSettings } from "./BatonDesktopSettings.ts";
import { DictationCleanupApi } from "../speech/DictationCleanupApi.ts";
import { BatonMemoryService } from "./BatonMemoryService.ts";
import { BatonMemorySync } from "./BatonMemorySync.ts";
import * as JobFlow from "./BatonJobFlow.ts";
import { readPack } from "./OperatingSystemPack.ts";
import { ScheduledTaskService } from "../scheduledTasks/ScheduledTaskService.ts";
import * as FleetQuery from "./FleetQuery.ts";
import { herdrSend } from "./HerdrSend.ts";
import { BatonSessionsAcross } from "./BatonSessionsAcross.ts";
import { BatonIntentService } from "./IntentService.ts";
import {
  defaultEffortOf,
  liveAdopt,
  liveAttach,
  liveEffort,
  liveSetAccount,
  liveSetModel,
} from "./LiveActions.ts";
import { setModelResumingStopped } from "@t3tools/baton-shared/liveModel";
import { BatonOrchestrationReactor } from "./OrchestrationReactor.ts";
import { OrchestrationRuleService } from "./OrchestrationRuleService.ts";
import { ThreadAccountMoves } from "./ThreadAccountMoves.ts";
import { WorkSessionService, workSessionStream } from "./WorkSessionService.ts";
import { HomeAssistantService } from "../home/HomeAssistantService.ts";
import { BatonOneShot } from "./BatonOneShot.ts";
import { homeActorOf, serveHomeCall } from "../home/HomeCalls.ts";

/** Only Claude keeps several accounts behind one config directory today. */
const DEFAULT_ROTATION_DRIVER = ProviderDriverKind.make("claudeAgent");

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

export type BatonServices =
  | WorkSessionService
  | AccountPoolService
  | BatonAccounts
  | AccountRotationPolicy
  | OrchestrationRuleService
  | BatonOrchestrationReactor
  | BatonIntentService
  | AdoptedSessionService
  | BatonEngine
  | BatonJobService
  | BatonMemoryService
  | BatonMemorySync
  | BatonCommitmentService
  | BatonRecordService
  | DictationCleanupApi
  | BatonDesktopSettings
  | BatonPhoneInbox
  | BatonWeaveService
  | BatonCloudService
  | HomeAssistantService
  | BatonOneShot
  | BatonSessionCatalogService
  | BatonSessionsAcross
  | BatonMemoryLearning
  | ServerConfig.ServerConfig
  | ScheduledTaskService
  | ThreadAccountMoves
  | ProviderInstanceRegistry.ProviderInstanceRegistry
  | ProviderRegistry.ProviderRegistry;

/** Baton's services, or null on a server built without `BatonServerLayer.services`. */
export const BatonRuntime = Context.Reference<Context.Context<BatonServices> | null>(
  "t3/baton/BatonRpcHandlers/BatonRuntime",
  { defaultValue: () => null },
);

/** Captures Baton's services for the routes; part of `BatonServerLayer.services`. A `MemoryViewer` provided here would override every caller's. */
export const runtimeLayer = Layer.effect(BatonRuntime, Effect.context<BatonServices>());

const unavailable = () => new Error("Tessaya's services are not running on this server.");

/** §6.1 through upstream's provider.switch (D80): same thread, upstream's context handoff. */
const handoff = Effect.fn("fabric.workSession.handoff")(function* (input: WorkSessionHandoffInput) {
  const workSessions = yield* WorkSessionService;
  const engine = yield* BatonEngine;
  const providerInstances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const workSession = yield* workSessions.get(input.id);
  const refuse = (reason: string) =>
    new WorkSessionHandoffRefusedError({ workSessionId: input.id, reason });
  const threadId = workSession.activeThreadId;
  if (threadId === null) return yield* refuse("no session is running on this work.");
  const from = workSession.providerSessions.find(
    (session) => session.threadId === threadId && session.detachedAt === null,
  );
  const targetId = input.modelSelection.instanceId;
  if (from?.providerInstanceId === targetId) {
    return yield* refuse(
      "the target is the instance already running it; rotate the account in place instead (fabric.account.use).",
    );
  }
  const instance = yield* providerInstances.getInstance(targetId);
  if (instance === undefined || !instance.enabled) {
    return yield* refuse(`provider instance ${targetId} is not configured here.`);
  }
  const snapshot = yield* instance.snapshot.getSnapshot;
  if (!snapshot.installed || !isProviderAvailable(snapshot)) {
    return yield* refuse(`provider instance ${targetId} is not signed in or available.`);
  }
  yield* engine
    .switchProvider({
      tag: "handoff",
      threadId,
      modelSelection: input.modelSelection,
      approved: true,
    })
    .pipe(Effect.mapError((error) => refuse(error.detail)));
  if (input.note !== undefined && input.note.trim().length > 0) {
    yield* engine.sendMessage({ tag: "handoff", threadId, text: input.note });
  }
  yield* workSessions
    .applySynopsis({
      workSessionId: input.id,
      signals: [
        {
          kind: "finding",
          at: yield* nowIso,
          text: `Moved from ${from?.providerInstanceId ?? "no active provider"} to ${instance.driverKind} / ${targetId}.`,
          source: "events",
        },
      ],
    })
    .pipe(Effect.ignoreCause({ log: true }));
  return { workSession: yield* workSessions.get(input.id) };
});

/** A handoff to the worker he named, resolved here so no client has to hold the provider list. */
const handoffTo = Effect.fn("baton.job.handoff")(function* (input: BatonJobHandoffInput) {
  const registry = yield* ProviderRegistry.ProviderRegistry;
  const target = handoffTarget(input.instance, yield* registry.getProviders);
  if (!target.ok) return yield* new BatonJobPlacementError({ detail: target.why });
  return yield* handoff({
    id: input.id,
    modelSelection: {
      instanceId: ProviderInstanceId.make(target.value.instanceId),
      model: target.value.model,
    } as ModelSelection,
    ...(input.note === undefined ? {} : { note: input.note }),
  });
});

/** The handler functions themselves, for the WS group and for the desktop's own direct door (BatonTessayaRoutes). */
export const makeHandlers = Effect.gen(function* () {
  const context = yield* BatonRuntime;
  const run = <A, E>(effect: Effect.Effect<A, E, BatonServices>): Effect.Effect<A, E> =>
    context === null ? Effect.die(unavailable()) : Effect.provideContext(effect, context);

  return {
    [BATON_ACCOUNT_WS_METHODS.accountPool]: (input) =>
      run(
        Effect.flatMap(AccountPoolService, (pool) =>
          pool.read(input.driver ?? DEFAULT_ROTATION_DRIVER),
        ),
      ),
    [BATON_ACCOUNT_WS_METHODS.accountUse]: (input) =>
      run(
        Effect.flatMap(AccountPoolService, (pool) =>
          pool.activate({
            driver: input.driver ?? DEFAULT_ROTATION_DRIVER,
            key: input.key,
            reason: input.reason ?? "manual",
            workSessionId: input.workSessionId ?? null,
          }),
        ).pipe(
          // The default instance's name and limits follow the switch now, not at the next 5-minute check.
          Effect.tap(() =>
            Effect.flatMap(ProviderRegistry.ProviderRegistry, (registry) =>
              Effect.forkDetach(registry.refresh(input.driver ?? DEFAULT_ROTATION_DRIVER)),
            ),
          ),
        ),
      ),
    [BATON_ACCOUNT_WS_METHODS.onLimit]: () =>
      run(Effect.flatMap(AccountRotationPolicy, (policy) => policy.read)).pipe(
        Effect.map((policy) => ({ policy })),
      ),
    [BATON_ACCOUNT_WS_METHODS.weekly]: (input) =>
      run(
        Effect.flatMap(ProviderRegistry.ProviderRegistry, (registry) => registry.getProviders),
      ).pipe(Effect.map((providers) => ({ instances: instancesWeekly(providers, input.driver) }))),
    [BATON_ACCOUNTS_WS_METHODS.list]: () =>
      run(Effect.flatMap(BatonAccounts, (accounts) => accounts.list)),
    [BATON_ACCOUNT_WS_METHODS.threadKept]: (input) =>
      run(Effect.flatMap(ThreadAccountMoves, (moves) => moves.kept(input.threadId))).pipe(
        Effect.map((keep) => ({ keep })),
      ),
    [BATON_ACCOUNT_WS_METHODS.threadKeep]: (input) =>
      run(Effect.flatMap(ThreadAccountMoves, (moves) => moves.keep(input))).pipe(
        Effect.map((keep) => ({ keep })),
      ),
    [BATON_ACCOUNT_WS_METHODS.setOnLimit]: (input) =>
      run(Effect.flatMap(AccountRotationPolicy, (policy) => policy.set(input.policy))).pipe(
        Effect.map((policy) => ({ policy })),
      ),
    [BATON_WS_METHODS.workSessionList]: (input) =>
      run(
        Effect.flatMap(WorkSessionService, (ws) =>
          Effect.map(ws.list(input), (sessions) => ({ workSessions: sessions })),
        ),
      ),
    [BATON_WS_METHODS.workSessionCreate]: (input) =>
      run(
        Effect.flatMap(WorkSessionService, (ws) =>
          Effect.map(ws.create(input), (workSession) => ({ workSession })),
        ),
      ),
    [BATON_WS_METHODS.workSessionUpdate]: (input) =>
      run(
        Effect.flatMap(WorkSessionService, (ws) =>
          Effect.map(ws.update(input), (workSession) => ({ workSession })),
        ),
      ),
    [BATON_WS_METHODS.workSessionAttachThread]: (input) =>
      run(
        Effect.flatMap(WorkSessionService, (ws) =>
          Effect.map(ws.attachThread(input), (workSession) => ({ workSession })),
        ),
      ),
    [BATON_WS_METHODS.workSessionDetachThread]: (input) =>
      run(
        Effect.flatMap(WorkSessionService, (ws) =>
          Effect.map(ws.detachThread(input), (workSession) => ({ workSession })),
        ),
      ),
    [BATON_WS_METHODS.workSessionStartThread]: (input) =>
      run(
        Effect.gen(function* () {
          const workSessions = yield* WorkSessionService;
          const engine = yield* BatonEngine;
          const providerInstances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
          const workSession = yield* workSessions.get(input.id);
          // Upstream's launch path, so worktree bootstrap, checkpoints and analytics behave as
          // for a thread started from the sidebar. Defaulting to the work session's own checkout
          // keeps sequential providers on the same branch.
          yield* engine.launchThread({
            tag: "work-session",
            threadId: input.threadId,
            projectId: workSession.projectId,
            title: input.title,
            modelSelection: input.modelSelection,
            runtimeMode: input.runtimeMode,
            interactionMode: input.interactionMode,
            worktreePath: input.worktreePath ?? workSession.primaryWorktreePath,
            branch: input.branch ?? workSession.baseBranch,
            text: "",
          });
          const instance = yield* providerInstances.getInstance(input.modelSelection.instanceId);
          const attached = yield* workSessions.attachThread({
            id: input.id,
            threadId: input.threadId,
            providerInstanceId: input.modelSelection.instanceId,
            providerDriver: instance?.driverKind ?? null,
            origin: "created",
            ...(input.role === undefined ? {} : { role: input.role }),
          });
          return { workSession: attached };
        }),
      ),
    [BATON_HANDOFF_WS_METHODS.workSessionHandoff]: (input) => run(handoff(input)),
    [BATON_LIVE_WS_METHODS.liveAttach]: (input) =>
      run(Effect.flatMap(AdoptedSessionService, (adopted) => liveAttach(adopted, input))),
    [BATON_LIVE_WS_METHODS.liveAdopt]: (input) => liveAdopt(input),
    [BATON_LIVE_WS_METHODS.liveSetAccount]: (input) =>
      run(
        Effect.gen(function* () {
          const refusal = liveSwitchRefusal(
            (yield* (yield* BatonAccounts).list).accounts,
            input.accountKey,
          );
          if (refusal !== null) return { state: "refused" as const, detail: refusal };
          const accounts = yield* (yield* AccountPoolService)
            .read(ProviderDriverKind.make("claudeAgent"))
            .pipe(
              Effect.map((read) => read.accounts),
              Effect.orElseSucceed(() => []),
            );
          const result = yield* liveSetAccount(input, accounts);
          if (result.state !== "busy") return result;
          yield* (yield* ThreadAccountMoves).queueLive(input.sessionId, {
            accountKey: input.accountKey,
            ...(input.restart === true ? { restart: true } : {}),
          });
          return { ...result, queued: true, detail: "Switches when this turn ends." };
        }),
      ),
    [BATON_LIVE_WS_METHODS.liveSetModel]: (input) =>
      run(
        Effect.gen(function* () {
          const adopted = yield* AdoptedSessionService;
          const catalog = yield* BatonSessionCatalogService;
          const claudeModels = (yield* (yield* ProviderRegistry.ProviderRegistry).getProviders)
            .filter((provider) => provider.driver === "claudeAgent")
            .flatMap((provider) => provider.models.map((model) => model.slug));
          const services = yield* Effect.context<never>();
          const result = yield* Effect.promise(() =>
            setModelResumingStopped({
              run: () =>
                Effect.runPromiseWith(services)(liveSetModel(adopted, input, claudeModels)),
              // The same session id, in Herdr; a resume that made no pane did not bring it back.
              resume: async () =>
                (
                  await Effect.runPromiseWith(services)(
                    catalog.resume({ sessionId: input.sessionId }),
                  )
                ).pane !== null,
              // @effect-diagnostics-next-line globalTimers:off
              wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
            }),
          );
          if (result.state !== "busy") return result;
          // A busy session gets it when it goes idle, never typed into a turn or a question on screen.
          yield* (yield* ThreadAccountMoves).queueLive(input.sessionId, {
            ...(input.model === undefined ? {} : { model: input.model }),
            ...(input.effort === undefined ? {} : { effort: input.effort }),
          });
          return { ...result, queued: true, detail: "Applies when this turn ends." };
        }),
      ),
    [BATON_LIVE_WS_METHODS.liveState]: (input) =>
      run(
        Effect.gen(function* () {
          const providers = yield* (yield* ProviderRegistry.ProviderRegistry).getProviders;
          const effort = yield* liveEffort(input.sessionId, (model) =>
            defaultEffortOf(providers, model),
          );
          const { queued, failure } = yield* (yield* ThreadAccountMoves).liveQueued(
            input.sessionId,
          );
          return { effort, queued, failure };
        }),
      ),
    [BATON_LIVE_WS_METHODS.liveCancelQueued]: (input) =>
      run(Effect.flatMap(ThreadAccountMoves, (moves) => moves.cancelLive(input.sessionId))).pipe(
        Effect.map((cancelled) => ({ cancelled })),
      ),
    [BATON_SESSIONS_WS_METHODS.across]: (input) =>
      run(Effect.flatMap(BatonSessionsAcross, (sessions) => sessions.list(input))),
    [BATON_LIVE_WS_METHODS.herdrSend]: (input) =>
      run(Effect.flatMap(AdoptedSessionService, (adopted) => herdrSend(adopted, input))),
    // Settling a work session settles its threads in upstream too, so T3's own sidebar agrees.
    [BATON_WS_METHODS.workSessionSettle]: (input) =>
      run(
        Effect.gen(function* () {
          const engine = yield* BatonEngine;
          const workSession = yield* (yield* WorkSessionService).settle(input);
          for (const session of workSession.providerSessions) {
            if (session.detachedAt === null) {
              yield* engine.settleThread({ tag: "work-session", threadId: session.threadId });
            }
          }
          return { workSession };
        }),
      ),
    [BATON_WS_METHODS.workSessionUnsettle]: (input) =>
      run(
        Effect.flatMap(WorkSessionService, (ws) =>
          Effect.map(ws.unsettle(input), (workSession) => ({ workSession })),
        ),
      ),
    [BATON_WS_METHODS.workSessionArchive]: (input) =>
      run(
        Effect.flatMap(WorkSessionService, (ws) =>
          Effect.map(ws.archive(input), (workSession) => ({ workSession })),
        ),
      ),
    [BATON_WS_METHODS.workSessionUnarchive]: (input) =>
      run(
        Effect.flatMap(WorkSessionService, (ws) =>
          Effect.map(ws.unarchive(input), (workSession) => ({ workSession })),
        ),
      ),
    [BATON_WS_METHODS.fleetGet]: (input) =>
      run(
        Effect.gen(function* () {
          const fleet = yield* FleetQuery.getFleet(input);
          if (input.forOutside !== true) return { fleet };
          const projects = yield* Effect.flatMap(BatonEngine, (engine) => engine.projects);
          const pack = readPack(NodePath.dirname((yield* ServerConfig.ServerConfig).dbPath));
          const titles = new Map(projects.map((project) => [project.id as string, project.title]));
          if (input.forLinked !== true)
            return { fleet: fleetForOutside(fleet, pack, (id) => titles.get(id) ?? null) };
          const byId = new Map(projects.map((project) => [project.id as string, project]));
          const providers = yield* Effect.flatMap(
            ProviderRegistry.ProviderRegistry,
            (registry) => registry.getProviders,
          );
          const labels = new Map(providers.map((p) => [p.instanceId as string, p.displayName]));
          return {
            fleet: fleetForOutside(fleet, pack, (id) => titles.get(id) ?? null, {
              project: (id) => {
                const project = byId.get(id);
                return project === undefined ? null : batonProjectKey(project);
              },
              account: (entry) => workAccount(entry, (id) => labels.get(id)),
            }),
          };
        }),
      ),
    [BATON_WATCH_WS_METHODS.watchGet]: () =>
      run(
        Effect.gen(function* () {
          const fleet = yield* FleetQuery.getFleet({});
          const live = yield* (yield* BatonSessionCatalogService).watchFindings;
          return {
            findings: [...watchFleet(fleet.entries, yield* Clock.currentTimeMillis), ...live],
          };
        }),
      ),
    [BATON_JOB_WS_METHODS.jobList]: () => run(Effect.map(JobFlow.listJobs(), (jobs) => ({ jobs }))),
    [BATON_JOB_WS_METHODS.jobTeam]: (input) => run(teamBoard(input)),
    [BATON_JOB_WS_METHODS.jobStart]: (input) => run(JobFlow.startJob(input)),
    [BATON_JOB_WS_METHODS.jobPlace]: (input) => run(JobFlow.placeJob(input)),
    [BATON_JOB_WS_METHODS.jobHandoff]: (input) => run(handoffTo(input)),
    [BATON_JOB_WS_METHODS.jobAgree]: (input) =>
      run(Effect.map(JobFlow.agreeJob(input.id), (terms) => ({ terms }))),
    [BATON_JOB_WS_METHODS.jobRefine]: (input) =>
      run(Effect.map(JobFlow.refineJob(input), (terms) => ({ terms }))),
    [BATON_JOB_WS_METHODS.jobGrant]: (input) =>
      run(
        Effect.flatMap(BatonJobService, (jobs) =>
          Effect.map(jobs.grant(input.id, input.channel), (terms) => ({ terms })),
        ),
      ),
    [BATON_JOB_WS_METHODS.jobStop]: (input) =>
      run(Effect.map(JobFlow.stopJob(input.id), (stopped) => ({ stopped }))),
    [BATON_JOB_WS_METHODS.jobSplit]: (input) =>
      run(Effect.map(JobFlow.splitJob(input), (started) => ({ started }))),
    [BATON_JOB_WS_METHODS.jobSchedule]: (input) =>
      run(Effect.map(JobFlow.scheduleJob(input), (terms) => ({ terms }))),
    [BATON_JOB_WS_METHODS.jobRevoke]: (input) =>
      run(
        Effect.flatMap(BatonJobService, (jobs) =>
          Effect.map(jobs.revoke(input.id, input.channel), (terms) => ({ terms })),
        ),
      ),
    [BATON_WEAVE_WS_METHODS.send]: (input) =>
      run(
        Effect.flatMap(BatonWeaveService, (weave) =>
          Effect.map(weave.send(input), (record) => ({ weave: record })),
        ),
      ),
    [BATON_WEAVE_WS_METHODS.list]: (input) =>
      run(
        Effect.flatMap(BatonWeaveService, (weave) =>
          Effect.map(weave.list(input.limit), (items) => ({ items })),
        ),
      ),
    [BATON_WEAVE_WS_METHODS.tick]: () =>
      run(Effect.flatMap(BatonWeaveService, (weave) => weave.tick)),
    [BATON_SESSIONS_WS_METHODS.list]: (input) =>
      run(Effect.flatMap(BatonSessionCatalogService, (s) => s.list(input))),
    [BATON_SESSIONS_WS_METHODS.folders]: (input) =>
      run(Effect.flatMap(BatonSessionCatalogService, (s) => s.folders(input))),
    [BATON_SESSIONS_WS_METHODS.resume]: (input) =>
      run(Effect.flatMap(BatonSessionCatalogService, (s) => s.resume(input))),
    [BATON_SESSIONS_WS_METHODS.create]: (input) =>
      run(Effect.flatMap(BatonSessionCatalogService, (s) => s.create(input))),
    [BATON_SESSIONS_WS_METHODS.autoResume]: (input) =>
      run(Effect.flatMap(BatonSessionCatalogService, (s) => s.watchdog(input))),
    [BATON_SESSIONS_WS_METHODS.retireHandoff]: (input) =>
      run(Effect.flatMap(BatonSessionCatalogService, (s) => s.retireHandoff(input))),
    [BATON_SESSIONS_WS_METHODS.reattach]: (input) =>
      run(Effect.flatMap(BatonSessionCatalogService, (s) => s.reattach(input))),
    [BATON_SESSIONS_WS_METHODS.moveIntoTessaya]: (input) =>
      run(Effect.flatMap(BatonSessionCatalogService, (s) => s.moveIntoTessaya(input))),
    [BATON_SESSIONS_WS_METHODS.openInTerminal]: (input) =>
      run(Effect.flatMap(BatonSessionCatalogService, (s) => s.openInTerminal(input))),
    [BATON_SESSIONS_WS_METHODS.mainSession]: (input) =>
      run(Effect.flatMap(BatonSessionCatalogService, (s) => s.mainSession(input))),
    [BATON_SESSIONS_WS_METHODS.sessionDefaults]: () =>
      run(Effect.flatMap(BatonSessionCatalogService, (s) => s.sessionDefaults)),
    [BATON_SESSIONS_WS_METHODS.inFlight]: () =>
      run(Effect.flatMap(BatonSessionCatalogService, (s) => s.inFlight())),
    [BATON_SESSIONS_WS_METHODS.waiting]: (input) =>
      run(Effect.flatMap(BatonSessionCatalogService, (s) => s.waiting(input))),
    [BATON_SESSIONS_WS_METHODS.kept]: (input) =>
      run(Effect.flatMap(BatonSessionCatalogService, (s) => s.kept(input))),
    [BATON_SESSIONS_WS_METHODS.cleanup]: (input) =>
      run(Effect.flatMap(BatonSessionCatalogService, (s) => s.cleanup(input))),
    [BATON_SESSIONS_WS_METHODS.send]: (input) =>
      run(Effect.flatMap(BatonSessionCatalogService, (s) => s.send(input))),
    [BATON_CLOUD_WS_METHODS.read]: (input) =>
      run(Effect.flatMap(BatonCloudService, (cloud) => cloud.call(input, "read"))),
    [BATON_CLOUD_WS_METHODS.act]: (input) =>
      run(Effect.flatMap(BatonCloudService, (cloud) => cloud.call(input, "act"))),
    [BATON_CLOUD_WS_METHODS.approve]: (input) =>
      run(Effect.flatMap(BatonCloudService, (cloud) => cloud.call(input, "approve"))),
    [BATON_HOME_WS_METHODS.call]: (input) => run(serveHomeCall(input, homeActorOf(input))),
    [BATON_PHONE_WS_METHODS.call]: (input) => run(phoneCall(input)),
    [BATON_RECORD_WS_METHODS.list]: (input) =>
      run(
        Effect.flatMap(BatonRecordService, (record) =>
          Effect.map(record.query(input), (entries) => ({ entries })),
        ),
      ),
    [BATON_RECORD_WS_METHODS.append]: (input) =>
      run(
        Effect.flatMap(BatonRecordService, (record) =>
          Effect.as(record.appendFromClient(input), {}),
        ),
      ),
    [BATON_DICTATION_WS_METHODS.cleanupApi]: (input) =>
      run(
        Effect.flatMap(DictationCleanupApi, (api) => api.cleanup(input)).pipe(
          Effect.catchTags({
            ServerSettingsError: () =>
              Effect.fail(new DictationCleanupError({ reason: "unreadable-key" })),
          }),
        ),
      ),
    [BATON_DICTATION_WS_METHODS.cleanupApiStatus]: () =>
      run(
        Effect.flatMap(DictationCleanupApi, (api) => api.configured).pipe(
          Effect.map((configured) => ({ configured })),
          Effect.orElseSucceed(() => ({ configured: false })),
        ),
      ),
    [BATON_DESKTOP_SETTINGS_WS_METHODS.get]: () =>
      run(Effect.flatMap(BatonDesktopSettings, (settings) => settings.get)),
    [BATON_DESKTOP_SETTINGS_WS_METHODS.set]: (input) =>
      run(Effect.flatMap(BatonDesktopSettings, (settings) => settings.set(input.patch))),
    [BATON_DESKTOP_SETTINGS_WS_METHODS.sync]: (input) =>
      run(Effect.flatMap(BatonDesktopSettings, (settings) => settings.sync(input))),
    [BATON_COMMITMENT_WS_METHODS.list]: () =>
      run(
        Effect.flatMap(BatonCommitmentService, (commitments) =>
          Effect.map(commitments.list, (items) => ({ items })),
        ),
      ),
    [BATON_COMMITMENT_WS_METHODS.upsert]: (input) =>
      run(
        Effect.flatMap(BatonCommitmentService, (commitments) =>
          Effect.map(commitments.upsert(input.items), (applied) => ({ applied })),
        ),
      ),
    [BATON_MEMORY_WS_METHODS.list]: (input) =>
      run(
        Effect.flatMap(BatonMemoryService, (memory) =>
          Effect.map(memory.list(input), (items) => ({ items })),
        ),
      ),
    [BATON_MEMORY_WS_METHODS.search]: (input) =>
      run(
        Effect.flatMap(BatonMemoryService, (memory) =>
          Effect.map(memory.search(input), (hits) => ({ hits })),
        ),
      ),
    [BATON_MEMORY_WS_METHODS.add]: (input) =>
      run(
        Effect.flatMap(BatonMemoryService, (memory) =>
          Effect.map(memory.add(input), (item) => ({ item })),
        ),
      ),
    [BATON_MEMORY_WS_METHODS.history]: (input) =>
      run(
        Effect.flatMap(BatonMemoryService, (memory) =>
          Effect.map(
            memory.history(input.id, { agent: input.agent, admin: input.admin }),
            (versions) => ({ versions }),
          ),
        ),
      ),
    [BATON_MEMORY_WS_METHODS.restore]: (input) =>
      run(
        Effect.flatMap(BatonMemoryService, (memory) =>
          Effect.map(memory.restore(input.id, input.version), (item) => ({ item })),
        ),
      ),
    [BATON_MEMORY_WS_METHODS.edit]: (input) =>
      run(
        Effect.flatMap(BatonMemoryService, (memory) =>
          Effect.map(memory.edit(input.id, input), (item) => ({ item })),
        ),
      ),
    [BATON_MEMORY_WS_METHODS.pin]: (input) =>
      run(
        Effect.flatMap(BatonMemoryService, (memory) =>
          Effect.map(memory.pin(input.id, input.pinned), (item) => ({ item })),
        ),
      ),
    [BATON_MEMORY_WS_METHODS.forget]: (input) =>
      run(
        Effect.flatMap(BatonMemoryService, (memory) =>
          Effect.map(memory.forget(input.id), (forgotten) => ({ forgotten })),
        ),
      ),
    [BATON_MEMORY_WS_METHODS.accept]: (input) =>
      run(
        Effect.flatMap(BatonMemoryService, (memory) =>
          Effect.map(memory.accept(input.id), (item) => ({ item })),
        ),
      ),
    [BATON_MEMORY_WS_METHODS.recall]: (input) =>
      run(Effect.flatMap(BatonMemoryService, (memory) => memory.recall(input))),
    [BATON_MEMORY_WS_METHODS.used]: (input) =>
      run(
        Effect.flatMap(BatonMemoryService, (memory) =>
          Effect.map(memory.used(input.turnRef), (items) => ({ items })),
        ),
      ),
    [BATON_MEMORY_WS_METHODS.learn]: (input) =>
      run(
        Effect.flatMap(BatonMemoryLearning, (learning) =>
          learning.learn({
            origin: input.origin ?? "turn",
            said: input.said,
            reply: input.reply,
            sourceRef: input.turnRef ?? null,
            tainted: input.tainted,
            project: input.project ?? null,
            previous: input.previous ?? null,
            ...(input.agent === undefined ? {} : { agent: input.agent }),
            ...(input.at === undefined ? {} : { at: input.at }),
            ...(input.timeZone === undefined ? {} : { timeZone: input.timeZone }),
          }),
        ),
      ),
    [BATON_MEMORY_WS_METHODS.import]: (input) => run(importFolder(input.folder)),
    [BATON_MEMORY_WS_METHODS.pull]: (input) => run(pullAction(input.action)),
    [BATON_MEMORY_WS_METHODS.historySearch]: (input) =>
      run(
        Effect.map(searchHistory(input), (answer) =>
          answer.ok ? { found: true, text: answer.text } : { found: false, text: answer.why },
        ),
      ),
    [BATON_MEMORY_WS_METHODS.syncState]: () =>
      run(Effect.flatMap(BatonMemorySync, (sync) => sync.state)),
    [BATON_MEMORY_WS_METHODS.syncSetEnabled]: (input) =>
      run(Effect.flatMap(BatonMemorySync, (sync) => Effect.as(sync.setEnabled(input.on), {}))),
    [BATON_MEMORY_WS_METHODS.syncAddPeer]: (input) =>
      run(Effect.flatMap(BatonMemorySync, (sync) => Effect.as(sync.addPeer(input), {}))),
    [BATON_MEMORY_WS_METHODS.syncForget]: (input) =>
      run(
        Effect.flatMap(BatonMemorySync, (sync) => Effect.as(sync.forget(input.environmentId), {})),
      ),
    [BATON_MEMORY_WS_METHODS.syncRun]: () =>
      run(Effect.flatMap(BatonMemorySync, (sync) => sync.run)),
    [BATON_MEMORY_WS_METHODS.syncHello]: () =>
      run(Effect.flatMap(BatonMemoryService, (memory) => memory.syncHello)),
    [BATON_MEMORY_WS_METHODS.syncPull]: (input) =>
      run(Effect.flatMap(BatonMemoryService, (memory) => memory.changesSince(input.since))),
    [BATON_MEMORY_WS_METHODS.syncPush]: (input) =>
      run(
        Effect.flatMap(BatonMemoryService, (memory) =>
          Effect.map(memory.applyChanges(input.from, input.changes, input.upTo), (applied) => ({
            applied,
          })),
        ),
      ),
    [BATON_MEMORY_WS_METHODS.export]: () =>
      run(
        Effect.flatMap(BatonMemoryService, (memory) =>
          Effect.map(memory.exportMarkdown, (markdown) => ({ markdown })),
        ),
      ),
    [BATON_ORCHESTRATION_WS_METHODS.ruleCreate]: (input) =>
      run(
        Effect.flatMap(OrchestrationRuleService, (rules) =>
          Effect.map(rules.create(input), (rule) => ({ rule })),
        ),
      ),
    [BATON_ORCHESTRATION_WS_METHODS.ruleList]: (input) =>
      run(
        Effect.flatMap(OrchestrationRuleService, (rules) =>
          Effect.map(rules.list(input), (listed) => ({ rules: listed })),
        ),
      ),
    [BATON_ORCHESTRATION_WS_METHODS.ruleDisable]: (input) =>
      run(
        Effect.flatMap(OrchestrationRuleService, (rules) =>
          Effect.map(rules.setStatus({ id: input.id, status: "disabled" }), (rule) => ({ rule })),
        ),
      ),
    [BATON_ORCHESTRATION_WS_METHODS.ruleEnable]: (input) =>
      run(
        Effect.flatMap(OrchestrationRuleService, (rules) =>
          Effect.map(rules.setStatus({ id: input.id, status: "enabled" }), (rule) => ({ rule })),
        ),
      ),
    [BATON_ORCHESTRATION_WS_METHODS.ruleConfirm]: (input) =>
      run(
        Effect.gen(function* () {
          const rules = yield* OrchestrationRuleService;
          const firing = yield* rules.getFiring(input.firingId);
          if (firing === null) {
            return yield* new OrchestrationFiringNotFoundError({ firingId: input.firingId });
          }
          // Answering the gate settles that firing either way; a refusal is a completed
          // decision, and rules sequenced behind it stay parked because only `completed`
          // releases them.
          yield* rules.completeFiring({
            firingId: input.firingId,
            outcome: input.confirmed ? "completed" : "skipped",
            producedThreadId: null,
            detail: input.confirmed ? "Confirmed." : "Declined.",
          });
          if (input.confirmed) {
            yield* (yield* BatonOrchestrationReactor)
              .evaluate({
                workSessionId: firing.workSessionId,
                changedThreadId: null,
                // Not the rule that asked: re-firing it would re-ask in the same second (D29).
                skipRuleId: firing.ruleId,
              })
              .pipe(Effect.ignoreCause({ log: true }));
          }
          const listed = yield* rules.list({
            workSessionId: firing.workSessionId,
            includeDisabled: true,
          });
          return { rules: listed };
        }),
      ),
    [BATON_INTENT_WS_METHODS.intentResolve]: (input) =>
      run(
        Effect.flatMap(BatonIntentService, (intents) =>
          Effect.map(
            intents.resolve({
              text: input.text,
              focusedWorkSessionId: input.focusedWorkSessionId ?? null,
              // Absent means no: a preview that fires on every pause in typing must not spend a
              // model call each time (D50).
              allowModel: input.allowModel ?? false,
            }),
            (resolution) => ({ resolution }),
          ),
        ),
      ),
    [BATON_INTENT_WS_METHODS.intentRun]: (input) =>
      run(
        Effect.flatMap(BatonIntentService, (intents) =>
          intents.run({
            text: input.text,
            focusedWorkSessionId: input.focusedWorkSessionId ?? null,
          }),
        ),
      ),
    [BATON_INTENT_WS_METHODS.intentList]: (input) =>
      run(
        Effect.flatMap(BatonIntentService, (intents) =>
          Effect.map(
            intents.list({
              workSessionId: input.workSessionId ?? null,
              limit: input.limit ?? null,
            }),
            (recorded) => ({ intents: recorded }),
          ),
        ),
      ),
    [BATON_ADOPTED_WS_METHODS.adoptedDiscover]: () =>
      run(Effect.flatMap(AdoptedSessionService, (adopted) => adopted.discover)),
    [BATON_ADOPTED_WS_METHODS.adoptedRegister]: (input) =>
      run(
        Effect.flatMap(AdoptedSessionService, (adopted) =>
          Effect.map(adopted.register(input), (session) => ({ session })),
        ),
      ),
    [BATON_ADOPTED_WS_METHODS.adoptedList]: (input) =>
      run(
        Effect.flatMap(AdoptedSessionService, (adopted) =>
          Effect.map(adopted.list(input), (sessions) => ({ sessions })),
        ),
      ),
    [BATON_ADOPTED_WS_METHODS.adoptedRefresh]: (input) =>
      run(
        Effect.flatMap(AdoptedSessionService, (adopted) =>
          Effect.map(adopted.refresh(input), (session) => ({ session })),
        ),
      ),
    [BATON_ADOPTED_WS_METHODS.adoptedDetach]: (input) =>
      run(
        Effect.flatMap(AdoptedSessionService, (adopted) =>
          Effect.map(adopted.detach(input.id), (session) => ({ session })),
        ),
      ),
    [BATON_ADOPTED_WS_METHODS.adoptedSendInput]: (input) =>
      run(Effect.flatMap(AdoptedSessionService, (adopted) => adopted.sendInput(input))),
    [BATON_ADOPTED_WS_METHODS.adoptedReadOutput]: (input) =>
      run(Effect.flatMap(AdoptedSessionService, (adopted) => adopted.readOutput(input))),
    [BATON_WS_METHODS.subscribeWorkSessions]: () =>
      context === null
        ? Stream.die(unavailable())
        : workSessionStream(Context.get(context, WorkSessionService)),
  } satisfies RpcGroup.HandlersFrom<LegacyRpcs>;
});

type LegacyRpcs = Exclude<
  RpcGroup.Rpcs<typeof BatonRpcGroup>,
  { readonly _tag: `tessaya.${string}` }
>;

// Rename R1: each tessaya.* alias runs its old-named handler.
const withTessayaAliases = <H extends RpcGroup.HandlersFrom<LegacyRpcs>>(handlers: H) =>
  ({
    ...handlers,
    ...Object.fromEntries(
      Object.entries(handlers).map(([tag, handler]) => [tessayaSpelling(tag), handler]),
    ),
  }) as H & { readonly [K in keyof H & string as TessayaSpelling<K>]: H[K] };

export const make = Effect.flatMap(makeHandlers, (handlers) =>
  BatonRpcGroup.toHandlers(withTessayaAliases(handlers)),
);
