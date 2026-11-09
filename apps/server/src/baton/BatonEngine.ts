/* oxlint-disable t3code/no-low-value-comments, t3code/prefer-effect-fn -- Baton file predating upstream's rule (D82) */
// @effect-diagnostics effectFnOpportunity:off flatMapConditionalToFilterOrFail:off preferSchemaOverJson:off instanceOfSchema:off preferSucceedSomeOrNone:off
/**
 * The one place Baton touches upstream's orchestration engine (v2, `orchestration-v2/`).
 *
 * Everything Baton does with T3 threads goes through this service: read thread shells, list
 * projects, notice that a thread changed, start a thread, send a message. When upstream moves its
 * engine again, this file is the port; nothing else in `baton/` imports `orchestration-v2`.
 *
 * Thread ids carry over from v1 unchanged (upstream's legacy importer keeps them), so a work
 * session's stored thread ids stay valid across the move.
 */
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  type ModelSelection,
  type OrchestrationProjectShell,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ContextHandoff,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
  type RuntimeRequestId,
  type TurnItemId,
  ProjectId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import type { BatonSessionStateInput } from "@t3tools/baton-contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { ProjectService } from "../project/ProjectService.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";

export interface BatonThreadLaunch {
  readonly tag: string;
  /** A client-chosen id, so a retried start is the same thread. */
  readonly threadId?: ThreadId | undefined;
  readonly interactionMode?: ProviderInteractionMode | undefined;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  /** The checkout the work is already in; null starts in the project root. */
  readonly worktreePath: string | null;
  readonly branch: string | null;
  readonly text: string;
}

export interface BatonEngineShape {
  /** Every live (unarchived) thread shell. Empty on an engine error: a fleet read never fails. */
  readonly threadShells: Effect.Effect<ReadonlyArray<OrchestrationV2ThreadShell>>;
  readonly threadShell: (threadId: ThreadId) => Effect.Effect<OrchestrationV2ThreadShell | null>;
  readonly projects: Effect.Effect<ReadonlyArray<OrchestrationProjectShell>>;
  /** The thread each domain event is about, as events arrive. */
  readonly changedThreads: Stream.Stream<ThreadId>;
  /** Upstream's domain events, for the synopsis reactor's own mapping. */
  readonly domainEvents: Stream.Stream<OrchestrationV2DomainEvent>;
  /** The user and assistant messages of the last `userTurns` turns, oldest first. */
  readonly recentMessages: (
    threadId: ThreadId,
    userTurns: number,
  ) => Effect.Effect<ReadonlyArray<{ readonly role: "user" | "assistant"; readonly text: string }>>;
  readonly launchThread: (input: BatonThreadLaunch) => Effect.Effect<ThreadId | null>;
  readonly sendMessage: (input: {
    readonly tag: string;
    readonly threadId: ThreadId;
    readonly text: string;
  }) => Effect.Effect<boolean>;
  /**
   * "Continue with...": the same thread on another provider instance. Upstream's own
   * `provider.switch` builds and delivers the context handoff, so the thread keeps its id and
   * history (this replaced Baton's capsule handoff, D62).
   */
  readonly switchProvider: (input: {
    readonly tag: string;
    readonly threadId: ThreadId;
    readonly modelSelection: ModelSelection;
    /** The user chose this provider; without it the orchestrator refuses another one. */
    readonly approved?: boolean;
  }) => Effect.Effect<void, BatonEngineError>;
  /**
   * Upstream's `thread.model-selection.set`: the next turn starts on this selection. It releases
   * the live session at once, so a caller must not use it during a turn (D95).
   */
  readonly setThreadSelection: (input: {
    readonly tag: string;
    readonly threadId: ThreadId;
    readonly modelSelection: ModelSelection;
  }) => Effect.Effect<void, BatonEngineError>;
  /**
   * Live-session threads (D83): append events the way upstream's agent-session import does.
   * Returns how many were stored; 0 when `unlessNativeThreadOwned` found another owner.
   */
  readonly writeEvents: (input: {
    readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
    readonly unlessNativeThreadOwned?: Parameters<
      EventSink.EventSinkV2["Service"]["write"]
    >[0]["unlessNativeThreadOwned"];
  }) => Effect.Effect<number, BatonEngineError>;
  /** The newest messages of a thread, oldest first. */
  readonly threadMessages: (
    threadId: ThreadId,
    rowLimit: number,
  ) => Effect.Effect<ReadonlyArray<OrchestrationV2ConversationMessage>>;
  /** The thread's runs, for live-session turns (D83). Empty on an engine error. */
  readonly threadRuns: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<OrchestrationV2Run>>;
  /** A runtime request's status, for live-session terminal prompts (D88). Null when unknown. */
  readonly runtimeRequestStatus: (
    threadId: ThreadId,
    requestId: RuntimeRequestId,
  ) => Effect.Effect<OrchestrationV2RuntimeRequest["status"] | null>;
  /** The thread's runtime requests that are still pending. Empty on an engine error. */
  readonly pendingRuntimeRequests: (
    threadId: ThreadId,
  ) => Effect.Effect<ReadonlyArray<OrchestrationV2RuntimeRequest>>;
  /** One turn item, or null. */
  readonly turnItem: (
    threadId: ThreadId,
    itemId: TurnItemId,
  ) => Effect.Effect<OrchestrationV2TurnItem | null>;
  /** The thread's context handoffs, for live threads that must never carry one. Empty on an engine error. */
  readonly contextHandoffs: (
    threadId: ThreadId,
  ) => Effect.Effect<ReadonlyArray<OrchestrationV2ContextHandoff>>;
  /** The thread record itself (not the shell), for events that rewrite it. Null when unknown. */
  readonly appThread: (threadId: ThreadId) => Effect.Effect<OrchestrationV2AppThread | null>;
  /** The thread's active provider thread, for live-session working state (D85). */
  readonly activeProviderThread: (
    threadId: ThreadId,
  ) => Effect.Effect<OrchestrationV2ProviderThread | null>;
  /** Upstream's `thread.metadata.update` with a title; false when refused. */
  readonly renameThread: (input: {
    readonly tag: string;
    readonly threadId: ThreadId;
    readonly title: string;
  }) => Effect.Effect<boolean>;
  /**
   * A live session's thread stays where he looks for it: auto-settle off, and unsettled if it was
   * settled. Upstream's own commands; false when refused.
   */
  readonly keepActive: (input: {
    readonly tag: string;
    readonly threadId: ThreadId;
    readonly settled: boolean;
  }) => Effect.Effect<boolean>;
  /** Upstream's `thread.interaction-mode.set`: a plan-mode worker leaves plan mode once he agrees (D145). */
  readonly setInteractionMode: (input: {
    readonly tag: string;
    readonly threadId: ThreadId;
    readonly interactionMode: ProviderInteractionMode;
  }) => Effect.Effect<void, BatonEngineError>;
  /** Upstream's `run.interrupt` on the thread's active run; false when nothing is running. */
  readonly interruptThread: (input: {
    readonly tag: string;
    readonly threadId: ThreadId;
  }) => Effect.Effect<boolean>;
  /** Upstream's `provider-session.detach` for each of the thread's running provider sessions; how many. */
  readonly detachSessions: (input: {
    readonly tag: string;
    readonly threadId: ThreadId;
  }) => Effect.Effect<number, BatonEngineError>;
  /** Upstream's `thread.delete`. */
  readonly deleteThread: (input: {
    readonly tag: string;
    readonly threadId: ThreadId;
  }) => Effect.Effect<boolean>;
  /** Upstream's `thread.archive` (reversible: unarchive). */
  readonly archiveThread: (input: {
    readonly tag: string;
    readonly threadId: ThreadId;
  }) => Effect.Effect<boolean>;
  readonly unarchiveThread: (input: {
    readonly tag: string;
    readonly threadId: ThreadId;
  }) => Effect.Effect<boolean>;
  /** Upstream's `thread.pin`; false when refused. */
  readonly pinThread: (input: {
    readonly tag: string;
    readonly threadId: ThreadId;
  }) => Effect.Effect<boolean>;
  /** Upstream's `queue.resume`: start a message queued behind a run that just ended. */
  readonly resumeQueue: (input: {
    readonly tag: string;
    readonly threadId: ThreadId;
  }) => Effect.Effect<void>;
  /** A new T3 project for a directory, through upstream's project service; null when refused. */
  readonly createProject: (input: {
    readonly tag: string;
    readonly title: string;
    readonly workspaceRoot: string;
  }) => Effect.Effect<ProjectId | null>;
  /** Upstream's settlement, so a settled work session reads settled in T3's own sidebar. */
  readonly settleThread: (input: {
    readonly tag: string;
    readonly threadId: ThreadId;
  }) => Effect.Effect<boolean>;
}

export class BatonEngineError extends Schema.TaggedError<BatonEngineError>()("BatonEngineError", {
  operation: Schema.String,
  detail: Schema.String,
}) {}

export class BatonEngine extends Context.Service<BatonEngine, BatonEngineShape>()(
  "t3/baton/BatonEngine",
) {}

const iso = (value: DateTime.Utc | null | undefined): string | null =>
  value === null || value === undefined ? null : DateTime.formatIso(value);

/**
 * A v2 thread shell in the words Baton's §10 state ladder uses. Pure, so the mapping is tested
 * on its own and the ladder in `@t3tools/baton-contracts` stays engine-free.
 */
export function batonStateInputFromShell(
  shell: OrchestrationV2ThreadShell,
): BatonSessionStateInput & { readonly updatedAt: string } {
  const request = shell.pendingRuntimeRequest;
  const blocking = request !== null && request.blocking !== false;
  const limited = shell.status === "failed" && shell.lastErrorClass === "usage_limit";
  const sessionStatus: BatonSessionStateInput["sessionStatus"] = (() => {
    switch (shell.status) {
      case "idle":
        return "idle";
      case "preparing":
      case "queued":
      case "starting":
        return "starting";
      case "running":
      case "waiting":
        return "running";
      case "completed":
        return "ready";
      case "interrupted":
      case "cancelled":
      case "rolled_back":
        return "interrupted";
      case "failed":
        // A spent account is `limited`, not `failed`: the ladder reads it from the quota flag.
        return limited ? "stopped" : "error";
    }
  })();
  const latestTurnState: BatonSessionStateInput["latestTurnState"] =
    shell.status === "running" || shell.status === "waiting"
      ? "running"
      : shell.status === "completed"
        ? "completed"
        : shell.status === "failed" && !limited
          ? "error"
          : shell.status === "interrupted" || shell.status === "cancelled"
            ? "interrupted"
            : null;
  return {
    environmentOnline: true,
    hasPendingApprovals: blocking && request.kind !== "user_input",
    hasPendingUserInput: blocking && request.kind === "user_input",
    sessionStatus,
    sessionLastError:
      shell.status === "failed" && !limited ? (shell.lastError ?? "The run failed.") : null,
    backgroundLiveness: (shell.pendingBackgroundTasks?.length ?? 0) > 0 ? "working" : null,
    latestTurnState,
    latestTurnCompletedAt: iso(shell.latestRunCompletedAt),
    lastVisitedAt: iso(shell.lastVisitedAt),
    providerQuotaExhausted: limited,
    updatedAt: DateTime.formatIso(shell.updatedAt),
  };
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projectStore = yield* ProjectStore.ProjectStoreV2;
  const launcher = yield* ThreadLaunch.ThreadLaunchService;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const eventSink = yield* EventSink.EventSinkV2;
  const projectService = yield* Effect.serviceOption(ProjectService);
  const random = yield* SecureRandom.SecureRandom;
  const uuid = random.uuidV4();
  const commandId = (tag: string) => Effect.map(uuid, (id) => CommandId.make(`baton:${tag}:${id}`));

  const threadShells = orchestrator.getShellSnapshot().pipe(
    Effect.map((snapshot) => snapshot.threads),
    Effect.catchCause(() => Effect.succeed([] as ReadonlyArray<OrchestrationV2ThreadShell>)),
  );

  const threadShell = (threadId: ThreadId) =>
    orchestrator.getThreadShell(threadId).pipe(Effect.catchCause(() => Effect.succeed(null)));

  const projects = projectStore
    .listShells()
    .pipe(Effect.catchCause(() => Effect.succeed([] as ReadonlyArray<OrchestrationProjectShell>)));

  const domainEvents = orchestrator.streamDomainEvents.pipe(Stream.catchCause(() => Stream.empty));
  const changedThreads = Stream.map(domainEvents, (event) => event.threadId);

  const recentMessages: BatonEngineShape["recentMessages"] = (threadId, userTurns) =>
    orchestrator
      .getThreadSnapshotWindow(threadId, { rowLimit: 400, userTurnLimit: userTurns })
      .pipe(
        Effect.map(({ projection }) =>
          projection.messages.flatMap((message) =>
            (message.role === "user" || message.role === "assistant") &&
            message.text.trim().length > 0
              ? [{ role: message.role, text: message.text }]
              : [],
          ),
        ),
        Effect.catchCause(() => Effect.succeed([])),
      );

  const launchThread = (input: BatonThreadLaunch) =>
    Effect.gen(function* () {
      const result = yield* launcher.launch({
        commandId: yield* commandId(`${input.tag}:launch`),
        ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
        projectId: input.projectId,
        title: input.title,
        modelSelection: input.modelSelection,
        runtimeMode: input.runtimeMode,
        interactionMode: input.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE,
        // The same checkout the work is already in: a reviewer looking at a different tree
        // would be reviewing nothing.
        workspaceStrategy:
          input.worktreePath === null
            ? { type: "root", ...(input.branch === null ? {} : { branch: input.branch }) }
            : {
                type: "existing_worktree",
                worktreePath: input.worktreePath,
                ...(input.branch === null ? {} : { branch: input.branch }),
              },
        ...(input.text.trim().length === 0
          ? {}
          : { initialMessage: { text: input.text, attachments: [] } }),
        createdBy: "system",
        creationSource: "server",
      });
      return result.threadId;
    }).pipe(
      Effect.tapCause((cause) => Effect.logWarning("Tessaya could not launch a thread", cause)),
      Effect.catchCause(() => Effect.succeed(null)),
    );

  const sendMessage: BatonEngineShape["sendMessage"] = (input) =>
    Effect.gen(function* () {
      const shell = yield* orchestrator.getThreadShell(input.threadId);
      if (shell === null) return false;
      yield* threads.sendToThread({
        projectId: shell.projectId,
        commandId: yield* commandId(`${input.tag}:send`),
        threadId: input.threadId,
        messageId: MessageId.make(`baton-msg-${yield* uuid}`),
        text: input.text,
        attachments: [],
        mode: "auto",
        createdBy: "system",
        creationSource: "server",
      });
      return true;
    }).pipe(
      Effect.tapCause((cause) => Effect.logWarning("Tessaya could not send to a thread", cause)),
      Effect.catchCause(() => Effect.succeed(false)),
    );

  const switchProvider: BatonEngineShape["switchProvider"] = (input) =>
    Effect.gen(function* () {
      yield* orchestrator.dispatch({
        type: "provider.switch",
        commandId: yield* commandId(`${input.tag}:switch`),
        threadId: input.threadId,
        modelSelection: input.modelSelection,
        ...(input.approved === true ? { providerChangeApproved: true } : {}),
      });
    }).pipe(
      Effect.mapError(
        (cause) => new BatonEngineError({ operation: "provider.switch", detail: String(cause) }),
      ),
    );

  const setThreadSelection: BatonEngineShape["setThreadSelection"] = (input) =>
    Effect.gen(function* () {
      yield* orchestrator.dispatch({
        type: "thread.model-selection.set",
        commandId: yield* commandId(`${input.tag}:select`),
        threadId: input.threadId,
        modelSelection: input.modelSelection,
      });
    }).pipe(
      Effect.mapError(
        (cause) =>
          new BatonEngineError({ operation: "thread.model-selection.set", detail: String(cause) }),
      ),
    );

  const setInteractionMode: BatonEngineShape["setInteractionMode"] = (input) =>
    Effect.gen(function* () {
      yield* orchestrator.dispatch({
        type: "thread.interaction-mode.set",
        commandId: yield* commandId(`${input.tag}:mode`),
        threadId: input.threadId,
        interactionMode: input.interactionMode,
      });
    }).pipe(
      Effect.mapError(
        (cause) =>
          new BatonEngineError({ operation: "thread.interaction-mode.set", detail: String(cause) }),
      ),
    );

  const interruptThread: BatonEngineShape["interruptThread"] = (input) =>
    Effect.gen(function* () {
      const shell = yield* orchestrator.getThreadShell(input.threadId);
      if (shell === null || shell.activeRunId === null) return false;
      yield* orchestrator.dispatch({
        type: "run.interrupt",
        commandId: yield* commandId(`${input.tag}:interrupt`),
        threadId: input.threadId,
        runId: shell.activeRunId,
        reason: "Stopped by him.",
        holdQueue: true,
      });
      return true;
    }).pipe(
      Effect.tapCause((cause) => Effect.logWarning("Tessaya could not stop a thread", cause)),
      Effect.catchCause(() => Effect.succeed(false)),
    );

  const detachSessions: BatonEngineShape["detachSessions"] = (input) =>
    Effect.gen(function* () {
      const records = yield* orchestrator.getThreadRecords(input.threadId, ["providerSessions"]);
      const running = records.providerSessions.filter(
        (session) => session.status !== "stopped" && session.status !== "error",
      );
      for (const session of running) {
        yield* orchestrator.dispatch({
          type: "provider-session.detach",
          commandId: yield* commandId(`${input.tag}:detach`),
          threadId: input.threadId,
          providerSessionId: session.id,
          reason: "Opened in a terminal.",
        });
      }
      return running.length;
    }).pipe(
      Effect.mapError(
        (cause) => new BatonEngineError({ operation: "session.detach", detail: String(cause) }),
      ),
    );

  const settleThread: BatonEngineShape["settleThread"] = (input) =>
    Effect.gen(function* () {
      yield* orchestrator.dispatch({
        type: "thread.settle",
        commandId: yield* commandId(`${input.tag}:settle`),
        threadId: input.threadId,
      });
      return true;
    }).pipe(Effect.catchCause(() => Effect.succeed(false)));

  const writeEvents: BatonEngineShape["writeEvents"] = (input) =>
    eventSink
      .write({
        events: input.events,
        ...(input.unlessNativeThreadOwned === undefined
          ? {}
          : { unlessNativeThreadOwned: input.unlessNativeThreadOwned }),
      })
      .pipe(
        Effect.map((stored) => stored.length),
        Effect.mapError(
          (cause) => new BatonEngineError({ operation: "events.write", detail: String(cause) }),
        ),
      );

  const threadMessages: BatonEngineShape["threadMessages"] = (threadId, rowLimit) =>
    orchestrator.getThreadSnapshotWindow(threadId, { rowLimit }).pipe(
      Effect.map(({ projection }) => projection.messages),
      Effect.catchCause(() => Effect.succeed([])),
    );

  const appThread: BatonEngineShape["appThread"] = (threadId) =>
    orchestrator.getThreadRecords(threadId, []).pipe(
      Effect.map((records) => records.thread),
      Effect.catchCause(() => Effect.succeed(null)),
    );

  const activeProviderThread: BatonEngineShape["activeProviderThread"] = (threadId) =>
    // Not the snapshot window: it carries only provider threads whose status is active.
    orchestrator.getThreadRecords(threadId, ["providerThreads"]).pipe(
      Effect.map(
        (records) =>
          records.providerThreads.find(
            (thread) => thread.id === records.thread.activeProviderThreadId,
          ) ?? null,
      ),
      Effect.catchCause(() => Effect.succeed(null)),
    );

  const runtimeRequestStatus: BatonEngineShape["runtimeRequestStatus"] = (threadId, requestId) =>
    orchestrator.getThreadRecords(threadId, ["runtimeRequests"]).pipe(
      Effect.map(
        (records) =>
          records.runtimeRequests.find((request) => request.id === requestId)?.status ?? null,
      ),
      Effect.catchCause(() => Effect.succeed(null)),
    );

  const pendingRuntimeRequests: BatonEngineShape["pendingRuntimeRequests"] = (threadId) =>
    orchestrator.getThreadRecords(threadId, ["runtimeRequests"]).pipe(
      Effect.map((records) =>
        records.runtimeRequests.filter((request) => request.status === "pending"),
      ),
      Effect.catchCause(() => Effect.succeed([])),
    );

  const turnItem: BatonEngineShape["turnItem"] = (threadId, itemId) =>
    orchestrator
      .getTurnItem({ threadId, itemId })
      .pipe(Effect.catchCause(() => Effect.succeed(null)));

  const contextHandoffs: BatonEngineShape["contextHandoffs"] = (threadId) =>
    orchestrator.getThreadRecords(threadId, ["contextHandoffs"]).pipe(
      Effect.map((records) => records.contextHandoffs),
      Effect.catchCause(() => Effect.succeed([])),
    );

  const threadRuns: BatonEngineShape["threadRuns"] = (threadId) =>
    orchestrator.getThreadRecords(threadId, ["runs"]).pipe(
      Effect.map((records) => records.runs),
      Effect.catchCause(() => Effect.succeed([])),
    );

  const renameThread: BatonEngineShape["renameThread"] = (input) =>
    Effect.gen(function* () {
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: yield* commandId(`${input.tag}:rename`),
        threadId: input.threadId,
        title: input.title,
      });
      return true;
    }).pipe(Effect.catchCause(() => Effect.succeed(false)));

  const keepActive: BatonEngineShape["keepActive"] = (input) =>
    Effect.gen(function* () {
      yield* orchestrator.dispatch({
        type: "thread.auto-settle.set",
        commandId: yield* commandId(`${input.tag}:auto-settle`),
        threadId: input.threadId,
        enabled: false,
      });
      if (input.settled) {
        yield* orchestrator.dispatch({
          type: "thread.unsettle",
          commandId: yield* commandId(`${input.tag}:unsettle`),
          threadId: input.threadId,
          reason: "user",
        });
      }
      return true;
    }).pipe(
      Effect.tapCause((cause) =>
        Effect.logWarning("Tessaya could not keep a thread active", cause),
      ),
      Effect.catchCause(() => Effect.succeed(false)),
    );

  const deleteThread: BatonEngineShape["deleteThread"] = (input) =>
    Effect.gen(function* () {
      yield* orchestrator.dispatch({
        type: "thread.delete",
        commandId: yield* commandId(`${input.tag}:delete`),
        threadId: input.threadId,
      });
      return true;
    }).pipe(
      Effect.tapCause((cause) => Effect.logWarning("Tessaya could not delete a thread", cause)),
      Effect.catchCause(() => Effect.succeed(false)),
    );

  const archiveThread: BatonEngineShape["archiveThread"] = (input) =>
    Effect.gen(function* () {
      yield* orchestrator.dispatch({
        type: "thread.archive",
        commandId: yield* commandId(`${input.tag}:archive`),
        threadId: input.threadId,
      });
      return true;
    }).pipe(Effect.catchCause(() => Effect.succeed(false)));

  const pinThread: BatonEngineShape["pinThread"] = (input) =>
    Effect.gen(function* () {
      yield* orchestrator.dispatch({
        type: "thread.pin",
        commandId: yield* commandId(`${input.tag}:pin`),
        threadId: input.threadId,
      });
      return true;
    }).pipe(Effect.catchCause(() => Effect.succeed(false)));

  const unarchiveThread: BatonEngineShape["unarchiveThread"] = (input) =>
    Effect.gen(function* () {
      yield* orchestrator.dispatch({
        type: "thread.unarchive",
        commandId: yield* commandId(`${input.tag}:unarchive`),
        threadId: input.threadId,
      });
      return true;
    }).pipe(
      Effect.tapCause((cause) => Effect.logWarning("Tessaya could not unarchive a thread", cause)),
      Effect.catchCause(() => Effect.succeed(false)),
    );

  const resumeQueue: BatonEngineShape["resumeQueue"] = (input) =>
    Effect.gen(function* () {
      yield* orchestrator.dispatch({
        type: "queue.resume",
        commandId: yield* commandId(`${input.tag}:queue`),
        threadId: input.threadId,
      });
    }).pipe(Effect.ignoreCause);

  const createProject: BatonEngineShape["createProject"] = (input) =>
    Effect.gen(function* () {
      if (Option.isNone(projectService)) return null;
      const project = yield* projectService.value.create({
        commandId: yield* commandId(`${input.tag}:project`),
        projectId: ProjectId.make(yield* uuid),
        title: input.title,
        workspaceRoot: input.workspaceRoot,
      });
      return project.id;
    }).pipe(
      Effect.tapCause((cause) => Effect.logWarning("Tessaya could not create a project", cause)),
      Effect.catchCause(() => Effect.succeed(null)),
    );

  return {
    threadShells,
    threadShell,
    writeEvents,
    threadMessages,
    threadRuns,
    contextHandoffs,
    runtimeRequestStatus,
    pendingRuntimeRequests,
    turnItem,
    appThread,
    activeProviderThread,
    renameThread,
    resumeQueue,
    keepActive,
    archiveThread,
    unarchiveThread,
    pinThread,
    deleteThread,
    createProject,
    projects,
    changedThreads,
    domainEvents,
    recentMessages,
    launchThread,
    sendMessage,
    switchProvider,
    setThreadSelection,
    setInteractionMode,
    interruptThread,
    detachSessions,
    settleThread,
  } satisfies BatonEngineShape;
});

export const layer = Layer.effect(BatonEngine, make);

/** For tests: an engine with fixed shells and no side effects. */
export const layerStatic = (input: {
  readonly shells?: ReadonlyArray<OrchestrationV2ThreadShell>;
  readonly projects?: ReadonlyArray<OrchestrationProjectShell>;
  readonly launch?: (launch: BatonThreadLaunch) => ThreadId | null;
  readonly sent?: Array<{ readonly threadId: ThreadId; readonly text: string }>;
  readonly messages?: ReadonlyArray<{ readonly role: "user" | "assistant"; readonly text: string }>;
  /** Runs per thread, for the job caps. */
  readonly runs?: ReadonlyMap<string, ReadonlyArray<{ readonly status: string }>>;
  readonly contextHandoffs?: ReadonlyMap<string, ReadonlyArray<unknown>>;
  /** Collects the threads that were interrupted. */
  readonly interrupted?: Array<ThreadId>;
  /** Collects the provider switches (handoffs). */
  readonly switched?: Array<{ readonly threadId: ThreadId; readonly tag: string }>;
  /** Collects the threads that were unarchived. */
  readonly unarchived?: Array<ThreadId>;
}) =>
  Layer.succeed(BatonEngine, {
    threadShells: Effect.succeed(input.shells ?? []),
    threadShell: (threadId) =>
      Effect.succeed(
        Option.getOrNull(Option.fromNullishOr((input.shells ?? []).find((s) => s.id === threadId))),
      ),
    projects: Effect.succeed(input.projects ?? []),
    changedThreads: Stream.empty,
    domainEvents: Stream.empty,
    recentMessages: () => Effect.succeed(input.messages ?? []),
    launchThread: (launch) => Effect.succeed(input.launch?.(launch) ?? null),
    sendMessage: ({ threadId, text }) =>
      Effect.sync(() => {
        input.sent?.push({ threadId, text });
        return true;
      }),
    switchProvider: (switchInput) =>
      Effect.sync(() => {
        input.switched?.push({ threadId: switchInput.threadId, tag: switchInput.tag });
      }),
    setThreadSelection: () => Effect.void,
    setInteractionMode: () => Effect.void,
    interruptThread: ({ threadId }) =>
      Effect.sync(() => {
        input.interrupted?.push(threadId);
        return true;
      }),
    settleThread: () => Effect.succeed(true),
    detachSessions: () => Effect.succeed(0),
    writeEvents: (write) => Effect.succeed(write.events.length),
    threadMessages: () => Effect.succeed([]),
    threadRuns: (threadId) => Effect.succeed((input.runs?.get(threadId) ?? []) as never),
    contextHandoffs: (threadId) =>
      Effect.succeed((input.contextHandoffs?.get(threadId) ?? []) as never),
    runtimeRequestStatus: () => Effect.succeed(null),
    pendingRuntimeRequests: () => Effect.succeed([]),
    turnItem: () => Effect.succeed(null),
    appThread: () => Effect.succeed(null),
    activeProviderThread: () => Effect.succeed(null),
    renameThread: () => Effect.succeed(true),
    resumeQueue: () => Effect.void,
    keepActive: () => Effect.succeed(true),
    archiveThread: () => Effect.succeed(true),
    pinThread: () => Effect.succeed(true),
    unarchiveThread: ({ threadId }) =>
      Effect.sync(() => {
        input.unarchived?.push(threadId);
        return true;
      }),
    deleteThread: () => Effect.succeed(true),
    createProject: () => Effect.succeed(null),
  });
