/* oxlint-disable t3code/no-low-value-comments -- Baton file predating upstream's rule (D82) */
/**
 * Scopes for Baton's `fabric.*` methods, enforced by Baton's own middleware tag. Upstream's
 * `RpcScopeAuthorization` throws for a method its table does not list, so Baton's group cannot
 * share it; mounted next to upstream's layer in `ws.ts` (0002-server-hooks).
 *
 * Baton reuses upstream's orchestration scopes rather than adding a permission axis: work
 * sessions sit above threads and are read and operated by the people who read and operate them.
 */
import {
  AuthBatonCloudApproveScope,
  AuthBatonHandsHostScope,
  AuthBatonMemorySyncScope,
  AuthFilesystemReadScope,
  AuthOrchestrationOperateScope,
  AuthAccessReadScope,
  AuthOrchestrationReadScope,
  BATON_ACCOUNT_WS_METHODS,
  BATON_ACCOUNTS_WS_METHODS,
  BATON_ADOPTED_WS_METHODS,
  BATON_DICTATION_WS_METHODS,
  BATON_DESKTOP_SETTINGS_WS_METHODS,
  BATON_HANDOFF_WS_METHODS,
  BATON_INTENT_WS_METHODS,
  BATON_JOB_WS_METHODS,
  BATON_LIVE_WS_METHODS,
  BATON_COMMITMENT_WS_METHODS,
  BATON_PHONE_WS_METHODS,
  BATON_CLOUD_WS_METHODS,
  BATON_HOME_WS_METHODS,
  BATON_SESSIONS_WS_METHODS,
  BATON_WEAVE_WS_METHODS,
  BATON_MEMORY_WS_METHODS,
  PRIVATE_ASSISTANT_OPS,
  PRIVATE_READ_OPS,
  BATON_ORCHESTRATION_WS_METHODS,
  BATON_RECORD_WS_METHODS,
  BATON_WATCH_WS_METHODS,
  BATON_WS_METHODS,
  BatonRpcScopeAuthorization,
  type AuthEnvironmentScope,
  type BatonRpcGroup,
  BATON_METHOD_OF,
} from "@t3tools/baton-contracts";
import { authScopeRequiredResponse, EnvironmentAuthorizationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as RpcGroup from "effect/rpc/RpcGroup";

import { OWN_PAIRING_SUBJECTS, type AuthenticatedSession } from "../auth/EnvironmentAuth.ts";
import { rpcAuthorizationError } from "../auth/RpcAuthorization.ts";
import { MemoryViewer, SyncCredential } from "./BatonMemoryService.ts";
import { AskSource } from "./BatonPhoneInbox.ts";

type BatonRpcMethod = Exclude<RpcGroup.Rpcs<typeof BatonRpcGroup>["_tag"], `tessaya.${string}`>;

/** Every Baton method, or this does not compile. */
export const BATON_RPC_REQUIRED_SCOPES = {
  // Baton work sessions sit above provider threads and are read and mutated
  // by the same people who read and operate threads, so they reuse the
  // orchestration scopes rather than introducing a parallel permission axis.
  // Starting a thread inside a work session dispatches an ordinary
  // orchestration command underneath, which is why it needs the operate scope.
  [BATON_ACCOUNT_WS_METHODS.accountPool]: AuthOrchestrationReadScope,
  [BATON_ACCOUNT_WS_METHODS.accountUse]: AuthOrchestrationOperateScope,
  [BATON_ACCOUNT_WS_METHODS.onLimit]: AuthOrchestrationReadScope,
  [BATON_ACCOUNT_WS_METHODS.setOnLimit]: AuthOrchestrationOperateScope,
  [BATON_ACCOUNT_WS_METHODS.threadKept]: AuthOrchestrationReadScope,
  [BATON_ACCOUNT_WS_METHODS.threadKeep]: AuthOrchestrationOperateScope,
  [BATON_ACCOUNT_WS_METHODS.weekly]: AuthOrchestrationReadScope,
  [BATON_ACCOUNTS_WS_METHODS.list]: AuthOrchestrationReadScope,
  [BATON_WS_METHODS.workSessionList]: AuthOrchestrationReadScope,
  [BATON_WS_METHODS.workSessionCreate]: AuthOrchestrationOperateScope,
  [BATON_WS_METHODS.workSessionUpdate]: AuthOrchestrationOperateScope,
  [BATON_WS_METHODS.workSessionAttachThread]: AuthOrchestrationOperateScope,
  [BATON_WS_METHODS.workSessionDetachThread]: AuthOrchestrationOperateScope,
  [BATON_WS_METHODS.workSessionStartThread]: AuthOrchestrationOperateScope,
  [BATON_HANDOFF_WS_METHODS.workSessionHandoff]: AuthOrchestrationOperateScope,
  [BATON_LIVE_WS_METHODS.herdrSend]: AuthOrchestrationOperateScope,
  [BATON_LIVE_WS_METHODS.liveAttach]: AuthOrchestrationOperateScope,
  [BATON_LIVE_WS_METHODS.liveAdopt]: AuthOrchestrationOperateScope,
  [BATON_LIVE_WS_METHODS.liveSetModel]: AuthOrchestrationOperateScope,
  [BATON_LIVE_WS_METHODS.liveSetAccount]: AuthOrchestrationOperateScope,
  [BATON_LIVE_WS_METHODS.liveState]: AuthOrchestrationReadScope,
  [BATON_LIVE_WS_METHODS.liveCancelQueued]: AuthOrchestrationOperateScope,
  [BATON_WS_METHODS.workSessionSettle]: AuthOrchestrationOperateScope,
  [BATON_WS_METHODS.workSessionUnsettle]: AuthOrchestrationOperateScope,
  [BATON_WS_METHODS.workSessionArchive]: AuthOrchestrationOperateScope,
  [BATON_WS_METHODS.workSessionUnarchive]: AuthOrchestrationOperateScope,
  [BATON_WS_METHODS.fleetGet]: AuthOrchestrationReadScope,
  [BATON_WATCH_WS_METHODS.watchGet]: AuthOrchestrationReadScope,
  [BATON_RECORD_WS_METHODS.list]: AuthOrchestrationReadScope,
  // Rows name their actor, so only the desktop app's own session (hands-host, which no grant can give) writes them.
  [BATON_RECORD_WS_METHODS.append]: [AuthOrchestrationOperateScope, AuthBatonHandsHostScope],
  // It spends his saved Anthropic key: the desktop app's own session only.
  [BATON_DICTATION_WS_METHODS.cleanupApi]: [AuthOrchestrationOperateScope, AuthBatonHandsHostScope],
  [BATON_DICTATION_WS_METHODS.cleanupApiStatus]: AuthOrchestrationReadScope,
  // The desktop app's own session reads, changes and syncs its settings; an agent reaches them through /mcp's gate.
  [BATON_DESKTOP_SETTINGS_WS_METHODS.get]: [AuthOrchestrationReadScope, AuthBatonHandsHostScope],
  [BATON_DESKTOP_SETTINGS_WS_METHODS.set]: [AuthOrchestrationOperateScope, AuthBatonHandsHostScope],
  [BATON_DESKTOP_SETTINGS_WS_METHODS.sync]: [
    AuthOrchestrationOperateScope,
    AuthBatonHandsHostScope,
  ],
  [BATON_JOB_WS_METHODS.jobList]: AuthOrchestrationReadScope,
  [BATON_JOB_WS_METHODS.jobTeam]: AuthOrchestrationReadScope,
  [BATON_JOB_WS_METHODS.jobStart]: AuthOrchestrationOperateScope,
  [BATON_JOB_WS_METHODS.jobPlace]: AuthOrchestrationOperateScope,
  [BATON_JOB_WS_METHODS.jobHandoff]: AuthOrchestrationOperateScope,
  [BATON_JOB_WS_METHODS.jobAgree]: AuthOrchestrationOperateScope,
  [BATON_JOB_WS_METHODS.jobRefine]: AuthOrchestrationOperateScope,
  [BATON_JOB_WS_METHODS.jobGrant]: AuthOrchestrationOperateScope,
  [BATON_JOB_WS_METHODS.jobRevoke]: AuthOrchestrationOperateScope,
  [BATON_JOB_WS_METHODS.jobStop]: AuthOrchestrationOperateScope,
  [BATON_JOB_WS_METHODS.jobSchedule]: AuthOrchestrationOperateScope,
  [BATON_JOB_WS_METHODS.jobSplit]: AuthOrchestrationOperateScope,
  [BATON_WS_METHODS.subscribeWorkSessions]: AuthOrchestrationReadScope,
  // A weave types into another session's terminal: operate. Listing only reads the records.
  [BATON_WEAVE_WS_METHODS.send]: AuthOrchestrationOperateScope,
  [BATON_WEAVE_WS_METHODS.tick]: AuthOrchestrationOperateScope,
  [BATON_WEAVE_WS_METHODS.list]: AuthOrchestrationReadScope,
  // The session catalog: looking is a read; resuming, starting and sending change a machine: operate.
  [BATON_SESSIONS_WS_METHODS.list]: AuthOrchestrationReadScope,
  [BATON_SESSIONS_WS_METHODS.folders]: AuthOrchestrationReadScope,
  [BATON_SESSIONS_WS_METHODS.resume]: AuthOrchestrationOperateScope,
  [BATON_SESSIONS_WS_METHODS.create]: AuthOrchestrationOperateScope,
  [BATON_SESSIONS_WS_METHODS.send]: AuthOrchestrationOperateScope,
  [BATON_SESSIONS_WS_METHODS.cleanup]: AuthOrchestrationOperateScope,
  [BATON_SESSIONS_WS_METHODS.autoResume]: AuthOrchestrationOperateScope,
  [BATON_SESSIONS_WS_METHODS.retireHandoff]: AuthOrchestrationOperateScope,
  [BATON_SESSIONS_WS_METHODS.reattach]: AuthOrchestrationOperateScope,
  [BATON_SESSIONS_WS_METHODS.moveIntoTessaya]: AuthOrchestrationOperateScope,
  [BATON_SESSIONS_WS_METHODS.openInTerminal]: AuthOrchestrationOperateScope,
  [BATON_SESSIONS_WS_METHODS.mainSession]: AuthOrchestrationOperateScope,
  [BATON_SESSIONS_WS_METHODS.sessionDefaults]: AuthOrchestrationReadScope,
  [BATON_SESSIONS_WS_METHODS.kept]: AuthOrchestrationOperateScope,
  [BATON_SESSIONS_WS_METHODS.waiting]: AuthOrchestrationOperateScope,
  // Whether anything is mid-turn: titles only, a read.
  [BATON_SESSIONS_WS_METHODS.inFlight]: AuthOrchestrationReadScope,
  // It names the linked environments, which upstream lists only behind access:read.
  [BATON_SESSIONS_WS_METHODS.across]: [AuthOrchestrationReadScope, AuthAccessReadScope],
  // Cloud tasks: looking is a read; creating, approving or applying is operate.
  [BATON_CLOUD_WS_METHODS.read]: AuthOrchestrationReadScope,
  [BATON_CLOUD_WS_METHODS.act]: AuthOrchestrationOperateScope,
  // Approving is its own scope: only the desktop app's session and a client paired for it have it.
  [BATON_CLOUD_WS_METHODS.approve]: AuthBatonCloudApproveScope,
  // Home: looking is a read; acting is operate (each act is risk-checked again on the server); his yes to one
  // that waited is the approval scope, so no assistant, agent or device approves its own request.
  [BATON_HOME_WS_METHODS.call]: AuthOrchestrationReadScope,
  [BATON_COMMITMENT_WS_METHODS.list]: AuthOrchestrationReadScope,
  [BATON_COMMITMENT_WS_METHODS.upsert]: AuthOrchestrationOperateScope,
  // The desktop relay takes and answers the phone's asks: operate.
  [BATON_PHONE_WS_METHODS.call]: AuthOrchestrationOperateScope,
  // Memory (D150): reading and searching are reads. Every write is operate-level, and so is
  // recall, which records that the items were used.
  [BATON_MEMORY_WS_METHODS.list]: AuthOrchestrationReadScope,
  [BATON_MEMORY_WS_METHODS.search]: AuthOrchestrationReadScope,
  [BATON_MEMORY_WS_METHODS.used]: AuthOrchestrationReadScope,
  [BATON_MEMORY_WS_METHODS.history]: AuthOrchestrationReadScope,
  [BATON_MEMORY_WS_METHODS.export]: AuthOrchestrationReadScope,
  // Reads files from any folder on this machine and writes memory: both permissions, or a narrowed
  // pairing reads what upstream's filesystem:read keeps from it.
  // Reads any folder on this machine into memory: the desktop app only.
  [BATON_MEMORY_WS_METHODS.import]: [
    AuthOrchestrationOperateScope,
    AuthFilesystemReadScope,
    AuthBatonHandsHostScope,
  ],
  // Runs the history script on this machine and writes held proposals.
  [BATON_MEMORY_WS_METHODS.pull]: AuthOrchestrationOperateScope,
  // Past work across every venture, secrets marked and walled hits left out: his own servers (a sync-only credential) and the desktop app, like sync.
  [BATON_MEMORY_WS_METHODS.historySearch]: AuthBatonMemorySyncScope,
  // Sync carries every item, walled or not, and overwrites or deletes them: a sync-only credential or the desktop app.
  // This server's own sync carries every item, walled or not, with credentials it keeps: the desktop app only.
  [BATON_MEMORY_WS_METHODS.syncState]: [AuthOrchestrationReadScope, AuthBatonHandsHostScope],
  [BATON_MEMORY_WS_METHODS.syncSetEnabled]: [
    AuthOrchestrationOperateScope,
    AuthBatonHandsHostScope,
  ],
  [BATON_MEMORY_WS_METHODS.syncAddPeer]: [AuthOrchestrationOperateScope, AuthBatonHandsHostScope],
  [BATON_MEMORY_WS_METHODS.syncForget]: [AuthOrchestrationOperateScope, AuthBatonHandsHostScope],
  [BATON_MEMORY_WS_METHODS.syncRun]: [AuthOrchestrationOperateScope, AuthBatonHandsHostScope],
  [BATON_MEMORY_WS_METHODS.syncHello]: AuthBatonMemorySyncScope,
  [BATON_MEMORY_WS_METHODS.syncPull]: AuthBatonMemorySyncScope,
  [BATON_MEMORY_WS_METHODS.syncPush]: AuthBatonMemorySyncScope,
  [BATON_MEMORY_WS_METHODS.add]: AuthOrchestrationOperateScope,
  [BATON_MEMORY_WS_METHODS.edit]: AuthOrchestrationOperateScope,
  [BATON_MEMORY_WS_METHODS.restore]: AuthOrchestrationOperateScope,
  [BATON_MEMORY_WS_METHODS.pin]: AuthOrchestrationOperateScope,
  [BATON_MEMORY_WS_METHODS.forget]: AuthOrchestrationOperateScope,
  [BATON_MEMORY_WS_METHODS.accept]: AuthOrchestrationOperateScope,
  [BATON_MEMORY_WS_METHODS.recall]: AuthOrchestrationOperateScope,
  // Each call spends a cheap-model turn on his subscription.
  [BATON_MEMORY_WS_METHODS.learn]: AuthOrchestrationOperateScope,
  // A rule starts provider sessions and messages threads when it fires, so
  // creating or re-enabling one is an operate-level act even though the RPC
  // itself only writes a row. Reading the rules is a read.
  [BATON_ORCHESTRATION_WS_METHODS.ruleCreate]: AuthOrchestrationOperateScope,
  [BATON_ORCHESTRATION_WS_METHODS.ruleList]: AuthOrchestrationReadScope,
  [BATON_ORCHESTRATION_WS_METHODS.ruleDisable]: AuthOrchestrationOperateScope,
  [BATON_ORCHESTRATION_WS_METHODS.ruleEnable]: AuthOrchestrationOperateScope,
  [BATON_ORCHESTRATION_WS_METHODS.ruleConfirm]: AuthOrchestrationOperateScope,
  // Resolving a sentence reads the fleet and decides what it would mean; it
  // starts nothing. Running it can message a session, start one, or create a
  // rule, so it is an operate act whatever the sentence turns out to say — the
  // scope cannot depend on the words, or a read-only client would be one
  // phrasing away from an operate-level effect.
  [BATON_INTENT_WS_METHODS.intentResolve]: AuthOrchestrationReadScope,
  // It acts on nothing, but each call spends his subscription on a model turn.
  [BATON_INTENT_WS_METHODS.intentRun]: AuthOrchestrationOperateScope,
  [BATON_INTENT_WS_METHODS.intentList]: AuthOrchestrationReadScope,
  // Adopting a terminal is an operate act even though discovery is a read:
  // registering one puts it in the fleet, and typing into it types into
  // somebody's live session.
  [BATON_ADOPTED_WS_METHODS.adoptedDiscover]: AuthOrchestrationReadScope,
  [BATON_ADOPTED_WS_METHODS.adoptedList]: AuthOrchestrationReadScope,
  [BATON_ADOPTED_WS_METHODS.adoptedRegister]: AuthOrchestrationOperateScope,
  [BATON_ADOPTED_WS_METHODS.adoptedRefresh]: AuthOrchestrationOperateScope,
  [BATON_ADOPTED_WS_METHODS.adoptedDetach]: AuthOrchestrationOperateScope,
  [BATON_ADOPTED_WS_METHODS.adoptedSendInput]: AuthOrchestrationOperateScope,
  // Reading is a read scope even though what it reads is somebody's live
  // terminal, because it changes nothing. Whether there is anything to read is
  // decided by the capability check on the session itself.
  [BATON_ADOPTED_WS_METHODS.adoptedReadOutput]: AuthOrchestrationReadScope,
} as const satisfies Readonly<
  Record<BatonRpcMethod, AuthEnvironmentScope | ReadonlyArray<AuthEnvironmentScope>>
>;

const SYNC_METHODS: ReadonlySet<string> = new Set([
  BATON_MEMORY_WS_METHODS.syncHello,
  BATON_MEMORY_WS_METHODS.syncPull,
  BATON_MEMORY_WS_METHODS.syncPush,
  BATON_MEMORY_WS_METHODS.historySearch,
]);

/** What the desktop may call while T3's window is closed: jobs it does not have to place, the watch, the Record, rules (standing jobs), memory, commitments and weave. */
export const DESK_METHODS: ReadonlySet<string> = new Set([
  BATON_ACCOUNT_WS_METHODS.weekly,
  BATON_ORCHESTRATION_WS_METHODS.ruleList,
  BATON_ORCHESTRATION_WS_METHODS.ruleEnable,
  BATON_ORCHESTRATION_WS_METHODS.ruleDisable,
  BATON_JOB_WS_METHODS.jobList,
  BATON_JOB_WS_METHODS.jobTeam,
  BATON_JOB_WS_METHODS.jobAgree,
  BATON_JOB_WS_METHODS.jobRefine,
  BATON_JOB_WS_METHODS.jobStop,
  BATON_JOB_WS_METHODS.jobSchedule,
  BATON_JOB_WS_METHODS.jobGrant,
  BATON_JOB_WS_METHODS.jobRevoke,
  BATON_JOB_WS_METHODS.jobSplit,
  BATON_JOB_WS_METHODS.jobPlace,
  BATON_JOB_WS_METHODS.jobHandoff,
  BATON_WATCH_WS_METHODS.watchGet,
  BATON_RECORD_WS_METHODS.list,
  BATON_RECORD_WS_METHODS.append,
  BATON_DICTATION_WS_METHODS.cleanupApi,
  BATON_DICTATION_WS_METHODS.cleanupApiStatus,
  BATON_DESKTOP_SETTINGS_WS_METHODS.sync,
  BATON_COMMITMENT_WS_METHODS.list,
  BATON_COMMITMENT_WS_METHODS.upsert,
  BATON_WEAVE_WS_METHODS.send,
  BATON_WEAVE_WS_METHODS.list,
  BATON_CLOUD_WS_METHODS.read,
  BATON_CLOUD_WS_METHODS.act,
  BATON_CLOUD_WS_METHODS.approve,
  BATON_HOME_WS_METHODS.call,
  // Every live session here and on each linked environment, and typing into a pane here.
  BATON_SESSIONS_WS_METHODS.across,
  // This machine's own catalog with T3's window closed; another machine's goes through the window.
  ...(
    [
      "list",
      "folders",
      "resume",
      "create",
      "cleanup",
      "autoResume",
      "reattach",
      "waiting",
      // The updater's check before it restarts this machine (SESS-SURVIVE).
      "inFlight",
    ] as const
  ).map((op) => BATON_SESSIONS_WS_METHODS[op]),
  BATON_LIVE_WS_METHODS.herdrSend,
  // Another server's sync over plain HTTPS, with its sync-only credential.
  ...SYNC_METHODS,
  ...(
    [
      "list",
      "search",
      "add",
      "edit",
      "pin",
      "forget",
      "accept",
      "recall",
      "used",
      "history",
      "restore",
      "export",
      "learn",
      // Reads a folder on this machine: its scope is the desktop app's own session only.
      "import",
      // Running it now is the desktop app's own session only.
      "pull",
      "syncState",
      "syncSetEnabled",
      "syncAddPeer",
      "syncForget",
      "syncRun",
    ] as const
  ).map((op) => BATON_MEMORY_WS_METHODS[op]),
]);

/** The phone inbox ops a client may call: leaving words for the assistant and reading where they stand. */
const PHONE_CLIENT_OPS: ReadonlySet<string> = new Set(["ask", "askGet"]);

/** The scope a caller lacks for this method and payload, or null when it may call it. */
export const missingBatonScope = (
  calledAs: string,
  scopes: ReadonlyArray<AuthEnvironmentScope>,
  payload?: unknown,
): AuthEnvironmentScope | null => {
  // A tessaya.* alias is judged exactly as the method it stands for.
  const tag = BATON_METHOD_OF.get(calledAs) ?? calledAs;
  const required = (
    BATON_RPC_REQUIRED_SCOPES as Record<
      string,
      AuthEnvironmentScope | ReadonlyArray<AuthEnvironmentScope> | undefined
    >
  )[tag];
  if (required === undefined) return AuthOrchestrationOperateScope;
  if (SYNC_METHODS.has(tag) && scopes.includes(AuthBatonHandsHostScope)) return null;
  const all: ReadonlyArray<AuthEnvironmentScope> =
    typeof required === "string" ? [required] : required;
  const fields = typeof payload === "object" && payload !== null ? payload : {};
  // Only the desktop app's own session holds hands-host, and no grant can: seeing through memory walls is his own view,
  // and only the desktop works the phone inbox (taking his asks, answering them, mirroring its questions).
  const desktopOnly: Array<AuthEnvironmentScope> =
    ((tag === BATON_MEMORY_WS_METHODS.search || tag === BATON_MEMORY_WS_METHODS.historySearch) &&
      (fields as { admin?: unknown }).admin === true) ||
    // Running the pull now spends the history script here and writes held proposals: his desktop's Memory tab only.
    (tag === BATON_MEMORY_WS_METHODS.pull && (fields as { action?: unknown }).action === "run") ||
    (tag === BATON_PHONE_WS_METHODS.call &&
      !PHONE_CLIENT_OPS.has(String((fields as { op?: unknown }).op))) ||
    // A home act that says his gate already said yes: only his desktop's own session holds that gate.
    (tag === BATON_HOME_WS_METHODS.call &&
      (fields as { args?: { approved?: unknown } }).args?.approved === true)
      ? [AuthBatonHandsHostScope]
      : [];
  // A home call's kind sets its scope: acting is operate, his yes is the approval scope.
  const homeKind =
    tag === BATON_HOME_WS_METHODS.call ? (fields as { kind?: unknown }).kind : undefined;
  if (homeKind === "act") desktopOnly.push(AuthOrchestrationOperateScope);
  else if (homeKind === "answer") desktopOnly.push(AuthBatonCloudApproveScope);
  else if (homeKind !== undefined && homeKind !== "read") return AuthOrchestrationOperateScope;
  return [...all, ...desktopOnly].find((scope) => !scopes.includes(scope)) ?? null;
};

/** Only the desktop app's own session sees walled memory or names a persona; no grant can give hands-host. */
export const memoryViewerOf = (session: Pick<AuthenticatedSession, "scopes">) =>
  session.scopes.includes(AuthBatonHandsHostScope)
    ? ("desktop" as const)
    : session.scopes.includes(AuthBatonMemorySyncScope)
      ? ("server" as const)
      : ("client" as const);

/** A sync-only credential's session, so its first pull starts from the beginning (`SyncCredential`). */
export const syncCredentialOf = (session: Pick<AuthenticatedSession, "scopes" | "sessionId">) =>
  session.scopes.includes(AuthBatonMemorySyncScope) ? String(session.sessionId) : null;

/**
 * Whose words an ask carries: his own from a browser he paired (the phone page, the web app) or the desktop app's own
 * session; any token's are a device's, which may be an agent's, and so is any cookie whose pairing is not one of his own
 * (a token bought it, or a path not yet listed in OWN_PAIRING_SUBJECTS).
 */
export const askSourceOf = (
  session: Pick<AuthenticatedSession, "method" | "scopes" | "subject">,
) =>
  session.scopes.includes(AuthBatonHandsHostScope) ||
  (session.method === "browser-session-cookie" && OWN_PAIRING_SUBJECTS.has(session.subject))
    ? ("phone" as const)
    : ("device" as const);

/** Which account bills his work is his call: his desktop or a browser he paired, never a token's device. */
export const HIS_OWN_METHODS: ReadonlySet<string> = new Set([
  BATON_ACCOUNT_WS_METHODS.setOnLimit,
  BATON_ACCOUNT_WS_METHODS.threadKeep,
]);

/** Which session is asking, so a private store opens for that device only, and whether it is his desktop's own. */
export const privateCallerOf = (session: Pick<AuthenticatedSession, "scopes" | "sessionId">) => ({
  session: String(session.sessionId),
  desktop: session.scopes.includes(AuthBatonHandsHostScope),
});

/**
 * Why this session may not make this private-memory request, or null. Private memories are only for people at his
 * desktop or a browser he paired, never a token's device, which may be an agent. Reads need read, changes operate, and
 * what only the desktop's own assistant does needs hands-host too. Served on its own route: one more method in the RPC
 * group turns its handler types to `any`.
 */
export const privateRefusal = (
  session: Pick<AuthenticatedSession, "method" | "scopes" | "subject">,
  op: string,
): string | null => {
  if (askSourceOf(session) !== "phone")
    return "Private memories open only from his own desktop or a browser he paired.";
  const needs = [
    AuthOrchestrationReadScope,
    ...(PRIVATE_READ_OPS.has(op) ? [] : [AuthOrchestrationOperateScope]),
    ...(PRIVATE_ASSISTANT_OPS.has(op) ? [AuthBatonHandsHostScope] : []),
  ];
  const missing = needs.find((scope) => !session.scopes.includes(scope));
  return missing === undefined ? null : `Needs ${missing}.`;
};

export const refusedAsDevice = (
  tag: string,
  session: Pick<AuthenticatedSession, "method" | "scopes" | "subject">,
): boolean =>
  HIS_OWN_METHODS.has(BATON_METHOD_OF.get(tag) ?? tag) && askSourceOf(session) !== "phone";

export const layer = (
  session: Pick<AuthenticatedSession, "method" | "scopes" | "subject" | "sessionId">,
) =>
  Layer.succeed(BatonRpcScopeAuthorization)((effect, { rpc, payload }) => {
    // A tessaya.* alias passes every check as the method it stands for.
    const tag = BATON_METHOD_OF.get(rpc._tag) ?? rpc._tag;
    if (refusedAsDevice(tag, session)) {
      return Effect.fail(
        new EnvironmentAuthorizationError({
          message:
            "Only his own desktop or a browser he paired can change which account runs his work.",
          ...authScopeRequiredResponse(AuthBatonHandsHostScope),
        }),
      );
    }
    const missing = missingBatonScope(tag, session.scopes, payload);
    return missing === null
      ? effect.pipe(
          Effect.provideService(AskSource, askSourceOf(session)),
          Effect.provideService(MemoryViewer, memoryViewerOf(session)),
          Effect.provideService(SyncCredential, syncCredentialOf(session)),
        )
      : Effect.fail(rpcAuthorizationError(missing));
  });
