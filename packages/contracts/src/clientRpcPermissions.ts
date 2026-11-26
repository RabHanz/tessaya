import * as Schema from "effect/Schema";
import { GitPreparePullRequestThreadInput, GitRunStackedActionInput } from "./git.ts";
import {
  AuthAccessWriteScope,
  AuthTessayaCloudApproveScope,
  AuthEnvironmentMaintainScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthPreviewOperateScope,
  AuthProvidersManageScope,
  AuthSettingsWriteScope,
  AuthSourceControlWriteScope,
  AuthTerminalOperateScope,
  type AuthEnvironmentScope,
  mcpClientScopes,
} from "./auth.ts";
import { PeerLinkLinkPairingInput } from "./peerLink.ts";
import { ORCHESTRATION_V2_WS_METHODS } from "./orchestrationV2.ts";
import { WS_METHODS } from "./rpc.ts";

/** Incremental client enforcement; the server still authorizes every request. */
export const CLIENT_GUARDED_RPC_SCOPES = {
  [WS_METHODS.providerAuthRemoveMethod]: AuthProvidersManageScope,
  // An MCP sign-in stores a credential for the agent, as an account sign-in does.
  [WS_METHODS.providerMcpSignInStart]: AuthProvidersManageScope,
  [WS_METHODS.providerMcpSignInComplete]: AuthProvidersManageScope,
  [WS_METHODS.previewClose]: AuthPreviewOperateScope,
  // Stopping a server signals its processes, as closing a terminal does.
  [WS_METHODS.previewStopLocalServer]: AuthTerminalOperateScope,
  [WS_METHODS.serverRunStorageCleanup]: AuthSettingsWriteScope,
  // Restarts the server, as an update does.
  [WS_METHODS.serverReclaimDatabaseSpace]: AuthEnvironmentMaintainScope,
  [WS_METHODS.serverCheckOtlpEndpoint]: AuthSettingsWriteScope,
  [WS_METHODS.serverCheckSecretSource]: AuthSettingsWriteScope,
  // Listing models spends the stored API key, so only those who can choose a model may.
  [WS_METHODS.serverListTextGeneratorModels]: AuthSettingsWriteScope,
  [WS_METHODS.serverRefreshProviders]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsRunAction]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsUpdate]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsComment]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsUpdateComment]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSubmitReview]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsReplyToThread]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetThreadResolution]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetReaction]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetFilesViewed]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsRequestReviewers]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetLabels]: AuthSourceControlWriteScope,
  [WS_METHODS.issuesCreate]: AuthSourceControlWriteScope,
  [WS_METHODS.issuesComment]: AuthSourceControlWriteScope,
  [WS_METHODS.issuesUpdate]: AuthSourceControlWriteScope,
  [WS_METHODS.issuesSetState]: AuthSourceControlWriteScope,
  [WS_METHODS.issuesReact]: AuthSourceControlWriteScope,
  // A tracker credential and a project's binding are settings, saved under the same grant.
  [WS_METHODS.issueTrackersConnect]: AuthSettingsWriteScope,
  [WS_METHODS.issueTrackersBindProject]: AuthSettingsWriteScope,
  // Writing a guide runs a model on this environment's providers, which reading one does not.
  [WS_METHODS.pullRequestsGenerateReviewGuide]: AuthOrchestrationOperateScope,
  [WS_METHODS.projectsCreateFromThread]: AuthOrchestrationOperateScope,
  [WS_METHODS.sourceControlCloneRepository]: AuthSourceControlWriteScope,
  [WS_METHODS.sourceControlPublishRepository]: AuthSourceControlWriteScope,
  [WS_METHODS.sourceControlStar]: AuthSourceControlWriteScope,
  // Signing in replaces the server's GitHub credential, as saving a token in Settings does.
  [WS_METHODS.sourceControlSignInStart]: AuthSettingsWriteScope,
  [WS_METHODS.sourceControlSignInWait]: AuthSettingsWriteScope,
  [WS_METHODS.sourceControlSignInCancel]: AuthSettingsWriteScope,
  [WS_METHODS.projectCloneStart]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneCancel]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneRetry]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsPull]: AuthSourceControlWriteScope,
  [WS_METHODS.gitRunStackedAction]: AuthSourceControlWriteScope,
  [WS_METHODS.gitPreparePullRequestThread]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsCreateWorktree]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsRemoveWorktree]: AuthSourceControlWriteScope,
  [WS_METHODS.workspaceAddTaskFolderRepository]: AuthSourceControlWriteScope,
  // The server runs an approved layout command: approving one is running code there, as a terminal does.
  [WS_METHODS.workspaceApproveLayoutCommands]: AuthTerminalOperateScope,
  [WS_METHODS.vcsCreateRef]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsSwitchRef]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsInit]: AuthSourceControlWriteScope,

  // Starts an agent session on this environment that can read its logs and database.
  [WS_METHODS.serverPrepareTriage]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksUpsert]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksSetEnabled]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksDelete]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksRunNow]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksRotateWebhookToken]: AuthOrchestrationOperateScope,
  [ORCHESTRATION_V2_WS_METHODS.stopWorkflow]: AuthOrchestrationOperateScope,
  // An answer, a resume and a cancel each decide what a run's agents do next.
  [WS_METHODS.workflowsAnswer]: AuthOrchestrationOperateScope,
  [WS_METHODS.workflowsResume]: AuthOrchestrationOperateScope,
  [WS_METHODS.workflowsCancel]: AuthOrchestrationOperateScope,
  // The server runs this file: saving it is running code there, as a terminal does.
  [WS_METHODS.workflowsSaveDefinition]: AuthTerminalOperateScope,
  [WS_METHODS.workflowsDeleteDefinition]: AuthTerminalOperateScope,
  // Force stop kills agent processes, as Stop on a terminal does.
  [ORCHESTRATION_V2_WS_METHODS.forceStopThread]: AuthOrchestrationOperateScope,
  // A guest link hands thread access to someone outside, like a pairing link.
  [WS_METHODS.guestShareCreate]: AuthAccessWriteScope,
  [WS_METHODS.peerLinksLink]: AuthAccessWriteScope,
  [WS_METHODS.peerLinksUnlink]: AuthAccessWriteScope,
  // A link lets every agent here reach the other environment: Settings' bar.
  [WS_METHODS.peerLinksAnswerRequest]: AuthAccessWriteScope,
  [WS_METHODS.peerLinksPairClient]: AuthAccessWriteScope,
  [WS_METHODS.peerLinksPairLink]: AuthAccessWriteScope,
  // Send stores and sends a report from a thread's turn: the bar of running that thread.
  [WS_METHODS.agentFeedbackAnswerRequest]: AuthOrchestrationOperateScope,
} as const;
export type ClientGuardedRpcTag = keyof typeof CLIENT_GUARDED_RPC_SCOPES;

const decodePrepareThread = Schema.decodeUnknownSync(GitPreparePullRequestThreadInput);
const decodeStackedAction = Schema.decodeUnknownSync(GitRunStackedActionInput);
const decodeLinkPairing = Schema.decodeUnknownSync(PeerLinkLinkPairingInput);

/** Tessaya's device door (`BATON_DEVICES_WS_METHODS.call`); this package cannot import tessaya-contracts. */
const DEVICES_CALL = "baton.devices.call";
/** Her voices and his dictionary (`BATON_VOICE_WS_METHODS.call`): reading is a read, any change is operate. */
const VOICE_CALL = "baton.voice.call";
/** Her prompt lab (`BATON_PROMPT_LAB_WS_METHODS.call`): his prompts, the owner's settings. */
const PROMPT_LAB_CALL = "baton.promptLab.call";
/** His roster (`BATON_PERSONAS_WS_METHODS.change`): hire, edit, retire, restore; the owner's settings. */
const PERSONA_CHANGE = "baton.personas.change";
/** Who wears which body (`BATON_CAST_WS_METHODS.call`): moving a persona is operate; its view is `.get`. */
const CAST_CALL = "baton.cast.call";
/** Coming up (`BATON_UPCOMING_WS_METHODS`): reading is a read; cancelling, pausing or moving an item is operate. */
const UPCOMING_LIST = "baton.upcoming.list";
const UPCOMING_CHANGE = "baton.upcoming.change";
/** His reaction to one pulse decision (`BATON_PULSE_WS_METHODS.react`): it changes what she raises. */
const PULSE_REACT = "baton.pulse.react";

export function clientRpcRequiredScopes(
  method: string,
  input: unknown,
): readonly AuthEnvironmentScope[] {
  if (method === WS_METHODS.gitPreparePullRequestThread && input !== undefined) {
    const payload = decodePrepareThread(input);
    if (payload.mode === "worktree" && payload.threadId !== undefined)
      return [AuthSourceControlWriteScope, AuthOrchestrationOperateScope];
  }
  if (method === WS_METHODS.gitRunStackedAction && input !== undefined) {
    const payload = decodeStackedAction(input);
    if (
      payload.threadId !== undefined &&
      (payload.action === "create_pr" || payload.action === "commit_push_pr")
    )
      return [AuthSourceControlWriteScope, AuthOrchestrationReadScope];
  }
  // Handing out access takes holding it: the caller gets back a credential it can spend itself.
  if (method === WS_METHODS.peerLinksPairLink && input !== undefined) {
    const held = mcpClientScopes(decodeLinkPairing(input).access);
    return [AuthAccessWriteScope, ...held];
  }
  if (method === WS_METHODS.guestShareCreate) {
    return [AuthAccessWriteScope, AuthOrchestrationReadScope];
  }
  // Its kind sets the scope, as the server's missingTessayaScope does: owner is the camera, reboot and pictures.
  if (method === DEVICES_CALL) {
    const kind = (input as { kind?: unknown } | undefined)?.kind;
    return kind === "read"
      ? [AuthOrchestrationReadScope]
      : kind === "owner"
        ? [AuthOrchestrationReadScope, AuthTessayaCloudApproveScope]
        : [AuthOrchestrationReadScope, AuthOrchestrationOperateScope];
  }
  // Cloning a voice, and speaking in a clone, is the owner's: the approval scope, as the devices' owner kind.
  if (method === VOICE_CALL) {
    const kind = (input as { kind?: unknown } | undefined)?.kind;
    return kind === "read"
      ? [AuthOrchestrationReadScope]
      : kind === "owner"
        ? [AuthOrchestrationReadScope, AuthTessayaCloudApproveScope]
        : [AuthOrchestrationReadScope, AuthOrchestrationOperateScope];
  }
  if (method === PROMPT_LAB_CALL || method === PULSE_REACT || method === PERSONA_CHANGE)
    return [AuthSettingsWriteScope];
  if (method === CAST_CALL || method === UPCOMING_CHANGE)
    return [AuthOrchestrationReadScope, AuthOrchestrationOperateScope];
  if (method === UPCOMING_LIST) return [AuthOrchestrationReadScope];
  return Object.hasOwn(CLIENT_GUARDED_RPC_SCOPES, method)
    ? [CLIENT_GUARDED_RPC_SCOPES[method as ClientGuardedRpcTag]]
    : [];
}
