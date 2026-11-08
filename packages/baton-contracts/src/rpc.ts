/* oxlint-disable t3code/no-low-value-comments -- Baton file predating upstream's rule (D82) */
/**
 * Baton's RPC group, merged onto upstream's `WsRpcGroup` at the two places that build a
 * protocol (the server's `ws.ts`, the client's `rpc/protocol.ts`), so `@t3tools/contracts` never
 * imports Baton. The method names stay `fabric.*` on the wire (D71).
 *
 * Its own middleware tag, because upstream's `RpcScopeAuthorization` throws for any method its
 * scope table does not list; Baton's table is `BATON_RPC_REQUIRED_SCOPES` below.
 */
import {
  EnvironmentAuthorizationError,
  OrchestrationDispatchCommandError,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcMiddleware from "effect/rpc/RpcMiddleware";
import { BatonFleetInput, BatonFleetResult } from "./fleet.ts";
import {
  BATON_ADOPTED_WS_METHODS,
  AdoptedDiscoverInput,
  AdoptedDiscoverResult,
  AdoptedListInput,
  AdoptedReadOutputInput,
  AdoptedReadOutputResult,
  AdoptedRefInput,
  AdoptedRefreshInput,
  AdoptedRegisterInput,
  AdoptedSendInputInput,
  AdoptedSendInputResult,
  AdoptedSessionError,
  AdoptedSessionListResult,
  AdoptedSessionResult,
} from "./adoptedSession.ts";
import {
  BATON_INTENT_WS_METHODS,
  BatonIntentError,
  BatonIntentInput,
  BatonIntentListInput,
  BatonIntentListResult,
  BatonIntentResolveResult,
  BatonIntentRunResult,
} from "./intent.ts";
import {
  BATON_ORCHESTRATION_WS_METHODS,
  OrchestrationConfirmInput,
  OrchestrationRuleCreateInput,
  OrchestrationRuleError,
  OrchestrationRuleListInput,
  OrchestrationRuleListResult,
  OrchestrationRuleRefInput,
  OrchestrationRuleResult,
} from "./orchestrationRule.ts";
import {
  BATON_ACCOUNT_WS_METHODS,
  BatonAccountPoolInput,
  BatonAccountPool,
  BatonAccountPoolUnavailableError,
  BatonAccountRotationFailedError,
  BatonAccountRotationRefusedError,
  BatonAccountUseInput,
  BatonAccountUseResult,
  BatonOnLimitInput,
  BatonOnLimitResult,
  BatonSetOnLimitInput,
  BatonAccountWeeklyInput,
  BatonAccountWeeklyResult,
  BatonThreadKeepInput,
  BatonThreadKeepResult,
  BatonThreadKeptInput,
} from "./accountPool.ts";
import {
  BATON_WS_METHODS,
  WorkSessionAttachThreadInput,
  WorkSessionCreateInput,
  WorkSessionDetachThreadInput,
  WorkSessionError,
  WorkSessionListInput,
  WorkSessionListResult,
  WorkSessionRefInput,
  WorkSessionResult,
  WorkSessionStartThreadInput,
  WorkSessionStreamItem,
  WorkSessionUpdateInput,
} from "./workSession.ts";
import {
  BATON_LIVE_WS_METHODS,
  BatonLiveAdoptInput,
  BatonLiveSetModelInput,
  BatonLiveSetModelResult,
  BatonLiveAdoptResult,
  BatonLiveAttachInput,
  BatonLiveAttachResult,
  BatonHerdrSendInput,
  BatonHerdrSendResult,
} from "./liveSessions.ts";
import {
  BATON_RECORD_WS_METHODS,
  BatonRecordAppendInput,
  BatonRecordAppendResult,
  BatonRecordListInput,
  BatonRecordListResult,
} from "./record.ts";
import { BATON_WATCH_WS_METHODS, WatchResult } from "./watch.ts";
import {
  BATON_JOB_WS_METHODS,
  BatonJobGrantInput,
  BatonJobListResult,
  BatonJobRefInput,
  BatonJobRefineInput,
  BatonJobHandoffInput,
  BatonTeamBoardInput,
  BatonTeamBoardResult,
  BatonJobPlaceInput,
  BatonJobPlacementError,
  BatonJobStartInput,
  BatonJobStartResult,
  BatonJobStopResult,
  BatonJobScheduleInput,
  BatonJobSplitInput,
  BatonJobSplitResult,
  BatonJobTermsResult,
} from "./jobs.ts";
import {
  BATON_WEAVE_WS_METHODS,
  BatonWeaveError,
  BatonWeaveListInput,
  BatonWeaveListResult,
  BatonWeaveSendInput,
  BatonWeaveSendResult,
  BatonWeaveTickInput,
  BatonWeaveTickResult,
} from "./weave.ts";
import {
  BATON_SESSIONS_WS_METHODS,
  BatonCatalogCreateInput,
  BatonCatalogCreateResult,
  BatonCatalogAutoResumeInput,
  BatonCatalogAutoResumeResult,
  BatonRetireHandoffInput,
  BatonReattachInput,
  BatonKeptInput,
  BatonKeptResult,
  BatonReattachResult,
  BatonRetireHandoffResult,
  BatonCatalogCleanupInput,
  BatonCatalogCleanupResult,
  BatonCatalogFoldersInput,
  BatonCatalogFoldersResult,
  BatonCatalogListInput,
  BatonCatalogListResult,
  BatonCatalogResumeInput,
  BatonCatalogResumeResult,
  BatonCatalogSendInput,
  BatonCatalogSendResult,
  BatonCatalogWaitingInput,
  BatonCatalogWaitingResult,
  BatonTurnsInFlightResult,
  BatonSessionsAcrossInput,
  BatonSessionsAcrossResult,
} from "./sessionCatalog.ts";
import { BATON_CLOUD_WS_METHODS, BatonCloudCallInput, BatonCloudCallResult } from "./cloud.ts";
import {
  BATON_COMMITMENT_WS_METHODS,
  BatonCommitmentError,
  BatonCommitmentListInput,
  BatonCommitmentListResult,
  BatonCommitmentUpsertInput,
  BatonCommitmentUpsertResult,
} from "./commitments.ts";
import {
  BATON_PHONE_WS_METHODS,
  BatonPhoneCallInput,
  BatonPhoneCallResult,
  BatonPhoneError,
} from "./phone.ts";
import {
  BATON_MEMORY_WS_METHODS,
  BatonMemoryDraft,
  BatonMemoryEditInput,
  BatonMemoryExportResult,
  BatonMemoryForgetResult,
  BatonMemoryImportInput,
  BatonMemoryImportResult,
  BatonMemoryItemResult,
  BatonMemoryLearnInput,
  BatonMemoryLearnResult,
  BatonMemoryListResult,
  BatonMemoryPinInput,
  BatonMemoryQuery,
  BatonMemoryHistorySearchInput,
  BatonMemoryHistorySearchResult,
  BatonMemoryPullInput,
  BatonMemoryPullResult,
  BatonMemoryRecallInput,
  BatonMemoryRecallResult,
  BatonMemoryRefInput,
  BatonMemoryRefusedError,
  BatonMemorySyncAddPeerInput,
  BatonMemorySyncError,
  BatonMemorySyncForgetInput,
  BatonMemorySyncHelloResult,
  BatonMemorySyncRunResult,
  BatonMemorySyncSetEnabledInput,
  BatonMemorySyncStateResult,
  BatonMemorySyncPullInput,
  BatonMemorySyncPullResult,
  BatonMemorySyncPushInput,
  BatonMemorySyncPushResult,
  BatonMemorySearchResult,
  BatonMemoryUsedInput,
  BatonMemoryHistoryInput,
  BatonMemoryHistoryResult,
  BatonMemoryRestoreInput,
} from "./memory.ts";
import {
  BATON_HANDOFF_WS_METHODS,
  WorkSessionHandoffInput,
  WorkSessionHandoffRefusedError,
  WorkSessionHandoffResult,
} from "./handoff.ts";

// Baton work sessions. `fabric.*` is the layer above provider threads: the
// user's work, which outlives the thread and the account running it. See
// `packages/contracts/src/baton/workSession.ts`.

const WsBatonAccountPoolRpc = Rpc.make(BATON_ACCOUNT_WS_METHODS.accountPool, {
  payload: BatonAccountPoolInput,
  success: BatonAccountPool,
  error: Schema.Union([BatonAccountPoolUnavailableError, EnvironmentAuthorizationError]),
});

const WsBatonAccountUseRpc = Rpc.make(BATON_ACCOUNT_WS_METHODS.accountUse, {
  payload: BatonAccountUseInput,
  success: BatonAccountUseResult,
  error: Schema.Union([
    BatonAccountPoolUnavailableError,
    BatonAccountRotationRefusedError,
    BatonAccountRotationFailedError,
    EnvironmentAuthorizationError,
  ]),
});

const WsBatonOnLimitRpc = Rpc.make(BATON_ACCOUNT_WS_METHODS.onLimit, {
  payload: BatonOnLimitInput,
  success: BatonOnLimitResult,
  error: EnvironmentAuthorizationError,
});

const WsBatonSetOnLimitRpc = Rpc.make(BATON_ACCOUNT_WS_METHODS.setOnLimit, {
  payload: BatonSetOnLimitInput,
  success: BatonOnLimitResult,
  error: EnvironmentAuthorizationError,
});

const WsBatonThreadKeptRpc = Rpc.make(BATON_ACCOUNT_WS_METHODS.threadKept, {
  payload: BatonThreadKeptInput,
  success: BatonThreadKeepResult,
  error: EnvironmentAuthorizationError,
});

const WsBatonThreadKeepRpc = Rpc.make(BATON_ACCOUNT_WS_METHODS.threadKeep, {
  payload: BatonThreadKeepInput,
  success: BatonThreadKeepResult,
  error: EnvironmentAuthorizationError,
});

const WsBatonAccountWeeklyRpc = Rpc.make(BATON_ACCOUNT_WS_METHODS.weekly, {
  payload: BatonAccountWeeklyInput,
  success: BatonAccountWeeklyResult,
  error: EnvironmentAuthorizationError,
});

const WsBatonWorkSessionListRpc = Rpc.make(BATON_WS_METHODS.workSessionList, {
  payload: WorkSessionListInput,
  success: WorkSessionListResult,
  error: Schema.Union([WorkSessionError, EnvironmentAuthorizationError]),
});

const WsBatonWorkSessionCreateRpc = Rpc.make(BATON_WS_METHODS.workSessionCreate, {
  payload: WorkSessionCreateInput,
  success: WorkSessionResult,
  error: Schema.Union([WorkSessionError, EnvironmentAuthorizationError]),
});

const WsBatonWorkSessionUpdateRpc = Rpc.make(BATON_WS_METHODS.workSessionUpdate, {
  payload: WorkSessionUpdateInput,
  success: WorkSessionResult,
  error: Schema.Union([WorkSessionError, EnvironmentAuthorizationError]),
});

const WsBatonWorkSessionAttachThreadRpc = Rpc.make(BATON_WS_METHODS.workSessionAttachThread, {
  payload: WorkSessionAttachThreadInput,
  success: WorkSessionResult,
  error: Schema.Union([WorkSessionError, EnvironmentAuthorizationError]),
});

const WsBatonWorkSessionDetachThreadRpc = Rpc.make(BATON_WS_METHODS.workSessionDetachThread, {
  payload: WorkSessionDetachThreadInput,
  success: WorkSessionResult,
  error: Schema.Union([WorkSessionError, EnvironmentAuthorizationError]),
});

const WsBatonWorkSessionStartThreadRpc = Rpc.make(BATON_WS_METHODS.workSessionStartThread, {
  payload: WorkSessionStartThreadInput,
  success: WorkSessionResult,
  error: Schema.Union([
    WorkSessionError,
    OrchestrationDispatchCommandError,
    EnvironmentAuthorizationError,
  ]),
});

const WsBatonWorkSessionHandoffRpc = Rpc.make(BATON_HANDOFF_WS_METHODS.workSessionHandoff, {
  payload: WorkSessionHandoffInput,
  success: WorkSessionHandoffResult,
  error: Schema.Union([
    WorkSessionError,
    WorkSessionHandoffRefusedError,
    OrchestrationDispatchCommandError,
    EnvironmentAuthorizationError,
  ]),
});

const WsBatonLiveAttachRpc = Rpc.make(BATON_LIVE_WS_METHODS.liveAttach, {
  payload: BatonLiveAttachInput,
  success: BatonLiveAttachResult,
  error: EnvironmentAuthorizationError,
});

const WsBatonLiveAdoptRpc = Rpc.make(BATON_LIVE_WS_METHODS.liveAdopt, {
  payload: BatonLiveAdoptInput,
  success: BatonLiveAdoptResult,
  error: EnvironmentAuthorizationError,
});

const WsBatonLiveSetModelRpc = Rpc.make(BATON_LIVE_WS_METHODS.liveSetModel, {
  payload: BatonLiveSetModelInput,
  success: BatonLiveSetModelResult,
  error: EnvironmentAuthorizationError,
});

const WsBatonHerdrSendRpc = Rpc.make(BATON_LIVE_WS_METHODS.herdrSend, {
  payload: BatonHerdrSendInput,
  success: BatonHerdrSendResult,
  error: EnvironmentAuthorizationError,
});

const WsBatonJobListRpc = Rpc.make(BATON_JOB_WS_METHODS.jobList, {
  payload: Schema.Struct({}),
  success: BatonJobListResult,
  error: Schema.Union([WorkSessionError, EnvironmentAuthorizationError]),
});
const WsBatonJobStartRpc = Rpc.make(BATON_JOB_WS_METHODS.jobStart, {
  payload: BatonJobStartInput,
  success: BatonJobStartResult,
  error: Schema.Union([WorkSessionError, EnvironmentAuthorizationError]),
});
const WsBatonJobPlaceRpc = Rpc.make(BATON_JOB_WS_METHODS.jobPlace, {
  payload: BatonJobPlaceInput,
  success: BatonJobStartResult,
  error: Schema.Union([BatonJobPlacementError, WorkSessionError, EnvironmentAuthorizationError]),
});
const WsBatonJobTeamRpc = Rpc.make(BATON_JOB_WS_METHODS.jobTeam, {
  payload: BatonTeamBoardInput,
  success: BatonTeamBoardResult,
  error: EnvironmentAuthorizationError,
});
const WsBatonJobHandoffRpc = Rpc.make(BATON_JOB_WS_METHODS.jobHandoff, {
  payload: BatonJobHandoffInput,
  success: WorkSessionHandoffResult,
  error: Schema.Union([
    BatonJobPlacementError,
    WorkSessionError,
    WorkSessionHandoffRefusedError,
    OrchestrationDispatchCommandError,
    EnvironmentAuthorizationError,
  ]),
});
const WsBatonJobAgreeRpc = Rpc.make(BATON_JOB_WS_METHODS.jobAgree, {
  payload: BatonJobRefInput,
  success: BatonJobTermsResult,
  error: Schema.Union([WorkSessionError, EnvironmentAuthorizationError]),
});
const WsBatonJobRefineRpc = Rpc.make(BATON_JOB_WS_METHODS.jobRefine, {
  payload: BatonJobRefineInput,
  success: BatonJobTermsResult,
  error: Schema.Union([WorkSessionError, EnvironmentAuthorizationError]),
});
const WsBatonJobGrantRpc = Rpc.make(BATON_JOB_WS_METHODS.jobGrant, {
  payload: BatonJobGrantInput,
  success: BatonJobTermsResult,
  error: Schema.Union([WorkSessionError, EnvironmentAuthorizationError]),
});
const WsBatonJobRevokeRpc = Rpc.make(BATON_JOB_WS_METHODS.jobRevoke, {
  payload: BatonJobGrantInput,
  success: BatonJobTermsResult,
  error: Schema.Union([WorkSessionError, EnvironmentAuthorizationError]),
});

const WsBatonJobStopRpc = Rpc.make(BATON_JOB_WS_METHODS.jobStop, {
  payload: BatonJobRefInput,
  success: BatonJobStopResult,
  error: Schema.Union([WorkSessionError, EnvironmentAuthorizationError]),
});
const WsBatonJobScheduleRpc = Rpc.make(BATON_JOB_WS_METHODS.jobSchedule, {
  payload: BatonJobScheduleInput,
  success: BatonJobTermsResult,
  error: Schema.Union([WorkSessionError, EnvironmentAuthorizationError]),
});

const WsBatonJobSplitRpc = Rpc.make(BATON_JOB_WS_METHODS.jobSplit, {
  payload: BatonJobSplitInput,
  success: BatonJobSplitResult,
  error: Schema.Union([WorkSessionError, EnvironmentAuthorizationError]),
});

const CommitmentErrors = Schema.Union([BatonCommitmentError, EnvironmentAuthorizationError]);
const WsBatonCommitmentListRpc = Rpc.make(BATON_COMMITMENT_WS_METHODS.list, {
  payload: BatonCommitmentListInput,
  success: BatonCommitmentListResult,
  error: CommitmentErrors,
});
const WsBatonCommitmentUpsertRpc = Rpc.make(BATON_COMMITMENT_WS_METHODS.upsert, {
  payload: BatonCommitmentUpsertInput,
  success: BatonCommitmentUpsertResult,
  error: CommitmentErrors,
});

const WsBatonPhoneCallRpc = Rpc.make(BATON_PHONE_WS_METHODS.call, {
  payload: BatonPhoneCallInput,
  success: BatonPhoneCallResult,
  error: Schema.Union([BatonPhoneError, EnvironmentAuthorizationError]),
});

const WsBatonCloudReadRpc = Rpc.make(BATON_CLOUD_WS_METHODS.read, {
  payload: BatonCloudCallInput,
  success: BatonCloudCallResult,
  error: EnvironmentAuthorizationError,
});
const WsBatonCloudApproveRpc = Rpc.make(BATON_CLOUD_WS_METHODS.approve, {
  payload: BatonCloudCallInput,
  success: BatonCloudCallResult,
  error: EnvironmentAuthorizationError,
});
const WsBatonCloudActRpc = Rpc.make(BATON_CLOUD_WS_METHODS.act, {
  payload: BatonCloudCallInput,
  success: BatonCloudCallResult,
  error: EnvironmentAuthorizationError,
});

const CatalogErrors = EnvironmentAuthorizationError;
const WsBatonSessionsListRpc = Rpc.make(BATON_SESSIONS_WS_METHODS.list, {
  payload: BatonCatalogListInput,
  success: BatonCatalogListResult,
  error: CatalogErrors,
});
const WsBatonSessionsFoldersRpc = Rpc.make(BATON_SESSIONS_WS_METHODS.folders, {
  payload: BatonCatalogFoldersInput,
  success: BatonCatalogFoldersResult,
  error: CatalogErrors,
});
const WsBatonSessionsResumeRpc = Rpc.make(BATON_SESSIONS_WS_METHODS.resume, {
  payload: BatonCatalogResumeInput,
  success: BatonCatalogResumeResult,
  error: CatalogErrors,
});
const WsBatonSessionsCreateRpc = Rpc.make(BATON_SESSIONS_WS_METHODS.create, {
  payload: BatonCatalogCreateInput,
  success: BatonCatalogCreateResult,
  error: CatalogErrors,
});
const WsBatonSessionsCleanupRpc = Rpc.make(BATON_SESSIONS_WS_METHODS.cleanup, {
  payload: BatonCatalogCleanupInput,
  success: BatonCatalogCleanupResult,
  error: CatalogErrors,
});
const WsBatonSessionsAutoResumeRpc = Rpc.make(BATON_SESSIONS_WS_METHODS.autoResume, {
  payload: BatonCatalogAutoResumeInput,
  success: BatonCatalogAutoResumeResult,
  error: CatalogErrors,
});
const WsBatonSessionsRetireHandoffRpc = Rpc.make(BATON_SESSIONS_WS_METHODS.retireHandoff, {
  payload: BatonRetireHandoffInput,
  success: BatonRetireHandoffResult,
  error: CatalogErrors,
});
const WsBatonSessionsReattachRpc = Rpc.make(BATON_SESSIONS_WS_METHODS.reattach, {
  payload: BatonReattachInput,
  success: BatonReattachResult,
  error: CatalogErrors,
});
const WsBatonSessionsKeptRpc = Rpc.make(BATON_SESSIONS_WS_METHODS.kept, {
  payload: BatonKeptInput,
  success: BatonKeptResult,
  error: CatalogErrors,
});
const WsBatonSessionsWaitingRpc = Rpc.make(BATON_SESSIONS_WS_METHODS.waiting, {
  payload: BatonCatalogWaitingInput,
  success: BatonCatalogWaitingResult,
  error: CatalogErrors,
});
const WsBatonSessionsInFlightRpc = Rpc.make(BATON_SESSIONS_WS_METHODS.inFlight, {
  payload: Schema.Struct({}),
  success: BatonTurnsInFlightResult,
  error: CatalogErrors,
});
const WsBatonSessionsAcrossRpc = Rpc.make(BATON_SESSIONS_WS_METHODS.across, {
  payload: BatonSessionsAcrossInput,
  success: BatonSessionsAcrossResult,
  error: Schema.Union([WorkSessionError, EnvironmentAuthorizationError]),
});
const WsBatonSessionsSendRpc = Rpc.make(BATON_SESSIONS_WS_METHODS.send, {
  payload: BatonCatalogSendInput,
  success: BatonCatalogSendResult,
  error: CatalogErrors,
});

const WeaveErrors = Schema.Union([BatonWeaveError, EnvironmentAuthorizationError]);
const WsBatonWeaveSendRpc = Rpc.make(BATON_WEAVE_WS_METHODS.send, {
  payload: BatonWeaveSendInput,
  success: BatonWeaveSendResult,
  error: WeaveErrors,
});
const WsBatonWeaveListRpc = Rpc.make(BATON_WEAVE_WS_METHODS.list, {
  payload: BatonWeaveListInput,
  success: BatonWeaveListResult,
  error: WeaveErrors,
});
const WsBatonWeaveTickRpc = Rpc.make(BATON_WEAVE_WS_METHODS.tick, {
  payload: BatonWeaveTickInput,
  success: BatonWeaveTickResult,
  error: WeaveErrors,
});

const MemoryErrors = Schema.Union([BatonMemoryRefusedError, EnvironmentAuthorizationError]);
const WsBatonMemoryListRpc = Rpc.make(BATON_MEMORY_WS_METHODS.list, {
  payload: BatonMemoryQuery,
  success: BatonMemoryListResult,
  error: MemoryErrors,
});
const WsBatonMemorySearchRpc = Rpc.make(BATON_MEMORY_WS_METHODS.search, {
  payload: BatonMemoryQuery,
  success: BatonMemorySearchResult,
  error: MemoryErrors,
});
const WsBatonMemoryAddRpc = Rpc.make(BATON_MEMORY_WS_METHODS.add, {
  payload: BatonMemoryDraft,
  success: BatonMemoryItemResult,
  error: MemoryErrors,
});
const WsBatonMemoryEditRpc = Rpc.make(BATON_MEMORY_WS_METHODS.edit, {
  payload: BatonMemoryEditInput,
  success: BatonMemoryItemResult,
  error: MemoryErrors,
});
const WsBatonMemoryHistoryRpc = Rpc.make(BATON_MEMORY_WS_METHODS.history, {
  payload: BatonMemoryHistoryInput,
  success: BatonMemoryHistoryResult,
  error: MemoryErrors,
});
const WsBatonMemoryRestoreRpc = Rpc.make(BATON_MEMORY_WS_METHODS.restore, {
  payload: BatonMemoryRestoreInput,
  success: BatonMemoryItemResult,
  error: MemoryErrors,
});
const WsBatonMemoryPinRpc = Rpc.make(BATON_MEMORY_WS_METHODS.pin, {
  payload: BatonMemoryPinInput,
  success: BatonMemoryItemResult,
  error: MemoryErrors,
});
const WsBatonMemoryForgetRpc = Rpc.make(BATON_MEMORY_WS_METHODS.forget, {
  payload: BatonMemoryRefInput,
  success: BatonMemoryForgetResult,
  error: MemoryErrors,
});
const WsBatonMemoryAcceptRpc = Rpc.make(BATON_MEMORY_WS_METHODS.accept, {
  payload: BatonMemoryRefInput,
  success: BatonMemoryItemResult,
  error: MemoryErrors,
});
const WsBatonMemoryRecallRpc = Rpc.make(BATON_MEMORY_WS_METHODS.recall, {
  payload: BatonMemoryRecallInput,
  success: BatonMemoryRecallResult,
  error: MemoryErrors,
});
const WsBatonMemoryUsedRpc = Rpc.make(BATON_MEMORY_WS_METHODS.used, {
  payload: BatonMemoryUsedInput,
  success: BatonMemoryListResult,
  error: MemoryErrors,
});
const WsBatonMemoryLearnRpc = Rpc.make(BATON_MEMORY_WS_METHODS.learn, {
  payload: BatonMemoryLearnInput,
  success: BatonMemoryLearnResult,
  error: MemoryErrors,
});
const WsBatonMemorySyncStateRpc = Rpc.make(BATON_MEMORY_WS_METHODS.syncState, {
  payload: Schema.Struct({}),
  success: BatonMemorySyncStateResult,
  error: MemoryErrors,
});
const WsBatonMemorySyncSetEnabledRpc = Rpc.make(BATON_MEMORY_WS_METHODS.syncSetEnabled, {
  payload: BatonMemorySyncSetEnabledInput,
  success: Schema.Struct({}),
  error: MemoryErrors,
});
const WsBatonMemorySyncAddPeerRpc = Rpc.make(BATON_MEMORY_WS_METHODS.syncAddPeer, {
  payload: BatonMemorySyncAddPeerInput,
  success: Schema.Struct({}),
  error: Schema.Union([
    BatonMemorySyncError,
    BatonMemoryRefusedError,
    EnvironmentAuthorizationError,
  ]),
});
const WsBatonMemorySyncForgetRpc = Rpc.make(BATON_MEMORY_WS_METHODS.syncForget, {
  payload: BatonMemorySyncForgetInput,
  success: Schema.Struct({}),
  error: Schema.Union([
    BatonMemorySyncError,
    BatonMemoryRefusedError,
    EnvironmentAuthorizationError,
  ]),
});
const WsBatonMemorySyncRunRpc = Rpc.make(BATON_MEMORY_WS_METHODS.syncRun, {
  payload: Schema.Struct({}),
  success: BatonMemorySyncRunResult,
  error: MemoryErrors,
});
const WsBatonMemorySyncHelloRpc = Rpc.make(BATON_MEMORY_WS_METHODS.syncHello, {
  payload: Schema.Struct({}),
  success: BatonMemorySyncHelloResult,
  error: MemoryErrors,
});
const WsBatonMemorySyncPullRpc = Rpc.make(BATON_MEMORY_WS_METHODS.syncPull, {
  payload: BatonMemorySyncPullInput,
  success: BatonMemorySyncPullResult,
  error: MemoryErrors,
});
const WsBatonMemorySyncPushRpc = Rpc.make(BATON_MEMORY_WS_METHODS.syncPush, {
  payload: BatonMemorySyncPushInput,
  success: BatonMemorySyncPushResult,
  error: MemoryErrors,
});
const WsBatonMemoryImportRpc = Rpc.make(BATON_MEMORY_WS_METHODS.import, {
  payload: BatonMemoryImportInput,
  success: BatonMemoryImportResult,
  error: MemoryErrors,
});
const WsBatonMemoryPullRpc = Rpc.make(BATON_MEMORY_WS_METHODS.pull, {
  payload: BatonMemoryPullInput,
  success: BatonMemoryPullResult,
  error: MemoryErrors,
});
const WsBatonMemoryHistorySearchRpc = Rpc.make(BATON_MEMORY_WS_METHODS.historySearch, {
  payload: BatonMemoryHistorySearchInput,
  success: BatonMemoryHistorySearchResult,
  error: MemoryErrors,
});
const WsBatonMemoryExportRpc = Rpc.make(BATON_MEMORY_WS_METHODS.export, {
  payload: Schema.Struct({}),
  success: BatonMemoryExportResult,
  error: MemoryErrors,
});

const WsBatonWatchGetRpc = Rpc.make(BATON_WATCH_WS_METHODS.watchGet, {
  payload: Schema.Struct({}),
  success: WatchResult,
  error: Schema.Union([WorkSessionError, EnvironmentAuthorizationError]),
});

const WsBatonRecordListRpc = Rpc.make(BATON_RECORD_WS_METHODS.list, {
  payload: BatonRecordListInput,
  success: BatonRecordListResult,
  error: EnvironmentAuthorizationError,
});

const WsBatonRecordAppendRpc = Rpc.make(BATON_RECORD_WS_METHODS.append, {
  payload: BatonRecordAppendInput,
  success: BatonRecordAppendResult,
  error: EnvironmentAuthorizationError,
});

const WsBatonWorkSessionSettleRpc = Rpc.make(BATON_WS_METHODS.workSessionSettle, {
  payload: WorkSessionRefInput,
  success: WorkSessionResult,
  error: Schema.Union([WorkSessionError, EnvironmentAuthorizationError]),
});

const WsBatonWorkSessionUnsettleRpc = Rpc.make(BATON_WS_METHODS.workSessionUnsettle, {
  payload: WorkSessionRefInput,
  success: WorkSessionResult,
  error: Schema.Union([WorkSessionError, EnvironmentAuthorizationError]),
});

const WsBatonWorkSessionArchiveRpc = Rpc.make(BATON_WS_METHODS.workSessionArchive, {
  payload: WorkSessionRefInput,
  success: WorkSessionResult,
  error: Schema.Union([WorkSessionError, EnvironmentAuthorizationError]),
});

const WsBatonWorkSessionUnarchiveRpc = Rpc.make(BATON_WS_METHODS.workSessionUnarchive, {
  payload: WorkSessionRefInput,
  success: WorkSessionResult,
  error: Schema.Union([WorkSessionError, EnvironmentAuthorizationError]),
});

const WsBatonFleetGetRpc = Rpc.make(BATON_WS_METHODS.fleetGet, {
  payload: BatonFleetInput,
  success: BatonFleetResult,
  error: Schema.Union([WorkSessionError, EnvironmentAuthorizationError]),
});

const WsBatonOrchestrationRuleCreateRpc = Rpc.make(BATON_ORCHESTRATION_WS_METHODS.ruleCreate, {
  payload: OrchestrationRuleCreateInput,
  success: OrchestrationRuleResult,
  error: Schema.Union([OrchestrationRuleError, EnvironmentAuthorizationError]),
});

const WsBatonOrchestrationRuleListRpc = Rpc.make(BATON_ORCHESTRATION_WS_METHODS.ruleList, {
  payload: OrchestrationRuleListInput,
  success: OrchestrationRuleListResult,
  error: Schema.Union([OrchestrationRuleError, EnvironmentAuthorizationError]),
});

const WsBatonOrchestrationRuleDisableRpc = Rpc.make(BATON_ORCHESTRATION_WS_METHODS.ruleDisable, {
  payload: OrchestrationRuleRefInput,
  success: OrchestrationRuleResult,
  error: Schema.Union([OrchestrationRuleError, EnvironmentAuthorizationError]),
});

const WsBatonOrchestrationRuleEnableRpc = Rpc.make(BATON_ORCHESTRATION_WS_METHODS.ruleEnable, {
  payload: OrchestrationRuleRefInput,
  success: OrchestrationRuleResult,
  error: Schema.Union([OrchestrationRuleError, EnvironmentAuthorizationError]),
});

const WsBatonOrchestrationRuleConfirmRpc = Rpc.make(BATON_ORCHESTRATION_WS_METHODS.ruleConfirm, {
  payload: OrchestrationConfirmInput,
  success: OrchestrationRuleListResult,
  error: Schema.Union([OrchestrationRuleError, EnvironmentAuthorizationError]),
});

// The intent surface. `resolve` reads and `run` writes, and they are separate
// methods so the scope map can say so: previewing what a sentence would do must
// not need permission to do it.

const WsBatonIntentResolveRpc = Rpc.make(BATON_INTENT_WS_METHODS.intentResolve, {
  payload: BatonIntentInput,
  success: BatonIntentResolveResult,
  error: Schema.Union([BatonIntentError, EnvironmentAuthorizationError]),
});

const WsBatonIntentRunRpc = Rpc.make(BATON_INTENT_WS_METHODS.intentRun, {
  payload: BatonIntentInput,
  success: BatonIntentRunResult,
  error: Schema.Union([BatonIntentError, EnvironmentAuthorizationError]),
});

const WsBatonIntentListRpc = Rpc.make(BATON_INTENT_WS_METHODS.intentList, {
  payload: BatonIntentListInput,
  success: BatonIntentListResult,
  error: Schema.Union([BatonIntentError, EnvironmentAuthorizationError]),
});

// Sessions Baton adopted rather than started (§9). Discovery reads; the rest
// change what an external runtime is doing, or what Baton believes about it.

const WsBatonAdoptedDiscoverRpc = Rpc.make(BATON_ADOPTED_WS_METHODS.adoptedDiscover, {
  payload: AdoptedDiscoverInput,
  success: AdoptedDiscoverResult,
  error: Schema.Union([AdoptedSessionError, EnvironmentAuthorizationError]),
});

const WsBatonAdoptedRegisterRpc = Rpc.make(BATON_ADOPTED_WS_METHODS.adoptedRegister, {
  payload: AdoptedRegisterInput,
  success: AdoptedSessionResult,
  error: Schema.Union([AdoptedSessionError, EnvironmentAuthorizationError]),
});

const WsBatonAdoptedListRpc = Rpc.make(BATON_ADOPTED_WS_METHODS.adoptedList, {
  payload: AdoptedListInput,
  success: AdoptedSessionListResult,
  error: Schema.Union([AdoptedSessionError, EnvironmentAuthorizationError]),
});

const WsBatonAdoptedRefreshRpc = Rpc.make(BATON_ADOPTED_WS_METHODS.adoptedRefresh, {
  payload: AdoptedRefreshInput,
  success: AdoptedSessionResult,
  error: Schema.Union([AdoptedSessionError, EnvironmentAuthorizationError]),
});

const WsBatonAdoptedDetachRpc = Rpc.make(BATON_ADOPTED_WS_METHODS.adoptedDetach, {
  payload: AdoptedRefInput,
  success: AdoptedSessionResult,
  error: Schema.Union([AdoptedSessionError, EnvironmentAuthorizationError]),
});

const WsBatonAdoptedSendInputRpc = Rpc.make(BATON_ADOPTED_WS_METHODS.adoptedSendInput, {
  payload: AdoptedSendInputInput,
  success: AdoptedSendInputResult,
  error: Schema.Union([AdoptedSessionError, EnvironmentAuthorizationError]),
});

const WsBatonAdoptedReadOutputRpc = Rpc.make(BATON_ADOPTED_WS_METHODS.adoptedReadOutput, {
  payload: AdoptedReadOutputInput,
  success: AdoptedReadOutputResult,
  error: Schema.Union([AdoptedSessionError, EnvironmentAuthorizationError]),
});

const WsBatonSubscribeWorkSessionsRpc = Rpc.make(BATON_WS_METHODS.subscribeWorkSessions, {
  payload: Schema.Struct({}),
  success: WorkSessionStreamItem,
  error: Schema.Union([WorkSessionError, EnvironmentAuthorizationError]),
  stream: true,
});

export class BatonRpcScopeAuthorization extends RpcMiddleware.Service<BatonRpcScopeAuthorization>()(
  "baton/contracts/BatonRpcScopeAuthorization",
  { error: EnvironmentAuthorizationError },
) {}

export const BatonRpcGroup = RpcGroup.make(
  WsBatonAccountPoolRpc,
  WsBatonAccountUseRpc,
  WsBatonOnLimitRpc,
  WsBatonSetOnLimitRpc,
  WsBatonThreadKeptRpc,
  WsBatonThreadKeepRpc,
  WsBatonAccountWeeklyRpc,
  WsBatonWorkSessionListRpc,
  WsBatonWorkSessionCreateRpc,
  WsBatonWorkSessionUpdateRpc,
  WsBatonWorkSessionAttachThreadRpc,
  WsBatonWorkSessionDetachThreadRpc,
  WsBatonWorkSessionStartThreadRpc,
  WsBatonWorkSessionHandoffRpc,
  WsBatonHerdrSendRpc,
  WsBatonLiveAttachRpc,
  WsBatonLiveAdoptRpc,
  WsBatonLiveSetModelRpc,
  WsBatonWorkSessionSettleRpc,
  WsBatonWorkSessionUnsettleRpc,
  WsBatonWorkSessionArchiveRpc,
  WsBatonWorkSessionUnarchiveRpc,
  WsBatonFleetGetRpc,
  WsBatonJobListRpc,
  WsBatonJobStartRpc,
  WsBatonJobPlaceRpc,
  WsBatonJobHandoffRpc,
  WsBatonJobTeamRpc,
  WsBatonJobAgreeRpc,
  WsBatonJobRefineRpc,
  WsBatonJobGrantRpc,
  WsBatonJobRevokeRpc,
  WsBatonJobStopRpc,
  WsBatonJobScheduleRpc,
  WsBatonJobSplitRpc,
  WsBatonWatchGetRpc,
  WsBatonRecordListRpc,
  WsBatonRecordAppendRpc,
  WsBatonWeaveSendRpc,
  WsBatonWeaveListRpc,
  WsBatonWeaveTickRpc,
  WsBatonCommitmentListRpc,
  WsBatonCommitmentUpsertRpc,
  WsBatonPhoneCallRpc,
  WsBatonSessionsListRpc,
  WsBatonSessionsFoldersRpc,
  WsBatonSessionsCleanupRpc,
  WsBatonSessionsAutoResumeRpc,
  WsBatonSessionsRetireHandoffRpc,
  WsBatonSessionsReattachRpc,
  WsBatonSessionsKeptRpc,
  WsBatonSessionsWaitingRpc,
  WsBatonSessionsInFlightRpc,
  WsBatonSessionsAcrossRpc,
  WsBatonSessionsResumeRpc,
  WsBatonSessionsCreateRpc,
  WsBatonSessionsSendRpc,
  WsBatonCloudReadRpc,
  WsBatonCloudActRpc,
  WsBatonCloudApproveRpc,
  WsBatonMemoryListRpc,
  WsBatonMemorySearchRpc,
  WsBatonMemoryAddRpc,
  WsBatonMemoryEditRpc,
  WsBatonMemoryPinRpc,
  WsBatonMemoryForgetRpc,
  WsBatonMemoryAcceptRpc,
  WsBatonMemoryRecallRpc,
  WsBatonMemoryUsedRpc,
  WsBatonMemoryHistoryRpc,
  WsBatonMemoryRestoreRpc,
  WsBatonMemoryExportRpc,
  WsBatonMemoryLearnRpc,
  WsBatonMemoryImportRpc,
  WsBatonMemoryPullRpc,
  WsBatonMemoryHistorySearchRpc,
  WsBatonMemorySyncHelloRpc,
  WsBatonMemorySyncStateRpc,
  WsBatonMemorySyncSetEnabledRpc,
  WsBatonMemorySyncAddPeerRpc,
  WsBatonMemorySyncForgetRpc,
  WsBatonMemorySyncRunRpc,
  WsBatonMemorySyncPullRpc,
  WsBatonMemorySyncPushRpc,
  WsBatonOrchestrationRuleCreateRpc,
  WsBatonOrchestrationRuleListRpc,
  WsBatonOrchestrationRuleDisableRpc,
  WsBatonOrchestrationRuleEnableRpc,
  WsBatonOrchestrationRuleConfirmRpc,
  WsBatonIntentResolveRpc,
  WsBatonIntentRunRpc,
  WsBatonIntentListRpc,
  WsBatonAdoptedDiscoverRpc,
  WsBatonAdoptedRegisterRpc,
  WsBatonAdoptedListRpc,
  WsBatonAdoptedRefreshRpc,
  WsBatonAdoptedDetachRpc,
  WsBatonAdoptedSendInputRpc,
  WsBatonAdoptedReadOutputRpc,
  WsBatonSubscribeWorkSessionsRpc,
).middleware(BatonRpcScopeAuthorization);
