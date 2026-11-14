// @effect-diagnostics nodeBuiltinImport:off
/**
 * Move into Tessaya: a Terminal thread's Claude session ends in its terminal and the same session id continues as a
 * Tessaya (claudeAgent) thread, resumed through the Agent SDK. The thread keeps its id and history. Opt-in and
 * confirmed; refused while either side is working, and the thread is switched only after the terminal process is gone,
 * so two processes never write the same conversation.
 */
import { LIVE_INSTANCE, liveSessionIdOf } from "@t3tools/tessaya-shared/liveThread";
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
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";

/**
 * The Claude instances that sign in as `login` (an address before its `@`), the account picker's choice first; with no
 * login known, every Claude instance. Empty when Tessaya has no account for that login.
 */
export const instancesForLogin = (
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
): ReadonlyArray<string> => {
  const usable = accounts.filter(
    (candidate) =>
      candidate.driver === "claudeAgent" &&
      candidate.health !== "paused" &&
      (login === null || candidate.email?.split("@")[0]?.toLowerCase() === login.toLowerCase()),
  );
  return [
    ...new Set(
      usable.flatMap((account) => [
        ...account.methods.flatMap((m) =>
          m.liveSwitch && m.instanceId !== null ? [m.instanceId] : [],
        ),
        ...account.instanceIds,
      ]),
    ),
  ];
};

/**
 * The first candidate whose config dir reaches the session's transcript: its `projects/` resolves to the same folder
 * as the session's own config dir (when that is known), and the transcript file is there. A resume anywhere else would
 * start an empty conversation under the same id.
 */
export const resumeInstance = (input: {
  readonly candidates: ReadonlyArray<{ readonly instanceId: string; readonly home: string }>;
  /** The session's own config dir, or null when it is not running. */
  readonly sessionConfigDir: string | null;
  readonly transcript: (home: string) => string;
  readonly realpath: (path: string) => string | null;
  readonly exists: (path: string) => boolean;
}): string | null => {
  const wanted =
    input.sessionConfigDir === null ? null : input.realpath(`${input.sessionConfigDir}/projects`);
  if (input.sessionConfigDir !== null && wanted === null) return null;
  return (
    input.candidates.find(
      (c) =>
        (wanted === null || input.realpath(`${c.home}/projects`) === wanted) &&
        input.exists(input.transcript(c.home)),
    )?.instanceId ?? null
  );
};

export interface MovePorts {
  readonly shell: (threadId: string) => Effect.Effect<{
    readonly instanceId: string;
    readonly running: boolean;
  } | null>;
  /** The session running under this id now, or null. */
  readonly session: (sessionId: string) => Effect.Effect<{
    readonly status: string | null;
    readonly pane: string | null;
    readonly account: string | null;
    /** Its config dir; null for ~/.claude. */
    readonly configDir: string | null;
  } | null>;
  /** The Claude instance that reaches this session's transcript on its login, and the model to resume on. */
  readonly target: (input: {
    readonly threadId: string;
    readonly sessionId: string;
    readonly login: string | null;
    readonly configDir: string | null;
    readonly running: boolean;
  }) => Effect.Effect<
    { readonly instanceId: string; readonly model: string } | { readonly refused: string }
  >;
  /** Ends the terminal process (SIGTERM to its verified pid); true once no verified process holds the session. */
  readonly endTerminal: (sessionId: string) => Effect.Effect<boolean>;
  /** Any verified process still holds the session (one this did not end, or one no scan lists as interactive). */
  readonly held: (sessionId: string) => Effect.Effect<boolean>;
  /** True once the thread is on the session; false when it could not be switched. */
  readonly point: (input: {
    readonly threadId: string;
    readonly instanceId: string;
    readonly model: string;
    readonly sessionId: string;
  }) => Effect.Effect<boolean>;
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
  // Decided before anything ends: with no account that reaches the transcript, the terminal is left running.
  const target = yield* ports.target({
    threadId: input.threadId,
    sessionId,
    login: session?.account ?? null,
    configDir: session?.configDir ?? null,
    running: session !== null,
  });
  if ("refused" in target) return no("refused", `Not moved: ${target.refused}`);
  if (session !== null && !(yield* ports.endTerminal(sessionId)))
    return no("refused", "Not moved: the terminal session did not exit; it was left as it was.");
  if (yield* ports.held(sessionId))
    return no(
      "refused",
      session === null
        ? "Not moved: another process holds this session."
        : "The terminal session ended, but another process still holds the session, so the thread was not switched.",
    );
  const pointed = yield* ports.point({
    threadId: input.threadId,
    instanceId: target.instanceId,
    model: target.model,
    sessionId,
  });
  if (!pointed)
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

/** The Claude config dir an instance runs with: its home path, else its CLAUDE_CONFIG_DIR, else ~/.claude. */
export const claudeHomeOf = (
  instance:
    | {
        readonly config?: unknown;
        readonly environment?: ReadonlyArray<{ readonly name: string; readonly value: unknown }>;
      }
    | undefined,
  home = NodeOS.homedir(),
): string => {
  const config = instance?.config as { readonly homePath?: unknown } | undefined;
  const homePath = typeof config?.homePath === "string" ? config.homePath.trim() : "";
  if (homePath.length > 0) return NodePath.resolve(homePath.replace(/^~(?=$|\/)/, home));
  const fromEnv = instance?.environment?.find((v) => v.name === "CLAUDE_CONFIG_DIR")?.value;
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) return NodePath.resolve(fromEnv);
  return NodePath.join(home, ".claude");
};
