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
  DictationCleanupError,
  EnvironmentAuthorizationError,
  OrchestrationDispatchCommandError,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcMiddleware from "effect/rpc/RpcMiddleware";
import { TessayaFleetInput, TessayaFleetResult } from "./fleet.ts";
import { tessayaSpelling, type TessayaSpelling } from "./renamed.ts";
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
  TessayaIntentError,
  TessayaIntentInput,
  TessayaIntentListInput,
  TessayaIntentListResult,
  TessayaIntentResolveResult,
  TessayaIntentRunResult,
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
  TessayaAccountPoolInput,
  TessayaAccountPool,
  TessayaAccountPoolUnavailableError,
  TessayaAccountRotationFailedError,
  TessayaAccountRotationRefusedError,
  TessayaAccountUseInput,
  TessayaAccountUseResult,
  TessayaOnLimitInput,
  TessayaOnLimitResult,
  TessayaSetOnLimitInput,
  TessayaAccountWeeklyInput,
  TessayaAccountWeeklyResult,
  TessayaThreadKeepInput,
  TessayaThreadKeepResult,
  TessayaThreadKeptInput,
} from "./accountPool.ts";
import {
  BATON_ACCOUNTS_WS_METHODS,
  TessayaAccountsListInput,
  TessayaAccountsListResult,
} from "./accounts.ts";
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
  TessayaLiveAdoptInput,
  TessayaLiveSetModelInput,
  TessayaLiveSetModelResult,
  TessayaLiveSetAccountInput,
  TessayaLiveSessionInput,
  TessayaLiveStateResult,
  TessayaLiveCancelQueuedResult,
  TessayaLiveSetAccountResult,
  TessayaLiveAdoptResult,
  TessayaLiveAttachInput,
  TessayaLiveAttachResult,
  TessayaHerdrSendInput,
  TessayaHerdrSendResult,
} from "./liveSessions.ts";
import {
  BATON_RECORD_WS_METHODS,
  TessayaRecordAppendInput,
  TessayaRecordAppendResult,
  TessayaRecordListInput,
  TessayaRecordListResult,
} from "./record.ts";
import { BATON_WATCH_WS_METHODS, WatchResult } from "./watch.ts";
import {
  BATON_DICTATION_WS_METHODS,
  TessayaDictationCleanupInput,
  TessayaDictationCleanupResult,
  TessayaDictationCleanupStatus,
} from "./dictation.ts";
import {
  BATON_DESKTOP_SETTINGS_WS_METHODS,
  DesktopSettingsSetInput,
  DesktopSettingsSyncInput,
  DesktopSettingsSyncResult,
  DesktopSettingsView,
} from "./desktopSettings.ts";
import {
  BATON_JOB_WS_METHODS,
  TessayaJobGrantInput,
  TessayaJobListResult,
  TessayaJobRefInput,
  TessayaJobRefineInput,
  TessayaJobHandoffInput,
  TessayaTeamBoardInput,
  TessayaTeamBoardResult,
  TessayaJobPlaceInput,
  TessayaJobPlacementError,
  TessayaJobStartInput,
  TessayaJobStartResult,
  TessayaJobStopResult,
  TessayaJobScheduleInput,
  TessayaJobSplitInput,
  TessayaJobSplitResult,
  TessayaJobTermsResult,
} from "./jobs.ts";
import {
  BATON_WEAVE_WS_METHODS,
  TessayaWeaveError,
  TessayaWeaveListInput,
  TessayaWeaveListResult,
  TessayaWeaveSendInput,
  TessayaWeaveSendResult,
  TessayaWeaveTickInput,
  TessayaWeaveTickResult,
} from "./weave.ts";
import {
  BATON_SESSIONS_WS_METHODS,
  TessayaCatalogCreateInput,
  TessayaCatalogCreateResult,
  TessayaCatalogAutoResumeInput,
  TessayaCatalogAutoResumeResult,
  TessayaRetireHandoffInput,
  TessayaReattachInput,
  BatonMoveIntoTessayaInput,
  BatonMoveIntoTessayaResult,
  TessayaOpenInTerminalInput,
  TessayaOpenInTerminalResult,
  TessayaMainSessionInput,
  TessayaSessionDefaultsResult,
  TessayaKeptInput,
  TessayaKeptResult,
  TessayaReattachResult,
  TessayaRetireHandoffResult,
  TessayaCatalogCleanupInput,
  TessayaCatalogCleanupResult,
  TessayaCatalogFoldersInput,
  TessayaCatalogFoldersResult,
  TessayaCatalogListInput,
  TessayaCatalogListResult,
  TessayaCatalogResumeInput,
  TessayaCatalogResumeResult,
  TessayaCatalogSendInput,
  TessayaCatalogSendResult,
  TessayaCatalogWaitingInput,
  TessayaCatalogWaitingResult,
  TessayaTurnsInFlightResult,
  TessayaSessionsAcrossInput,
  TessayaSessionsAcrossResult,
} from "./sessionCatalog.ts";
import { BATON_CLOUD_WS_METHODS, TessayaCloudCallInput, TessayaCloudCallResult } from "./cloud.ts";
import { BATON_HOME_WS_METHODS, TessayaHomeCallInput, TessayaHomeCallResult } from "./home.ts";
import { BATON_VOICE_WS_METHODS, TessayaVoiceCallInput, TessayaVoiceCallResult } from "./voice.ts";
import { BATON_BRAIN_WS_METHODS, BrainUsageInput, BrainUsageResult } from "./brainUsage.ts";
import {
  BATON_PERSONAS_WS_METHODS,
  TessayaPersonasListInput,
  TessayaPersonasListResult,
} from "./personas.ts";
import {
  BATON_PROMPT_LAB_WS_METHODS,
  TessayaPromptLabInput,
  TessayaPromptLabResult,
} from "./promptLab.ts";
import {
  BATON_LEARN_WS_METHODS,
  TessayaLearnCallInput,
  TessayaLearnCallResult,
} from "./learnCall.ts";
import {
  BATON_DEVICES_WS_METHODS,
  TessayaDevicesCallInput,
  TessayaDevicesCallResult,
} from "./devices.ts";
import {
  BATON_COMMITMENT_WS_METHODS,
  TessayaCommitmentError,
  TessayaCommitmentListInput,
  TessayaCommitmentListResult,
  TessayaCommitmentUpsertInput,
  TessayaCommitmentUpsertResult,
} from "./commitments.ts";
import {
  BATON_PHONE_WS_METHODS,
  TessayaPhoneCallInput,
  TessayaPhoneCallResult,
  BatonPhoneError,
} from "./phone.ts";
import {
  BATON_MEMORY_WS_METHODS,
  TessayaMemoryDraft,
  TessayaMemoryEditInput,
  TessayaMemoryExportResult,
  TessayaMemoryForgetResult,
  TessayaMemoryImportInput,
  TessayaMemoryImportResult,
  TessayaMemoryItemResult,
  TessayaMemoryLearnInput,
  TessayaMemoryLearnResult,
  TessayaMemoryListResult,
  TessayaMemoryPinInput,
  TessayaMemoryQuery,
  TessayaMemoryHistorySearchInput,
  TessayaMemoryHistorySearchResult,
  TessayaMemoryPullInput,
  TessayaMemoryPullResult,
  TessayaMemoryRecallInput,
  TessayaMemoryRecallResult,
  TessayaMemoryRefInput,
  BatonMemoryRefusedError,
  TessayaMemorySyncAddPeerInput,
  TessayaMemorySyncError,
  TessayaMemorySyncForgetInput,
  TessayaMemorySyncHelloResult,
  TessayaMemorySyncRunResult,
  TessayaMemorySyncSetEnabledInput,
  TessayaMemorySyncStateResult,
  TessayaMemorySyncPullInput,
  TessayaMemorySyncPullResult,
  TessayaMemorySyncPushInput,
  TessayaMemorySyncPushResult,
  TessayaMemorySearchResult,
  TessayaMemoryUsedInput,
  TessayaMemoryHistoryInput,
  TessayaMemoryHistoryResult,
  TessayaMemoryRestoreInput,
} from "./memory.ts";
import {
  BATON_HANDOFF_WS_METHODS,
  WorkSessionHandoffInput,
  WorkSessionHandoffRefusedError,
  WorkSessionHandoffResult,
} from "./handoff.ts";

// Baton work sessions. `fabric.*` is the layer above provider threads: the
// user's work, which outlives the thread and the account running it. See
// `packages/contracts/src/tessaya/workSession.ts`.

const WsTessayaAccountPoolRpc = Rpc.make(BATON_ACCOUNT_WS_METHODS.accountPool, {
  payload: TessayaAccountPoolInput,
  success: TessayaAccountPool,
  error: Schema.Union([TessayaAccountPoolUnavailableError, EnvironmentAuthorizationError]),
});

const WsTessayaAccountUseRpc = Rpc.make(BATON_ACCOUNT_WS_METHODS.accountUse, {
  payload: TessayaAccountUseInput,
  success: TessayaAccountUseResult,
  error: Schema.Union([
    TessayaAccountPoolUnavailableError,
    TessayaAccountRotationRefusedError,
    TessayaAccountRotationFailedError,
    EnvironmentAuthorizationError,
  ]),
});

const WsTessayaOnLimitRpc = Rpc.make(BATON_ACCOUNT_WS_METHODS.onLimit, {
  payload: TessayaOnLimitInput,
  success: TessayaOnLimitResult,
  error: EnvironmentAuthorizationError,
});

const WsTessayaSetOnLimitRpc = Rpc.make(BATON_ACCOUNT_WS_METHODS.setOnLimit, {
  payload: TessayaSetOnLimitInput,
  success: TessayaOnLimitResult,
  error: EnvironmentAuthorizationError,
});

const WsTessayaThreadKeptRpc = Rpc.make(BATON_ACCOUNT_WS_METHODS.threadKept, {
  payload: TessayaThreadKeptInput,
  success: TessayaThreadKeepResult,
  error: EnvironmentAuthorizationError,
});

const WsTessayaThreadKeepRpc = Rpc.make(BATON_ACCOUNT_WS_METHODS.threadKeep, {
  payload: TessayaThreadKeepInput,
  success: TessayaThreadKeepResult,
  error: EnvironmentAuthorizationError,
});

const WsTessayaAccountWeeklyRpc = Rpc.make(BATON_ACCOUNT_WS_METHODS.weekly, {
  payload: TessayaAccountWeeklyInput,
  success: TessayaAccountWeeklyResult,
  error: EnvironmentAuthorizationError,
});

const WsTessayaAccountsListRpc = Rpc.make(BATON_ACCOUNTS_WS_METHODS.list, {
  payload: TessayaAccountsListInput,
  success: TessayaAccountsListResult,
  error: EnvironmentAuthorizationError,
});

const WsTessayaWorkSessionListRpc = Rpc.make(BATON_WS_METHODS.workSessionList, {
  payload: WorkSessionListInput,
  success: WorkSessionListResult,
  error: Schema.Union([WorkSessionError, EnvironmentAuthorizationError]),
});

const WsTessayaWorkSessionCreateRpc = Rpc.make(BATON_WS_METHODS.workSessionCreate, {
  payload: WorkSessionCreateInput,
  success: WorkSessionResult,
  error: Schema.Union([WorkSessionError, EnvironmentAuthorizationError]),
});

const WsTessayaWorkSessionUpdateRpc = Rpc.make(BATON_WS_METHODS.workSessionUpdate, {
  payload: WorkSessionUpdateInput,
  success: WorkSessionResult,
  error: Schema.Union([WorkSessionError, EnvironmentAuthorizationError]),
});

const WsTessayaWorkSessionAttachThreadRpc = Rpc.make(BATON_WS_METHODS.workSessionAttachThread, {
  payload: WorkSessionAttachThreadInput,
  success: WorkSessionResult,
  error: Schema.Union([WorkSessionError, EnvironmentAuthorizationError]),
});

const WsTessayaWorkSessionDetachThreadRpc = Rpc.make(BATON_WS_METHODS.workSessionDetachThread, {
  payload: WorkSessionDetachThreadInput,
  success: WorkSessionResult,
  error: Schema.Union([WorkSessionError, EnvironmentAuthorizationError]),
});

const WsTessayaWorkSessionStartThreadRpc = Rpc.make(BATON_WS_METHODS.workSessionStartThread, {
  payload: WorkSessionStartThreadInput,
  success: WorkSessionResult,
  error: Schema.Union([
    WorkSessionError,
    OrchestrationDispatchCommandError,
    EnvironmentAuthorizationError,
  ]),
});

const WsTessayaWorkSessionHandoffRpc = Rpc.make(BATON_HANDOFF_WS_METHODS.workSessionHandoff, {
  payload: WorkSessionHandoffInput,
  success: WorkSessionHandoffResult,
  error: Schema.Union([
    WorkSessionError,
    WorkSessionHandoffRefusedError,
    OrchestrationDispatchCommandError,
    EnvironmentAuthorizationError,
  ]),
});

const WsTessayaLiveAttachRpc = Rpc.make(BATON_LIVE_WS_METHODS.liveAttach, {
  payload: TessayaLiveAttachInput,
  success: TessayaLiveAttachResult,
  error: EnvironmentAuthorizationError,
});

const WsTessayaLiveAdoptRpc = Rpc.make(BATON_LIVE_WS_METHODS.liveAdopt, {
  payload: TessayaLiveAdoptInput,
  success: TessayaLiveAdoptResult,
  error: EnvironmentAuthorizationError,
});

const WsTessayaLiveSetModelRpc = Rpc.make(BATON_LIVE_WS_METHODS.liveSetModel, {
  payload: TessayaLiveSetModelInput,
  success: TessayaLiveSetModelResult,
  error: EnvironmentAuthorizationError,
});

const WsTessayaLiveSetAccountRpc = Rpc.make(BATON_LIVE_WS_METHODS.liveSetAccount, {
  payload: TessayaLiveSetAccountInput,
  success: TessayaLiveSetAccountResult,
  error: EnvironmentAuthorizationError,
});

const WsTessayaLiveStateRpc = Rpc.make(BATON_LIVE_WS_METHODS.liveState, {
  payload: TessayaLiveSessionInput,
  success: TessayaLiveStateResult,
  error: EnvironmentAuthorizationError,
});

const WsTessayaLiveCancelQueuedRpc = Rpc.make(BATON_LIVE_WS_METHODS.liveCancelQueued, {
  payload: TessayaLiveSessionInput,
  success: TessayaLiveCancelQueuedResult,
  error: EnvironmentAuthorizationError,
});

const WsTessayaHerdrSendRpc = Rpc.make(BATON_LIVE_WS_METHODS.herdrSend, {
  payload: TessayaHerdrSendInput,
  success: TessayaHerdrSendResult,
  error: EnvironmentAuthorizationError,
});

const WsTessayaJobListRpc = Rpc.make(BATON_JOB_WS_METHODS.jobList, {
  payload: Schema.Struct({}),
  success: TessayaJobListResult,
  error: Schema.Union([WorkSessionError, EnvironmentAuthorizationError]),
});
const WsTessayaJobStartRpc = Rpc.make(BATON_JOB_WS_METHODS.jobStart, {
  payload: TessayaJobStartInput,
  success: TessayaJobStartResult,
  error: Schema.Union([WorkSessionError, EnvironmentAuthorizationError]),
});
const WsTessayaJobPlaceRpc = Rpc.make(BATON_JOB_WS_METHODS.jobPlace, {
  payload: TessayaJobPlaceInput,
  success: TessayaJobStartResult,
  error: Schema.Union([TessayaJobPlacementError, WorkSessionError, EnvironmentAuthorizationError]),
});
const WsTessayaJobTeamRpc = Rpc.make(BATON_JOB_WS_METHODS.jobTeam, {
  payload: TessayaTeamBoardInput,
  success: TessayaTeamBoardResult,
  error: EnvironmentAuthorizationError,
});
const WsTessayaJobHandoffRpc = Rpc.make(BATON_JOB_WS_METHODS.jobHandoff, {
  payload: TessayaJobHandoffInput,
  success: WorkSessionHandoffResult,
  error: Schema.Union([
    TessayaJobPlacementError,
    WorkSessionError,
    WorkSessionHandoffRefusedError,
    OrchestrationDispatchCommandError,
    EnvironmentAuthorizationError,
  ]),
});
const WsTessayaJobAgreeRpc = Rpc.make(BATON_JOB_WS_METHODS.jobAgree, {
  payload: TessayaJobRefInput,
  success: TessayaJobTermsResult,
  error: Schema.Union([WorkSessionError, EnvironmentAuthorizationError]),
});
const WsTessayaJobRefineRpc = Rpc.make(BATON_JOB_WS_METHODS.jobRefine, {
  payload: TessayaJobRefineInput,
  success: TessayaJobTermsResult,
  error: Schema.Union([WorkSessionError, EnvironmentAuthorizationError]),
});
const WsTessayaJobGrantRpc = Rpc.make(BATON_JOB_WS_METHODS.jobGrant, {
  payload: TessayaJobGrantInput,
  success: TessayaJobTermsResult,
  error: Schema.Union([WorkSessionError, EnvironmentAuthorizationError]),
});
const WsTessayaJobRevokeRpc = Rpc.make(BATON_JOB_WS_METHODS.jobRevoke, {
  payload: TessayaJobGrantInput,
  success: TessayaJobTermsResult,
  error: Schema.Union([WorkSessionError, EnvironmentAuthorizationError]),
});

const WsTessayaJobStopRpc = Rpc.make(BATON_JOB_WS_METHODS.jobStop, {
  payload: TessayaJobRefInput,
  success: TessayaJobStopResult,
  error: Schema.Union([WorkSessionError, EnvironmentAuthorizationError]),
});
const WsTessayaJobScheduleRpc = Rpc.make(BATON_JOB_WS_METHODS.jobSchedule, {
  payload: TessayaJobScheduleInput,
  success: TessayaJobTermsResult,
  error: Schema.Union([WorkSessionError, EnvironmentAuthorizationError]),
});

const WsTessayaJobSplitRpc = Rpc.make(BATON_JOB_WS_METHODS.jobSplit, {
  payload: TessayaJobSplitInput,
  success: TessayaJobSplitResult,
  error: Schema.Union([WorkSessionError, EnvironmentAuthorizationError]),
});

const CommitmentErrors = Schema.Union([TessayaCommitmentError, EnvironmentAuthorizationError]);
const WsTessayaCommitmentListRpc = Rpc.make(BATON_COMMITMENT_WS_METHODS.list, {
  payload: TessayaCommitmentListInput,
  success: TessayaCommitmentListResult,
  error: CommitmentErrors,
});
const WsTessayaCommitmentUpsertRpc = Rpc.make(BATON_COMMITMENT_WS_METHODS.upsert, {
  payload: TessayaCommitmentUpsertInput,
  success: TessayaCommitmentUpsertResult,
  error: CommitmentErrors,
});

const WsTessayaPhoneCallRpc = Rpc.make(BATON_PHONE_WS_METHODS.call, {
  payload: TessayaPhoneCallInput,
  success: TessayaPhoneCallResult,
  error: Schema.Union([BatonPhoneError, EnvironmentAuthorizationError]),
});

const WsTessayaCloudReadRpc = Rpc.make(BATON_CLOUD_WS_METHODS.read, {
  payload: TessayaCloudCallInput,
  success: TessayaCloudCallResult,
  error: EnvironmentAuthorizationError,
});
const WsTessayaCloudApproveRpc = Rpc.make(BATON_CLOUD_WS_METHODS.approve, {
  payload: TessayaCloudCallInput,
  success: TessayaCloudCallResult,
  error: EnvironmentAuthorizationError,
});
const WsTessayaCloudActRpc = Rpc.make(BATON_CLOUD_WS_METHODS.act, {
  payload: TessayaCloudCallInput,
  success: TessayaCloudCallResult,
  error: EnvironmentAuthorizationError,
});

const WsTessayaHomeCallRpc = Rpc.make(BATON_HOME_WS_METHODS.call, {
  payload: TessayaHomeCallInput,
  success: TessayaHomeCallResult,
  error: EnvironmentAuthorizationError,
});

const WsTessayaDevicesCallRpc = Rpc.make(BATON_DEVICES_WS_METHODS.call, {
  payload: TessayaDevicesCallInput,
  success: TessayaDevicesCallResult,
  error: EnvironmentAuthorizationError,
});

const WsTessayaVoiceCallRpc = Rpc.make(BATON_VOICE_WS_METHODS.call, {
  payload: TessayaVoiceCallInput,
  success: TessayaVoiceCallResult,
  error: EnvironmentAuthorizationError,
});

const WsTessayaLearnCallRpc = Rpc.make(BATON_LEARN_WS_METHODS.call, {
  payload: TessayaLearnCallInput,
  success: TessayaLearnCallResult,
  error: EnvironmentAuthorizationError,
});

const CatalogErrors = EnvironmentAuthorizationError;
const WsTessayaSessionsListRpc = Rpc.make(BATON_SESSIONS_WS_METHODS.list, {
  payload: TessayaCatalogListInput,
  success: TessayaCatalogListResult,
  error: CatalogErrors,
});
const WsTessayaSessionsFoldersRpc = Rpc.make(BATON_SESSIONS_WS_METHODS.folders, {
  payload: TessayaCatalogFoldersInput,
  success: TessayaCatalogFoldersResult,
  error: CatalogErrors,
});
const WsTessayaSessionsResumeRpc = Rpc.make(BATON_SESSIONS_WS_METHODS.resume, {
  payload: TessayaCatalogResumeInput,
  success: TessayaCatalogResumeResult,
  error: CatalogErrors,
});
const WsTessayaSessionsCreateRpc = Rpc.make(BATON_SESSIONS_WS_METHODS.create, {
  payload: TessayaCatalogCreateInput,
  success: TessayaCatalogCreateResult,
  error: CatalogErrors,
});
const WsTessayaSessionsCleanupRpc = Rpc.make(BATON_SESSIONS_WS_METHODS.cleanup, {
  payload: TessayaCatalogCleanupInput,
  success: TessayaCatalogCleanupResult,
  error: CatalogErrors,
});
const WsTessayaSessionsAutoResumeRpc = Rpc.make(BATON_SESSIONS_WS_METHODS.autoResume, {
  payload: TessayaCatalogAutoResumeInput,
  success: TessayaCatalogAutoResumeResult,
  error: CatalogErrors,
});
const WsTessayaSessionsRetireHandoffRpc = Rpc.make(BATON_SESSIONS_WS_METHODS.retireHandoff, {
  payload: TessayaRetireHandoffInput,
  success: TessayaRetireHandoffResult,
  error: CatalogErrors,
});
const WsTessayaSessionsReattachRpc = Rpc.make(BATON_SESSIONS_WS_METHODS.reattach, {
  payload: TessayaReattachInput,
  success: TessayaReattachResult,
  error: CatalogErrors,
});
const WsBatonSessionsMoveIntoTessayaRpc = Rpc.make(BATON_SESSIONS_WS_METHODS.moveIntoTessaya, {
  payload: BatonMoveIntoTessayaInput,
  success: BatonMoveIntoTessayaResult,
  error: CatalogErrors,
});
const WsTessayaSessionsOpenInTerminalRpc = Rpc.make(BATON_SESSIONS_WS_METHODS.openInTerminal, {
  payload: TessayaOpenInTerminalInput,
  success: TessayaOpenInTerminalResult,
  error: CatalogErrors,
});
const WsTessayaSessionsMainSessionRpc = Rpc.make(BATON_SESSIONS_WS_METHODS.mainSession, {
  payload: TessayaMainSessionInput,
  success: TessayaSessionDefaultsResult,
  error: CatalogErrors,
});
const WsTessayaSessionsDefaultsRpc = Rpc.make(BATON_SESSIONS_WS_METHODS.sessionDefaults, {
  payload: Schema.Struct({}),
  success: TessayaSessionDefaultsResult,
  error: CatalogErrors,
});
const WsTessayaSessionsKeptRpc = Rpc.make(BATON_SESSIONS_WS_METHODS.kept, {
  payload: TessayaKeptInput,
  success: TessayaKeptResult,
  error: CatalogErrors,
});
const WsTessayaSessionsWaitingRpc = Rpc.make(BATON_SESSIONS_WS_METHODS.waiting, {
  payload: TessayaCatalogWaitingInput,
  success: TessayaCatalogWaitingResult,
  error: CatalogErrors,
});
const WsTessayaSessionsInFlightRpc = Rpc.make(BATON_SESSIONS_WS_METHODS.inFlight, {
  payload: Schema.Struct({}),
  success: TessayaTurnsInFlightResult,
  error: CatalogErrors,
});
const WsTessayaSessionsAcrossRpc = Rpc.make(BATON_SESSIONS_WS_METHODS.across, {
  payload: TessayaSessionsAcrossInput,
  success: TessayaSessionsAcrossResult,
  error: Schema.Union([WorkSessionError, EnvironmentAuthorizationError]),
});
const WsTessayaSessionsSendRpc = Rpc.make(BATON_SESSIONS_WS_METHODS.send, {
  payload: TessayaCatalogSendInput,
  success: TessayaCatalogSendResult,
  error: CatalogErrors,
});

const WeaveErrors = Schema.Union([TessayaWeaveError, EnvironmentAuthorizationError]);
const WsTessayaWeaveSendRpc = Rpc.make(BATON_WEAVE_WS_METHODS.send, {
  payload: TessayaWeaveSendInput,
  success: TessayaWeaveSendResult,
  error: WeaveErrors,
});
const WsTessayaWeaveListRpc = Rpc.make(BATON_WEAVE_WS_METHODS.list, {
  payload: TessayaWeaveListInput,
  success: TessayaWeaveListResult,
  error: WeaveErrors,
});
const WsTessayaWeaveTickRpc = Rpc.make(BATON_WEAVE_WS_METHODS.tick, {
  payload: TessayaWeaveTickInput,
  success: TessayaWeaveTickResult,
  error: WeaveErrors,
});

const MemoryErrors = Schema.Union([BatonMemoryRefusedError, EnvironmentAuthorizationError]);
const WsTessayaMemoryListRpc = Rpc.make(BATON_MEMORY_WS_METHODS.list, {
  payload: TessayaMemoryQuery,
  success: TessayaMemoryListResult,
  error: MemoryErrors,
});
const WsTessayaMemorySearchRpc = Rpc.make(BATON_MEMORY_WS_METHODS.search, {
  payload: TessayaMemoryQuery,
  success: TessayaMemorySearchResult,
  error: MemoryErrors,
});
const WsTessayaMemoryAddRpc = Rpc.make(BATON_MEMORY_WS_METHODS.add, {
  payload: TessayaMemoryDraft,
  success: TessayaMemoryItemResult,
  error: MemoryErrors,
});
const WsTessayaMemoryEditRpc = Rpc.make(BATON_MEMORY_WS_METHODS.edit, {
  payload: TessayaMemoryEditInput,
  success: TessayaMemoryItemResult,
  error: MemoryErrors,
});
const WsTessayaMemoryHistoryRpc = Rpc.make(BATON_MEMORY_WS_METHODS.history, {
  payload: TessayaMemoryHistoryInput,
  success: TessayaMemoryHistoryResult,
  error: MemoryErrors,
});
const WsTessayaMemoryRestoreRpc = Rpc.make(BATON_MEMORY_WS_METHODS.restore, {
  payload: TessayaMemoryRestoreInput,
  success: TessayaMemoryItemResult,
  error: MemoryErrors,
});
const WsTessayaMemoryPinRpc = Rpc.make(BATON_MEMORY_WS_METHODS.pin, {
  payload: TessayaMemoryPinInput,
  success: TessayaMemoryItemResult,
  error: MemoryErrors,
});
const WsTessayaMemoryForgetRpc = Rpc.make(BATON_MEMORY_WS_METHODS.forget, {
  payload: TessayaMemoryRefInput,
  success: TessayaMemoryForgetResult,
  error: MemoryErrors,
});
const WsTessayaMemoryAcceptRpc = Rpc.make(BATON_MEMORY_WS_METHODS.accept, {
  payload: TessayaMemoryRefInput,
  success: TessayaMemoryItemResult,
  error: MemoryErrors,
});
const WsTessayaMemoryRecallRpc = Rpc.make(BATON_MEMORY_WS_METHODS.recall, {
  payload: TessayaMemoryRecallInput,
  success: TessayaMemoryRecallResult,
  error: MemoryErrors,
});
const WsTessayaMemoryUsedRpc = Rpc.make(BATON_MEMORY_WS_METHODS.used, {
  payload: TessayaMemoryUsedInput,
  success: TessayaMemoryListResult,
  error: MemoryErrors,
});
const WsTessayaMemoryLearnRpc = Rpc.make(BATON_MEMORY_WS_METHODS.learn, {
  payload: TessayaMemoryLearnInput,
  success: TessayaMemoryLearnResult,
  error: MemoryErrors,
});
const WsTessayaMemorySyncStateRpc = Rpc.make(BATON_MEMORY_WS_METHODS.syncState, {
  payload: Schema.Struct({}),
  success: TessayaMemorySyncStateResult,
  error: MemoryErrors,
});
const WsTessayaMemorySyncSetEnabledRpc = Rpc.make(BATON_MEMORY_WS_METHODS.syncSetEnabled, {
  payload: TessayaMemorySyncSetEnabledInput,
  success: Schema.Struct({}),
  error: MemoryErrors,
});
const WsTessayaMemorySyncAddPeerRpc = Rpc.make(BATON_MEMORY_WS_METHODS.syncAddPeer, {
  payload: TessayaMemorySyncAddPeerInput,
  success: Schema.Struct({}),
  error: Schema.Union([
    TessayaMemorySyncError,
    BatonMemoryRefusedError,
    EnvironmentAuthorizationError,
  ]),
});
const WsTessayaMemorySyncForgetRpc = Rpc.make(BATON_MEMORY_WS_METHODS.syncForget, {
  payload: TessayaMemorySyncForgetInput,
  success: Schema.Struct({}),
  error: Schema.Union([
    TessayaMemorySyncError,
    BatonMemoryRefusedError,
    EnvironmentAuthorizationError,
  ]),
});
const WsTessayaMemorySyncRunRpc = Rpc.make(BATON_MEMORY_WS_METHODS.syncRun, {
  payload: Schema.Struct({}),
  success: TessayaMemorySyncRunResult,
  error: MemoryErrors,
});
const WsTessayaMemorySyncHelloRpc = Rpc.make(BATON_MEMORY_WS_METHODS.syncHello, {
  payload: Schema.Struct({}),
  success: TessayaMemorySyncHelloResult,
  error: MemoryErrors,
});
const WsTessayaMemorySyncPullRpc = Rpc.make(BATON_MEMORY_WS_METHODS.syncPull, {
  payload: TessayaMemorySyncPullInput,
  success: TessayaMemorySyncPullResult,
  error: MemoryErrors,
});
const WsTessayaMemorySyncPushRpc = Rpc.make(BATON_MEMORY_WS_METHODS.syncPush, {
  payload: TessayaMemorySyncPushInput,
  success: TessayaMemorySyncPushResult,
  error: MemoryErrors,
});
const WsTessayaMemoryImportRpc = Rpc.make(BATON_MEMORY_WS_METHODS.import, {
  payload: TessayaMemoryImportInput,
  success: TessayaMemoryImportResult,
  error: MemoryErrors,
});
const WsTessayaMemoryPullRpc = Rpc.make(BATON_MEMORY_WS_METHODS.pull, {
  payload: TessayaMemoryPullInput,
  success: TessayaMemoryPullResult,
  error: MemoryErrors,
});
const WsTessayaMemoryHistorySearchRpc = Rpc.make(BATON_MEMORY_WS_METHODS.historySearch, {
  payload: TessayaMemoryHistorySearchInput,
  success: TessayaMemoryHistorySearchResult,
  error: MemoryErrors,
});
const WsTessayaMemoryExportRpc = Rpc.make(BATON_MEMORY_WS_METHODS.export, {
  payload: Schema.Struct({}),
  success: TessayaMemoryExportResult,
  error: MemoryErrors,
});

const WsTessayaWatchGetRpc = Rpc.make(BATON_WATCH_WS_METHODS.watchGet, {
  payload: Schema.Struct({}),
  success: WatchResult,
  error: Schema.Union([WorkSessionError, EnvironmentAuthorizationError]),
});

const WsTessayaRecordListRpc = Rpc.make(BATON_RECORD_WS_METHODS.list, {
  payload: TessayaRecordListInput,
  success: TessayaRecordListResult,
  error: EnvironmentAuthorizationError,
});

const WsTessayaBrainUsageRpc = Rpc.make(BATON_BRAIN_WS_METHODS.usage, {
  payload: BrainUsageInput,
  success: BrainUsageResult,
  error: EnvironmentAuthorizationError,
});

const WsTessayaPersonasListRpc = Rpc.make(BATON_PERSONAS_WS_METHODS.list, {
  payload: TessayaPersonasListInput,
  success: TessayaPersonasListResult,
  error: EnvironmentAuthorizationError,
});

const WsTessayaPromptLabRpc = Rpc.make(BATON_PROMPT_LAB_WS_METHODS.call, {
  payload: TessayaPromptLabInput,
  success: TessayaPromptLabResult,
  error: EnvironmentAuthorizationError,
});

const WsTessayaRecordAppendRpc = Rpc.make(BATON_RECORD_WS_METHODS.append, {
  payload: TessayaRecordAppendInput,
  success: TessayaRecordAppendResult,
  error: EnvironmentAuthorizationError,
});

const WsTessayaDictationCleanupApiRpc = Rpc.make(BATON_DICTATION_WS_METHODS.cleanupApi, {
  payload: TessayaDictationCleanupInput,
  success: TessayaDictationCleanupResult,
  error: Schema.Union([DictationCleanupError, EnvironmentAuthorizationError]),
});

const WsTessayaDictationCleanupApiStatusRpc = Rpc.make(
  BATON_DICTATION_WS_METHODS.cleanupApiStatus,
  {
    payload: Schema.Struct({}),
    success: TessayaDictationCleanupStatus,
    error: EnvironmentAuthorizationError,
  },
);

const WsTessayaDesktopSettingsGetRpc = Rpc.make(BATON_DESKTOP_SETTINGS_WS_METHODS.get, {
  payload: Schema.Struct({}),
  success: DesktopSettingsView,
  error: EnvironmentAuthorizationError,
});

const WsTessayaDesktopSettingsSetRpc = Rpc.make(BATON_DESKTOP_SETTINGS_WS_METHODS.set, {
  payload: DesktopSettingsSetInput,
  success: DesktopSettingsView,
  error: EnvironmentAuthorizationError,
});

const WsTessayaDesktopSettingsSyncRpc = Rpc.make(BATON_DESKTOP_SETTINGS_WS_METHODS.sync, {
  payload: DesktopSettingsSyncInput,
  success: DesktopSettingsSyncResult,
  error: EnvironmentAuthorizationError,
});

const WsTessayaWorkSessionSettleRpc = Rpc.make(BATON_WS_METHODS.workSessionSettle, {
  payload: WorkSessionRefInput,
  success: WorkSessionResult,
  error: Schema.Union([WorkSessionError, EnvironmentAuthorizationError]),
});

const WsTessayaWorkSessionUnsettleRpc = Rpc.make(BATON_WS_METHODS.workSessionUnsettle, {
  payload: WorkSessionRefInput,
  success: WorkSessionResult,
  error: Schema.Union([WorkSessionError, EnvironmentAuthorizationError]),
});

const WsTessayaWorkSessionArchiveRpc = Rpc.make(BATON_WS_METHODS.workSessionArchive, {
  payload: WorkSessionRefInput,
  success: WorkSessionResult,
  error: Schema.Union([WorkSessionError, EnvironmentAuthorizationError]),
});

const WsTessayaWorkSessionUnarchiveRpc = Rpc.make(BATON_WS_METHODS.workSessionUnarchive, {
  payload: WorkSessionRefInput,
  success: WorkSessionResult,
  error: Schema.Union([WorkSessionError, EnvironmentAuthorizationError]),
});

const WsTessayaFleetGetRpc = Rpc.make(BATON_WS_METHODS.fleetGet, {
  payload: TessayaFleetInput,
  success: TessayaFleetResult,
  error: Schema.Union([WorkSessionError, EnvironmentAuthorizationError]),
});

const WsTessayaOrchestrationRuleCreateRpc = Rpc.make(BATON_ORCHESTRATION_WS_METHODS.ruleCreate, {
  payload: OrchestrationRuleCreateInput,
  success: OrchestrationRuleResult,
  error: Schema.Union([OrchestrationRuleError, EnvironmentAuthorizationError]),
});

const WsTessayaOrchestrationRuleListRpc = Rpc.make(BATON_ORCHESTRATION_WS_METHODS.ruleList, {
  payload: OrchestrationRuleListInput,
  success: OrchestrationRuleListResult,
  error: Schema.Union([OrchestrationRuleError, EnvironmentAuthorizationError]),
});

const WsTessayaOrchestrationRuleDisableRpc = Rpc.make(BATON_ORCHESTRATION_WS_METHODS.ruleDisable, {
  payload: OrchestrationRuleRefInput,
  success: OrchestrationRuleResult,
  error: Schema.Union([OrchestrationRuleError, EnvironmentAuthorizationError]),
});

const WsTessayaOrchestrationRuleEnableRpc = Rpc.make(BATON_ORCHESTRATION_WS_METHODS.ruleEnable, {
  payload: OrchestrationRuleRefInput,
  success: OrchestrationRuleResult,
  error: Schema.Union([OrchestrationRuleError, EnvironmentAuthorizationError]),
});

const WsTessayaOrchestrationRuleConfirmRpc = Rpc.make(BATON_ORCHESTRATION_WS_METHODS.ruleConfirm, {
  payload: OrchestrationConfirmInput,
  success: OrchestrationRuleListResult,
  error: Schema.Union([OrchestrationRuleError, EnvironmentAuthorizationError]),
});

// The intent surface. `resolve` reads and `run` writes, and they are separate
// methods so the scope map can say so: previewing what a sentence would do must
// not need permission to do it.

const WsTessayaIntentResolveRpc = Rpc.make(BATON_INTENT_WS_METHODS.intentResolve, {
  payload: TessayaIntentInput,
  success: TessayaIntentResolveResult,
  error: Schema.Union([TessayaIntentError, EnvironmentAuthorizationError]),
});

const WsTessayaIntentRunRpc = Rpc.make(BATON_INTENT_WS_METHODS.intentRun, {
  payload: TessayaIntentInput,
  success: TessayaIntentRunResult,
  error: Schema.Union([TessayaIntentError, EnvironmentAuthorizationError]),
});

const WsTessayaIntentListRpc = Rpc.make(BATON_INTENT_WS_METHODS.intentList, {
  payload: TessayaIntentListInput,
  success: TessayaIntentListResult,
  error: Schema.Union([TessayaIntentError, EnvironmentAuthorizationError]),
});

// Sessions Baton adopted rather than started (§9). Discovery reads; the rest
// change what an external runtime is doing, or what Baton believes about it.

const WsTessayaAdoptedDiscoverRpc = Rpc.make(BATON_ADOPTED_WS_METHODS.adoptedDiscover, {
  payload: AdoptedDiscoverInput,
  success: AdoptedDiscoverResult,
  error: Schema.Union([AdoptedSessionError, EnvironmentAuthorizationError]),
});

const WsTessayaAdoptedRegisterRpc = Rpc.make(BATON_ADOPTED_WS_METHODS.adoptedRegister, {
  payload: AdoptedRegisterInput,
  success: AdoptedSessionResult,
  error: Schema.Union([AdoptedSessionError, EnvironmentAuthorizationError]),
});

const WsTessayaAdoptedListRpc = Rpc.make(BATON_ADOPTED_WS_METHODS.adoptedList, {
  payload: AdoptedListInput,
  success: AdoptedSessionListResult,
  error: Schema.Union([AdoptedSessionError, EnvironmentAuthorizationError]),
});

const WsTessayaAdoptedRefreshRpc = Rpc.make(BATON_ADOPTED_WS_METHODS.adoptedRefresh, {
  payload: AdoptedRefreshInput,
  success: AdoptedSessionResult,
  error: Schema.Union([AdoptedSessionError, EnvironmentAuthorizationError]),
});

const WsTessayaAdoptedDetachRpc = Rpc.make(BATON_ADOPTED_WS_METHODS.adoptedDetach, {
  payload: AdoptedRefInput,
  success: AdoptedSessionResult,
  error: Schema.Union([AdoptedSessionError, EnvironmentAuthorizationError]),
});

const WsTessayaAdoptedSendInputRpc = Rpc.make(BATON_ADOPTED_WS_METHODS.adoptedSendInput, {
  payload: AdoptedSendInputInput,
  success: AdoptedSendInputResult,
  error: Schema.Union([AdoptedSessionError, EnvironmentAuthorizationError]),
});

const WsTessayaAdoptedReadOutputRpc = Rpc.make(BATON_ADOPTED_WS_METHODS.adoptedReadOutput, {
  payload: AdoptedReadOutputInput,
  success: AdoptedReadOutputResult,
  error: Schema.Union([AdoptedSessionError, EnvironmentAuthorizationError]),
});

const WsTessayaSubscribeWorkSessionsRpc = Rpc.make(BATON_WS_METHODS.subscribeWorkSessions, {
  payload: Schema.Struct({}),
  success: WorkSessionStreamItem,
  error: Schema.Union([WorkSessionError, EnvironmentAuthorizationError]),
  stream: true,
});

export class TessayaRpcScopeAuthorization extends RpcMiddleware.Service<TessayaRpcScopeAuthorization>()(
  "baton/contracts/BatonRpcScopeAuthorization",
  { error: EnvironmentAuthorizationError },
) {}

const BATON_RPCS = [
  WsTessayaAccountPoolRpc,
  WsTessayaAccountUseRpc,
  WsTessayaOnLimitRpc,
  WsTessayaSetOnLimitRpc,
  WsTessayaThreadKeptRpc,
  WsTessayaThreadKeepRpc,
  WsTessayaAccountWeeklyRpc,
  WsTessayaAccountsListRpc,
  WsTessayaWorkSessionListRpc,
  WsTessayaWorkSessionCreateRpc,
  WsTessayaWorkSessionUpdateRpc,
  WsTessayaWorkSessionAttachThreadRpc,
  WsTessayaWorkSessionDetachThreadRpc,
  WsTessayaWorkSessionStartThreadRpc,
  WsTessayaWorkSessionHandoffRpc,
  WsTessayaHerdrSendRpc,
  WsTessayaLiveAttachRpc,
  WsTessayaLiveAdoptRpc,
  WsTessayaLiveSetModelRpc,
  WsTessayaLiveSetAccountRpc,
  WsTessayaLiveStateRpc,
  WsTessayaLiveCancelQueuedRpc,
  WsTessayaWorkSessionSettleRpc,
  WsTessayaWorkSessionUnsettleRpc,
  WsTessayaWorkSessionArchiveRpc,
  WsTessayaWorkSessionUnarchiveRpc,
  WsTessayaFleetGetRpc,
  WsTessayaJobListRpc,
  WsTessayaJobStartRpc,
  WsTessayaJobPlaceRpc,
  WsTessayaJobHandoffRpc,
  WsTessayaJobTeamRpc,
  WsTessayaJobAgreeRpc,
  WsTessayaJobRefineRpc,
  WsTessayaJobGrantRpc,
  WsTessayaJobRevokeRpc,
  WsTessayaJobStopRpc,
  WsTessayaJobScheduleRpc,
  WsTessayaJobSplitRpc,
  WsTessayaWatchGetRpc,
  WsTessayaRecordListRpc,
  WsTessayaRecordAppendRpc,
  WsTessayaBrainUsageRpc,
  WsTessayaPersonasListRpc,
  WsTessayaPromptLabRpc,
  WsTessayaDictationCleanupApiRpc,
  WsTessayaDictationCleanupApiStatusRpc,
  WsTessayaDesktopSettingsGetRpc,
  WsTessayaDesktopSettingsSetRpc,
  WsTessayaDesktopSettingsSyncRpc,
  WsTessayaWeaveSendRpc,
  WsTessayaWeaveListRpc,
  WsTessayaWeaveTickRpc,
  WsTessayaCommitmentListRpc,
  WsTessayaCommitmentUpsertRpc,
  WsTessayaPhoneCallRpc,
  WsTessayaSessionsListRpc,
  WsTessayaSessionsFoldersRpc,
  WsTessayaSessionsCleanupRpc,
  WsTessayaSessionsAutoResumeRpc,
  WsTessayaSessionsRetireHandoffRpc,
  WsTessayaSessionsReattachRpc,
  WsBatonSessionsMoveIntoTessayaRpc,
  WsTessayaSessionsOpenInTerminalRpc,
  WsTessayaSessionsMainSessionRpc,
  WsTessayaSessionsDefaultsRpc,
  WsTessayaSessionsKeptRpc,
  WsTessayaSessionsWaitingRpc,
  WsTessayaSessionsInFlightRpc,
  WsTessayaSessionsAcrossRpc,
  WsTessayaSessionsResumeRpc,
  WsTessayaSessionsCreateRpc,
  WsTessayaSessionsSendRpc,
  WsTessayaCloudReadRpc,
  WsTessayaCloudActRpc,
  WsTessayaCloudApproveRpc,
  WsTessayaMemoryListRpc,
  WsTessayaMemorySearchRpc,
  WsTessayaMemoryAddRpc,
  WsTessayaMemoryEditRpc,
  WsTessayaMemoryPinRpc,
  WsTessayaMemoryForgetRpc,
  WsTessayaMemoryAcceptRpc,
  WsTessayaMemoryRecallRpc,
  WsTessayaMemoryUsedRpc,
  WsTessayaMemoryHistoryRpc,
  WsTessayaMemoryRestoreRpc,
  WsTessayaMemoryExportRpc,
  WsTessayaMemoryLearnRpc,
  WsTessayaMemoryImportRpc,
  WsTessayaMemoryPullRpc,
  WsTessayaMemoryHistorySearchRpc,
  WsTessayaMemorySyncHelloRpc,
  WsTessayaMemorySyncStateRpc,
  WsTessayaMemorySyncSetEnabledRpc,
  WsTessayaMemorySyncAddPeerRpc,
  WsTessayaMemorySyncForgetRpc,
  WsTessayaMemorySyncRunRpc,
  WsTessayaMemorySyncPullRpc,
  WsTessayaMemorySyncPushRpc,
  WsTessayaOrchestrationRuleCreateRpc,
  WsTessayaOrchestrationRuleListRpc,
  WsTessayaOrchestrationRuleDisableRpc,
  WsTessayaOrchestrationRuleEnableRpc,
  WsTessayaOrchestrationRuleConfirmRpc,
  WsTessayaIntentResolveRpc,
  WsTessayaIntentRunRpc,
  WsTessayaIntentListRpc,
  WsTessayaAdoptedDiscoverRpc,
  WsTessayaAdoptedRegisterRpc,
  WsTessayaAdoptedListRpc,
  WsTessayaAdoptedRefreshRpc,
  WsTessayaAdoptedDetachRpc,
  WsTessayaAdoptedSendInputRpc,
  WsTessayaAdoptedReadOutputRpc,
  WsTessayaSubscribeWorkSessionsRpc,
] as const;

type TessayaAlias<R> =
  R extends Rpc.Rpc<
    infer Tag,
    infer Payload,
    infer Success,
    infer Error,
    infer Middleware,
    infer Requires
  >
    ? Rpc.Rpc<TessayaSpelling<Tag>, Payload, Success, Error, Middleware, Requires>
    : never;

// Rename R1: every method also answers under its tessaya.* name, which the next build's clients call.
const TESSAYA_ALIASES = BATON_RPCS.map((rpc) =>
  Rpc.make(tessayaSpelling(rpc._tag), {
    payload: rpc.payloadSchema,
    success: rpc.successSchema,
    error: rpc.errorSchema,
  }),
) as unknown as ReadonlyArray<TessayaAlias<(typeof BATON_RPCS)[number]>>;

/** The name this build's handlers and scope table use, for a method called under either name. */
export const BATON_METHOD_OF: ReadonlyMap<string, string> = new Map(
  BATON_RPCS.flatMap((rpc) => [
    [rpc._tag, rpc._tag],
    [tessayaSpelling(rpc._tag), rpc._tag],
  ]),
);

// Newer methods join without a tessaya.* twin: one more aliased pair tips the group past what the checker can infer.
export const TessayaRpcGroup = RpcGroup.make(
  ...BATON_RPCS,
  ...TESSAYA_ALIASES,
  WsTessayaHomeCallRpc,
  WsTessayaDevicesCallRpc,
  WsTessayaVoiceCallRpc,
  WsTessayaLearnCallRpc,
).middleware(TessayaRpcScopeAuthorization);
