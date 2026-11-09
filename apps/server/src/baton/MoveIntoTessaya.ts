/**
 * Move into Tessaya: a Terminal thread's Claude session ends in its terminal and the same session id continues as a
 * Tessaya (claudeAgent) thread, resumed through the Agent SDK. The thread keeps its id and history. Opt-in and
 * confirmed; refused while either side is working, and the thread is switched only after the terminal process is gone,
 * so two processes never write the same conversation.
 */
import { LIVE_INSTANCE, liveSessionIdOf } from "@t3tools/baton-shared/liveThread";
import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import { derive as deriveIds } from "@t3tools/provider-core/server/IdAllocator";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

/**
 * The Claude instance that signs in as `login` (an address before its `@`), picked the way the account picker does;
 * with no login known, the default Claude instance. Null when Tessaya has no account for that login.
 */
export const instanceForLogin = (
  accounts: ReadonlyArray<{
    readonly driver: string;
    readonly email: string | null;
    readonly instanceIds: ReadonlyArray<string>;
    readonly health: string;
    readonly methods: ReadonlyArray<{
      readonly instanceId: string | null;
      readonly liveSwitch: boolean;
    }>;
  }>,
  login: string | null,
  defaultInstance: string,
): string | null => {
  if (login === null) return defaultInstance;
  const account = accounts.find(
    (candidate) =>
      candidate.driver === "claudeAgent" &&
      candidate.health !== "paused" &&
      candidate.email?.split("@")[0]?.toLowerCase() === login.toLowerCase(),
  );
  if (account === undefined) return null;
  return (
    account.methods.find((method) => method.liveSwitch && method.instanceId !== null)?.instanceId ??
    account.instanceIds[0] ??
    null
  );
};

export interface MovePorts {
  readonly shell: (
    threadId: string,
  ) => Effect.Effect<{ readonly instanceId: string; readonly running: boolean } | null>;
  /** The session running under this id now, or null. */
  readonly session: (sessionId: string) => Effect.Effect<{
    readonly status: string | null;
    readonly pane: string | null;
    readonly account: string | null;
  } | null>;
  /** The Claude instance for a login (null: the default one) and the model to resume on. */
  readonly target: (
    account: string | null,
  ) => Effect.Effect<{ readonly instanceId: string; readonly model: string } | null>;
  /** Asks the terminal process to end (/exit in its pane, else SIGTERM); true once it is gone. */
  readonly endTerminal: (sessionId: string) => Effect.Effect<boolean>;
  readonly point: (input: {
    readonly threadId: string;
    readonly instanceId: string;
    readonly model: string;
    readonly sessionId: string;
  }) => Effect.Effect<void, unknown>;
}

export interface MoveResult {
  readonly state: "moved" | "refused" | "busy";
  readonly detail: string;
  readonly instanceId: string | null;
}

const no = (state: "refused" | "busy", detail: string): MoveResult => ({
  state,
  detail,
  instanceId: null,
});

export const moveIntoTessaya = Effect.fn("MoveIntoTessaya.move")(function* (
  ports: MovePorts,
  input: { readonly threadId: string; readonly providerChangeApproved?: boolean },
) {
  if (input.providerChangeApproved !== true)
    return no("refused", "Not moved: the move needs your confirmation.");
  const sessionId = liveSessionIdOf(input.threadId);
  if (sessionId === null) return no("refused", "Not moved: this is not a Terminal thread.");
  const shell = yield* ports.shell(input.threadId);
  if (shell === null) return no("refused", "Not moved: no such thread.");
  if (shell.instanceId !== LIVE_INSTANCE)
    return no("refused", "Not moved: this thread is not answered by its terminal session.");
  if (shell.running) return no("busy", "The session is working. Move it when it is idle.");
  const session = yield* ports.session(sessionId);
  if (session !== null && session.status !== "idle")
    return no("busy", "The session is working. Move it when it is idle.");
  const target = yield* ports.target(session?.account ?? null);
  if (target === null)
    return no("refused", "Not moved: no Claude account in Tessaya can take this session.");
  if (session !== null && !(yield* ports.endTerminal(sessionId)))
    return no("refused", "Not moved: the terminal session did not exit; it was left as it was.");
  const pointed = yield* Effect.exit(
    ports.point({ threadId: input.threadId, ...target, sessionId }),
  );
  if (pointed._tag === "Failure")
    return no(
      "refused",
      session === null
        ? "Not moved: the thread could not be switched."
        : "The terminal session ended, but the thread could not be switched. Resume the session to carry on there.",
    );
  return {
    state: "moved",
    detail: "The session continues in Tessaya.",
    instanceId: target.instanceId,
  } satisfies MoveResult;
});

/**
 * The events that put a thread on `instanceId` resuming `sessionId`: a provider thread holding that native session
 * (strong, so the first turn resumes it rather than starting fresh) and the thread switched onto it.
 */
export const pointAtSessionEvents = (input: {
  readonly thread: OrchestrationV2AppThread;
  readonly driver: string;
  readonly instanceId: string;
  readonly model: string;
  readonly sessionId: string;
  readonly now: DateTime.Utc;
  readonly stamp: number;
}): ReadonlyArray<OrchestrationV2DomainEvent> => {
  const driver = ProviderDriverKind.make(input.driver);
  const providerInstanceId = ProviderInstanceId.make(input.instanceId);
  const providerThreadId = deriveIds.providerThread({
    driver,
    providerInstanceId,
    nativeThreadId: input.sessionId,
  });
  const providerThread: OrchestrationV2ProviderThread = {
    id: providerThreadId,
    driver,
    providerInstanceId,
    providerSessionId: null,
    appThreadId: input.thread.id,
    ownerNodeId: null,
    nativeThreadRef: { driver, nativeId: input.sessionId, strength: "strong" },
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: null,
    lastRunOrdinal: null,
    handoffIds: [],
    forkedFrom: null,
    pendingBackgroundTasks: [],
    createdAt: input.now,
    updatedAt: input.now,
  };
  const id = `tessaya-point:${input.thread.id}:${input.instanceId}:${input.stamp}`;
  return [
    {
      id: EventId.make(`${id}:provider-thread`),
      type: "provider-thread.updated",
      threadId: input.thread.id,
      driver,
      providerInstanceId,
      occurredAt: input.now,
      payload: providerThread,
    },
    {
      id: EventId.make(`${id}:thread`),
      type: "thread.provider-switched",
      threadId: input.thread.id,
      providerInstanceId,
      occurredAt: input.now,
      payload: {
        ...input.thread,
        providerInstanceId,
        modelSelection: { instanceId: providerInstanceId, model: input.model },
        activeProviderThreadId: providerThreadId,
        updatedAt: input.now,
      },
    },
  ] as ReadonlyArray<OrchestrationV2DomainEvent>;
};
