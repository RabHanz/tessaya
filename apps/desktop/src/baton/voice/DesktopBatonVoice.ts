// @effect-diagnostics globalDate:off globalTimers:off nodeBuiltinImport:off
/**
 * Baton voice on the desktop: the microphone, the tray, the HUD, the hotkeys
 * and where finished words go (§12.1, §12.3, Phase 5). D65.
 *
 * Windows first (D97, D106): capture, speech and paste are `tessaya-voice`, which is packaged
 * for Windows only so far, so elsewhere the tray says so and no microphone opens.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type {
  BatonFocusTarget,
  BatonJob,
  BatonTeamBoardResult,
  BatonJobBridgeRequest,
  BatonCommitmentBridgeRequest,
  BatonPhoneBridgeRequest,
  BatonWeaveBridgeRequest,
  BatonCloudBridgeRequest,
  BatonMemoryBridgeRequest,
  BatonRecordEntry,
  WatchFinding,
} from "@t3tools/baton-contracts";
import { BATON_DESKTOP_SETTINGS_WS_METHODS } from "@t3tools/baton-contracts";
import {
  chooseMode,
  cleanupFromSaved,
  cleanupLevelFor,
  DICTATION_MODES,
  MODE_LABELS,
  type CleanupLevel,
  type DictationMode,
} from "@t3tools/baton-shared/dictationCleanup";
import {
  createEchoGuard,
  createVoiceRouter,
  decodeWav,
  encodeWav,
  isLoneBreath,
  stripWake,
  type BatonVoiceCore,
  type EchoGuard,
  CAMPLUS_POLICY,
  voiceApproval,
  type SpeakerEmbedder,
  type SttProvider,
  type VoiceCoreEvent,
  type VoiceIntentClient,
  OVER_HER_VOICE,
} from "@t3tools/baton-voice";
import type { EscapeRank } from "../screen/escapeKey.ts";
import type { ConversationLog } from "../conversation/conversationLog.ts";
import { homeActivity, mergeFeed, parseLogEntries, todayStats } from "../home/activityLog.ts";
import type { HomeExtra } from "../home/batonHome.ts";
import {
  addEntry,
  editEntry,
  forgetLearned,
  removeEntry,
  saveDictionary,
  type VocabEntry,
} from "./dictionaryEdit.ts";
import {
  addInput,
  checkInput,
  effective,
  parseBindings,
  removeInput,
  sameInput,
  toElectronAccelerator,
  withBinding,
  type Binding,
  type BindingInput,
} from "../bindings/bindings.ts";
import { DAILY_MINUTES, jobAction, jobControls } from "../sessions/jobRows.ts";
import { approvalAction, approvalControls } from "../sessions/approvalRows.ts";
import { buildApprovals, describeApprovals } from "@t3tools/baton-shared/approvals";
import { releasesUrl, repoSlug } from "@t3tools/baton-shared/repo";
import { answerNeeds } from "../presence/needsAnswer.ts";
import { describeWeaves, type WeaveRecord } from "@t3tools/baton-shared/weave";
import {
  HOLD_KEY_CHOICES,
  resumeStep,
  SETUP_STEPS,
  setupHoldControl,
  setupMode,
} from "../setup/firstRun.ts";
import {
  describeToday,
  describeTrust,
  parseTrustLogs,
  permissionFromWords,
  trustAction,
  trustControls,
  type TrustFilter,
} from "../trust/trustRows.ts";
import { expandSnippets, exportSnippets } from "@t3tools/baton-shared/snippets";
import {
  checkTransformOutput,
  refuseTransformInput,
  transformMessage,
  transformSystemPrompt,
  type Transform,
} from "@t3tools/baton-shared/transforms";
import { createModelAsk } from "../writing/modelAsk.ts";
import {
  applyStyle,
  categoryForApp,
  cleanupSettingOf,
  STYLE_CATEGORIES,
} from "@t3tools/baton-shared/writingStyle";
import { computeDeepInsights } from "@t3tools/baton-shared/insightsDeep";
import { computeVoiceProfile } from "@t3tools/baton-shared/voiceProfile";
import { insightControls, voiceProfileControls } from "../writing/insightRows.ts";
import { previewOf, searchNotes } from "@t3tools/baton-shared/scratchpad";
import { createScratchStore } from "../writing/scratchStore.ts";
import { SCRATCH_HOTKEY, scratchAction, scratchControls } from "../writing/scratchRows.ts";
import {
  exportDictionaryCsv,
  IMPORT_MAX_BYTES,
  importDictionary,
} from "@t3tools/baton-shared/dictionaryIO";
import {
  LANGUAGE_HINT,
  languageCode,
  languageName,
  languagesFromSaved,
  outsideLanguages,
  recogniserHint,
} from "@t3tools/baton-shared/dictationLanguages";
import { ACCEPTED_EXTENSIONS, baseName, transcriptTitle } from "@t3tools/baton-shared/audioFile";
import { ffmpegToWav, transcribeFile } from "../writing/fileTranscribe.ts";
import { makeDiagnosticsFile } from "../health/diagnosticsFile.ts";
import { capabilities } from "@t3tools/baton-shared/degraded";
import { createProbes } from "../health/probes.ts";
import {
  normalizeSkillUrl,
  parseSkill,
  reviewCard,
  reviewSkill,
} from "@t3tools/baton-shared/skillReview";
import { fetchSkillText, installSkill, nameFromUrl, skillExists } from "../harness/skillInstall.ts";
import { createInOrder } from "./inOrder.ts";
import { createCommandClips } from "./keyCommands.ts";
import { beforeSpokenStop, keyDictationCommand } from "@t3tools/baton-shared/dictation";
import { createVolumeDuck } from "./volumeDuck.ts";
import { pronounceFrom } from "@t3tools/baton-shared/pronounce";
import {
  createOutputWatch,
  outputDeviceFrom,
  speakerModeOf,
  type OutputDevice,
} from "./outputDevice.ts";
import { PLACES, type PlaceId } from "./pillPlacement.ts";
import { createSilenceWatch, DEFAULT_SILENCE_SECONDS } from "@t3tools/baton-shared/silenceWatch";
import {
  HIDE_FOR_MS,
  isFullscreenWindow,
  restBarWanted,
} from "@t3tools/baton-shared/pillVisibility";
import {
  confirmed,
  RESET_LABEL,
  RESET_SCOPES,
  resetPrompt,
  type ResetScope,
} from "@t3tools/baton-shared/dataReset";
import {
  jobsDigest,
  retriesUsed,
  retryBudget,
  retryRefusal,
  retryText,
} from "@t3tools/baton-shared/jobReport";
import {
  draftMessage,
  draftSystemPrompt,
  fallbackDraft,
  notesOf,
  usableDraft,
} from "@t3tools/baton-shared/skillDraft";
import { draftPath, writeDraft } from "../harness/skillDraftFile.ts";
import { createStyleStore } from "../writing/styleStore.ts";
import {
  GUIDE_BUTTONS,
  guideAnswer,
  guideQuestion,
  styleAction,
  styleControls,
} from "../writing/styleRows.ts";
import { createJsonStore, writeJsonFile } from "../writing/jsonStore.ts";
import { createTransformStore } from "../writing/transformStore.ts";
import { transformAction, transformControls } from "../writing/transformRows.ts";
import { createSnippetStore } from "../writing/snippetStore.ts";
import { makeStyleIndex } from "@t3tools/baton-shared/stylePairs";
import { historyPairs, loadStylePairs } from "./stylePairsStore.ts";
import { snippetAction, snippetControls } from "../writing/snippetRows.ts";
import { createExternalNeeds } from "../presence/needsSources.ts";
import { briefCommitments, needsFromCommitments } from "@t3tools/baton-shared/commitments";
import { markPhase } from "../lifecycle/mainStall.ts";
import { taskbarIconFile } from "../home/artFiles.ts";
import { showTaskbarIcon } from "../taskbarIcon.ts";
import { createCommitmentSync } from "../presence/commitmentSync.ts";
import { createCommitmentStore } from "../presence/commitmentStore.ts";
import { runCommitOp } from "../presence/commitTools.ts";
import { presenceControls, presencePatch } from "../presence/presenceRows.ts";
import {
  askWhyPrompt,
  usedLine,
  EMPTY_NOW,
  nowAction,
  nowControls,
  type NowData,
} from "../presence/nowRows.ts";
import { collectNeeds } from "../presence/needsAnswer.ts";
import { createAnomalySource } from "../presence/anomalySource.ts";
import { createInitiative } from "../presence/initiativeEngine.ts";
import { readCiRuns } from "../presence/ciSource.ts";
import {
  DEFAULT_POLICY,
  triggersFromCi,
  triggersFromCommitments,
  triggersFromFindings,
  type CiRun,
  type Trigger,
} from "@t3tools/baton-shared/initiative";
import { detectSecret, REDACTED, type MemoryItem } from "@t3tools/baton-shared/memory";
import {
  PRIVATE_MEMORY_NAME,
  SERVER_MEMORY_NAME,
  applyRestore,
  memoryRestore,
  planBackup,
  previewRestore,
  writeBackup,
  type RestorePreview,
} from "../backup/backup.ts";
import { backupControls } from "../backup/backupRows.ts";
import {
  CONTINUE_TEXT,
  createRecoveryFiles,
  findInterrupted,
  mergeMarks,
  stillInterrupted,
  type Interrupted,
} from "../lifecycle/recovery.ts";
import { buildBatonTools, type ToolHost } from "../agent/batonTools.ts";
import { helpControls } from "../help/helpRows.ts";
import {
  BUILT_INS,
  createStandingStore,
  latestRuns,
  missedRunOf,
  runStandingJobs,
  statusOf,
  STANDING_RUN_TIMEOUT_MS,
  type BuiltInId,
  type StandingJobDef,
} from "../presence/standingJobs.ts";
import { skillsDirOf, waitingSkillsLine } from "../pack/learnedSkills.ts";
import { standingVerdict } from "@t3tools/baton-shared/trust";
import type { BatonInstanceWeekly, OrchestrationRuleWithFirings } from "@t3tools/baton-contracts";
import { nodeExec } from "@t3tools/baton-shared/cloud/nodeExec";
import { terminalPlan } from "../cloud/terminal.ts";
import { useVaultKey } from "../cloud/vaultKey.ts";
import type { ProviderId } from "@t3tools/baton-shared/cloud/types";
import { createCloud, DEFAULT_CLOUD, type CloudSettings } from "../cloud/cloudService.ts";
import { approvalCardControls, cloudNeeds, cloudPageControls } from "../cloud/cloudRows.ts";
import { createAwareness } from "../presence/awarenessState.ts";
import { harnessControls, pluginOfControl } from "../harness/harnessRows.ts";
import {
  CONNECTOR_INFO,
  parseConnectorSource,
  reviewConnector,
  type ConnectorKind,
} from "@t3tools/baton-shared/connectors";
import { readInventory, setPluginEnabled } from "../harness/harnessInventory.ts";
import {
  fileToEdit,
  PACK_FOLDER,
  packAction,
  readPack,
  packControls,
  packEdit,
  rosterControls,
  savePackText,
  setPersonaVoice,
  useDefault,
} from "../pack/packRows.ts";
import { createNotesStore } from "../memory/memoryNotes.ts";
import { redactForHistory } from "../vault/redact.ts";
import { pendingSecret } from "../vault/pendingSecret.ts";
import { createMemorySync } from "../memory/memorySync.ts";
import { createMemoryTab } from "../memory/memoryTab.ts";
import { createPrivateTab } from "../memory/privateTab.ts";
import type { PrivateMemory } from "../memory/privateMemoryClient.ts";
import { windowsHello } from "../vault/hello.ts";
import { desktopState, type DesktopStateInput } from "../phone/desktopState.ts";
import { createPhoneRelay, guardedPhoneCall, nextPollMs } from "../phone/phoneRelay.ts";
import { createNightlyCache, runGh } from "../presence/nightlyRead.ts";
import { createSyncExtraCache } from "../presence/syncRead.ts";
import { cloudLoginsFile, readCloudLogins } from "../presence/cloudLoginsRead.ts";
import { cloudLoginsNeeds, cloudLoginsRow } from "@t3tools/baton-shared/cloudLogins";
import { syncCapability, syncNeeds, type SyncState } from "@t3tools/baton-shared/syncState";
import { nightlyRow } from "@t3tools/baton-shared/nightly";
import { createVaultTab } from "../vault/vaultTab.ts";
import { vaultFor } from "../vault/vaultInstance.ts";
import { noteAction } from "../memory/noteRows.ts";
import {
  describeSession,
  findSession,
  orderSessions,
  sessionControls,
} from "../sessions/sessionRows.ts";
import { showLiveWhenReady, type SessionsBridge } from "../sessions/sessionsBridge.ts";
import type { BatonUpdates } from "../update/BatonUpdater.ts";
import { FRESH_WAKE_WORDS, WAKE_DEFAULTS, wakeWordsFor } from "./wakeDefaults.ts";
import { TRAY_PNG, TRAY_SIZES } from "./trayArt.ts";
import { setHideFromCapture } from "../captureProtection.ts";
import { brandMarkSvg, markSvg, withTrayState, type MarkOptions } from "./trayMark.ts";
import { parseGlass, parseMotion, type Glass, type Motion } from "../home/look.ts";
import {
  linkedT3Theme,
  parsePalette,
  T3_THEME_HALVES_KEY,
  T3_THEME_KEY,
  type Palette,
} from "../home/palette.ts";
import { parseAppearance, type Appearance } from "../home/theme.ts";
import { ART_DIR, createBatonHome, type HomeControl, type HomeState } from "../home/batonHome.ts";
import { isCompanionWindow, keepRunningForTray } from "../lastAppWindow.ts";
import { holdMainAtLaunch, launchWindows } from "../launchWindows.ts";
import { createDictationHold } from "./dictationHold.ts";
import { createComposerDictation, routePill } from "./composerDictation.ts";
import { cleanupLevelNow } from "./cleanupLevel.ts";
import { ownFieldFocused } from "./ownWindowField.ts";
import * as Electron from "electron";

import {
  BATON_COMPOSER_DICTATION_REPLY_CHANNEL,
  BATON_COMPOSER_DICTATION_CHANNEL,
  BATON_COMPOSER_FOCUS_CHANNEL,
  BATON_COMPOSER_MIC_CHANNEL,
  BATON_VOICE_FOCUS_CHANNEL,
  BATON_VOICE_REQUEST_CHANNEL,
  BATON_VOICE_RESPONSE_CHANNEL,
} from "../channels.ts";
import {
  choiceDeviceId,
  backupMics,
  choiceSummary,
  sameMic,
  setMicAt,
  micChannel,
  realDevices,
  reconcileDeviceChange,
  selectInputDevice,
  type DeviceChoice,
} from "./audioDeviceSelection.ts";
import { makeClipboardInjection } from "./clipboardInjection.ts";
import { makeFramer, pcmOf } from "./pcm.ts";
import {
  desktopVoiceContext,
  makeVoiceIntentClient,
  missingVoiceAssets,
  resolveWakeModels,
  type BrainVoiceHook,
  type VoiceAssets,
  type VoiceIntentRequest,
  type WakeWordSetting,
} from "./desktopVoiceCore.ts";
import { runChecks, type CheckInput, type CheckResult } from "./selfChecks.ts";
import type { BrainStatus } from "../screen/brainChoice.ts";
import {
  HEALTHY_RUN_MS,
  makeSidecarAudioInput,
  makeSidecarStt,
  busyAfter,
  recordingAfter,
  restartDelayMs,
  startDictationSidecar,
  takeRecording,
  recognizerUrlAllowed,
  stalePartial,
  type DictationEvent,
  type DictationSidecar,
  type GpuRecognition,
  type PasteVerdict,
  type FocusedApp,
  type RecognizerServer,
  type RecordingEntry,
  type PasteMethod,
  type SidecarDevice,
} from "./dictationSidecar.ts";
import { stillOurs, watchField, WATCH_EVERY_MS, WATCH_MS } from "./fieldWatch.ts";
import { startDictationTiming, type DictationTimer } from "./dictationTiming.ts";
import { createRemoteSettings } from "./remoteSettings.ts";
import { createLastLanded } from "./lastLanded.ts";
import { createPressGate } from "./pressGate.ts";
import {
  dictationStep,
  heldToTalk,
  type DictationEntry,
  type DictationStep,
} from "./dictationEntry.ts";
import { importWispr, makeRewriter, readDictionary } from "./dictationRewriter.ts";
import { mouseHookConfig } from "../bindings/inputConfig.ts";
import { VOICE_HOTKEYS } from "./voiceActivation.ts";
import {
  ensureModel,
  modelPresent,
  PARAKEET_FAST_MODEL,
  PARAKEET_MODEL,
  personalModelsDir,
  verifyPersonalModel,
  SPEAKER_MODEL,
  machinePicksFast,
  slowStartsAfter,
  wakeModelFor,
  weakMachine,
} from "./voiceModels.ts";
import { hudView, utteranceCaption } from "./voiceHud.ts";
import { createVoiceId } from "./voiceId.ts";
import { createSpeakerIdentity, type SpeakerIdentityService } from "./speakerIdentity.ts";
import {
  parseVoiceIdSettings,
  VOICE_ID_DEFAULTS,
  VOICE_ID_SWITCHES,
  voiceIdControls,
  type VoiceIdSettings,
} from "./voiceIdRows.ts";
import type { HostedScorer } from "./onnxHost.ts";
import { createCpuLoad, loadBefore } from "./cpuLoad.ts";
import { createRecogniserPriority, type RecogniserPriority } from "./recogniserPriority.ts";
import type {
  AssistantActions,
  AssistantFocus,
  PhoneMirror,
  ScreenCompanion,
} from "../screen/ScreenCompanion.ts";
import { focusedFolder } from "../screen/focusedFolder.ts";
import { createVoicePill, wantsMoving, type VoicePill } from "./voicePill.ts";
import { parsePillDesign, parsePillWave, type PillDesign, type PillWave } from "./pillLook.ts";
import { setPillSettings } from "./pillTheme.ts";
import {
  dictationCaption,
  createSpeechGain,
  frameLevel,
  isCancelPhrase,
  type TurnEvent,
} from "@t3tools/baton-shared/voiceTurn";
import {
  correctionsAtCaret,
  correctionsBetween,
  learnCorrection,
  observeWording,
  addNever,
  parseNever,
  type NeverList,
  parseAddToDictionary,
  removeHeard,
  screenNames,
  unteach,
  upsertEntry,
  type SeenWords,
  type VocabularyEntry,
} from "@t3tools/baton-shared/vocabulary";
import { CLEANUP_FAILED_LINE, settleOneShot } from "@t3tools/baton-shared/dictationOneShot";
import { createOneShot } from "./oneShotDictation.ts";
import {
  clipPaths,
  freeBytesOf,
  runRetention,
  saveClip,
  saveGate,
  spaceUsed,
  type KeepSettings,
} from "./audioKeep.ts";
import { acrylicSupported, createVocabToast } from "./vocabToast.ts";
import { createPillGhost } from "./pillGhost.ts";
import { WAIT_DEFAULT_MS, clampWait } from "@t3tools/baton-shared/endOfTurn";
import { wakeTrusted, wakeWordHeard } from "@t3tools/baton-shared/wakeVerify";
import { CUE_GAIN, CUE_WAIT_MS, parseCueLevel, type CueLevel } from "./pillSounds.ts";
import {
  flaggedReport,
  openHistory,
  type HiddenReason,
  type HistoryTurn,
  type TidyStatus,
} from "./history.ts";
import {
  hasRecording,
  NO_RECORDING,
  retryCleanupLevel,
  retryPlan,
  mayPasteInto,
  mayTeach,
  privateReason,
  rowMenu,
  rowText,
  undoAiEdit,
  useVersion,
  withRetry,
} from "./historyRetry.ts";
import { buildTranscriptReport } from "./transcriptReport.ts";
import { boostCore, quietThreshold, silenceWhile } from "@t3tools/baton-shared/quietSpeech";
import { makeOpusEncoder } from "./opusEncoder.ts";
import { computeInsights } from "./insights.ts";
import { readCaretContext } from "./caretContext.ts";
import { describeJobs, describeTeam } from "../agent/jobText.ts";
import { deskCall, serverOnly } from "./deskCall.ts";
import { buildAuditTrail, describeAuditTrail } from "@t3tools/baton-shared/audit";
import { describeWatch, findingsFromRecord } from "@t3tools/baton-shared/watch";
import {
  freshFindings,
  isSilenced,
  morningBrief,
  noticeLine,
  planReadyLine,
} from "@t3tools/baton-shared/attention";
import {
  contextFromLastInsert,
  fitInsertion,
  fitWithoutContext,
  closeLastSentence,
  type CaretContext,
} from "@t3tools/baton-shared/dictationFit";
import { createLoginItemState, setLoginItem } from "./loginItem.ts";
import {
  DICTATION_SETTLE_MS,
  dictationAtLaunch,
  holdFramesUntil,
  serialQueue,
  startWarmUp,
  within,
} from "./warmUp.ts";
import { makeTestAudioInput, type TestAudioEvent } from "./testAudio.ts";
import { startVoiceLoop, type VoiceLoop } from "./voiceLoop.ts";
import { createUserJobStore } from "../presence/userJobStore.ts";
import {
  dueUserJobs,
  whenText,
  type UserJob,
  type UserJobSignals,
} from "@t3tools/baton-shared/userJobs";
import {
  CLOUD_STT_PROVIDERS,
  PROVIDER_LABEL,
  RECOMMENDED,
  cloudTranscribe,
  listCloudModels,
  transcribeWithFallback,
  type CloudModel,
  type CloudSttProvider,
} from "@t3tools/baton-shared/cloudStt";
import { createCloudKeys } from "./cloudKeys.ts";
import { CLOUD_TEST_CLIP_WEBM_BASE64 } from "./cloudTestClip.ts";
import type { AudioInputDevice, AudioInputProvider, VoiceState } from "./voiceTypes.ts";

/** How long the hold key is down before its pill shows: the helper's tap cutoff (SHORT_TAP_MS), so a tap never flashes. */
const PRESS_SHOW_MS = 200;
// Windows types into whatever has focus; there is no narrower target to name.
const FOCUSED_FIELD: BatonFocusTarget = {
  producer: "desktop",
  kind: "editable",
  label: "the focused field",
  injectable: true,
  origin: null,
};

/** A house or device tool's call to this machine's server (deskCall: always its own door). */
interface HomeBridgeRequest {
  readonly kind: "home" | "devices";
  readonly op: "read" | "act" | "owner";
  readonly args: { readonly op: string; readonly args: Readonly<Record<string, unknown>> };
}

interface MicSetting {
  /** Part of the device name, as Windows shows it. */
  readonly name: string;
  /** One input of a multi-input interface, zero-based; null mixes them. */
  readonly channel: number | null;
}

interface VoiceSettings {
  /** Always-listening is opt-in: a microphone that opens itself is not a default. */
  readonly enabled: boolean;
  readonly openAtLogin: boolean;
  /** Which windows open when the app starts (launchWindows.ts); off, it waits for the tray, hotkey or dock. */
  readonly openTessayaOnStart: boolean;
  readonly openSessionsOnStart: boolean;
  readonly pinnedLabel: string | null;
  /** Where the wake and VAD models are; null = the ones that shipped with the app. */
  readonly modelsDir: string | null;
  /** Tried in order when nothing is pinned, and when the pin is unplugged. */
  readonly micOrder: ReadonlyArray<MicSetting>;
  /** "wispr": Baton holds no dictation key and leaves Wispr Flow to do it. */
  /** Baton's window: System follows Windows. */
  readonly appearance: Appearance;
  /** The kit palette the window wears (Settings, General): Woad unless he picks another. */
  readonly palette: Palette;
  /** Tessaya has set the T3 window's theme to match its palette at least once. */
  readonly t3ThemeLinked: boolean;
  /** Motion and glass (Settings, General); the system can ask for less on top of this. */
  readonly motion: Motion;
  readonly glass: Glass;
  /** Content protection on Tessaya's windows: out of screenshots, recordings and screen sharing. Off unless he asks. */
  readonly hideFromCapture: boolean;
  /** The soft cues when listening starts, when a turn ends, after a long wait and on an error. */
  readonly cues: CueLevel;
  /** Hold-key dictation plays no cue unless he asks. */
  readonly holdKeyCues: boolean;
  /** His words in the pill as he dictates, and their cleanup after the paste. */
  readonly showWords: boolean;
  /** "field": his words at the caret of the field they go into when it says where; "pill": always in the pill. */
  readonly pillStyle: "pill" | "field";
  /** How the pill looks (Settings → Appearance), and its waveform: "match" is the design's own. */
  readonly pillDesign: PillDesign;
  readonly pillWaveform: PillWave;
  /** Windows 11's acrylic behind the pill's island and the cards beside it; off by default. */
  readonly frosted: boolean;
  /** How long a pause must last before a spoken turn is over, in ms; unfinished words get longer. */
  readonly waitMs: number;
  /** How long it listens after the wake word with nothing said, in ms. */
  readonly wakeListenMs: number;
  /** How long the conversation stays open after a reply, in ms. */
  readonly conversationOpenMs: number;
  /** Recognise the audio before a wake and wake only when the wake word is in it. */
  readonly verifyWake: boolean;
  /** Words he fixes after Tessaya writes them, and names he keeps using, join his vocabulary. */
  readonly learnWords: boolean;
  /** For whispering or a far mic: audio is lifted and wake thresholds lowered. Off by default. */
  readonly quietSpeech: boolean;
  /**
   * Headphones: the mic cannot hear Tessaya, so it listens all the time and speech over her voice cuts in.
   * Automatic reads the playback device; the other two are his override.
   */
  readonly outputDevice: OutputDevice;
  /** His own pronunciations, word → how to say it ("pronounce" in fabric-voice.json); see pronounce.ts. */
  readonly pronounce: Readonly<Record<string, string>>;
  /** Over speakers: hear him through her voice (the echo guard). Measured, not yet reliable enough to be the default. */
  readonly voiceBargeIn: boolean;
  /** Voice ID and its switches (voiceIdRows.ts). */
  readonly voiceId: VoiceIdSettings;
  /** Two quick taps of the dictation key keep the microphone open until the next press. */
  readonly doubleTap: boolean;
  /** Keep the audio of dictations and spoken turns (Opus), never anything else. Off until he says so. */
  readonly keepVoice: boolean;
  readonly keepDays: number;
  /** Gigabytes of corrected clips kept past the days. */
  readonly keepCapGb: number;
  /** A small mark while idle; nothing on screen otherwise. */
  readonly pillAtRest: boolean;
  /** The resting bar stays hidden until this time (epoch ms), by his choice. */
  readonly pillHiddenUntil: number;
  /** The resting bar steps aside for a full-screen app or game. */
  readonly hideInFullscreen: boolean;
  /** Lower or mute the system volume while he dictates, and put it back after. */
  readonly duckWhileDictating: "off" | "lower" | "mute";
  /** A card and a pill message when the microphone is open but silent this long; 0 is off. */
  readonly micSilenceSeconds: number;
  /** A line when something first needs him: Off, a card only, or said aloud as well. */
  readonly noticeMode: "off" | "written" | "spoken";
  /** "22-8" is silent from 22:00 to 08:00; "none" is never silent. */
  readonly quietHours: string;
  /** Nothing unprompted is said or offered while this is on. */
  readonly doNotDisturb: boolean;
  /** Same, until this time (epoch ms): the one-hour snooze. */
  readonly snoozeUntil: number;
  readonly briefMode: "off" | "written" | "spoken";
  /** Repositories whose ledger labels count in "what needs me" (read-only, gh), and a deadlines file. */
  /** What the assistant may know of his state: each off until he turns it on (D149). */
  readonly awarenessWindow: boolean;
  readonly awarenessIdle: boolean;
  readonly awarenessFocus: boolean;
  readonly awarenessJobs: boolean;
  /** Offers when something needs a look: Off, a card with Yes, Later, Never, or the card and one spoken line. */
  readonly initiativeMode: "off" | "written" | "spoken";
  readonly initiativePerHour: number;
  /** Repositories whose failed builds become offers (gh, read-only). */
  readonly ciRepos: ReadonlyArray<string>;
  readonly needsRepos: ReadonlyArray<string>;
  readonly needsDeadlinesFile: string | null;
  /** Files other systems write about what needs him (read-only). */
  readonly needsFeeds: ReadonlyArray<string>;
  /** Sources he expects; one with no readable feed is listed as not connected. */
  readonly needsExpect: ReadonlyArray<string>;
  readonly pillEdge: "bottom" | "top";
  readonly dictation: "baton" | "wispr";
  /**
   * "v3" is many languages at 740 MB; "fast" is English only, 229 MB, 3.4x quicker; "personal" is his own fine-tune,
   * used only while it verifies against its manifest (verifyPersonalModel), else v3.
   */
  readonly speechModel: "v3" | "fast" | "personal";
  /** Who set speechModel: unset is the default, which a weak machine may change (machinePicksFast); his pick never. */
  readonly speechModelPicked?: "you" | "machine";
  /** Starts in a row whose model load was slow (slowStartsAfter). */
  readonly slowStarts?: number;
  readonly holdKey: string;
  readonly toggleKey: string;
  /** The first-run guide was finished or skipped. */
  readonly setupDone?: boolean;
  /** An existing install answered the one offer of the tour on Home. */
  readonly setupOffered?: boolean;
  /** The tour step it was left on, to reopen there. */
  readonly setupStep?: number;
  /** Cloud tasks: off until he turns them on. */
  readonly cloud?: Partial<CloudSettings>;
  readonly paste: PasteMethod;
  /** T3's composer microphone on this desktop: Tessaya's dictation (the default) or T3's own voice input. */
  readonly composerMic: "tessaya" | "t3";
  /** The languages he speaks; empty detects any. */
  readonly languages: ReadonlyArray<string>;
  /** Who turns his speech into words: this computer (default), or a cloud provider on his own key. */
  readonly recognition: "local" | "cloud";
  readonly cloudProvider: CloudSttProvider;
  /** The provider's model; null is its recommended one. */
  readonly cloudModel: string | null;
  /** His recogniser services, first choice first; each one's token is kept encrypted (`recognizer-keys.json`). */
  readonly recognizers: ReadonlyArray<string>;
  /** "Recognise on my servers": off by default; on, a dictation goes to the first healthy one, this machine last. */
  readonly recognizeOnServers: boolean;
  /** Recognise on the graphics card (Windows, Vulkan): Auto when a capable card is present, On for any, Off never. */
  readonly gpuRecognition: GpuRecognition;
  /** "claude" adds his own Claude for what code cannot settle; see dictationRewriter.ts. */
  readonly dictationCleanup: CleanupLevel;
  /** He picked it himself; a value this branch saved for him does not count (D114). */
  readonly dictationCleanupChosen?: boolean;
  /** The pill once said Claude can tidy dictation too; it never says it again. */
  readonly cleanupOffered?: boolean;
  /** A family alias, on his subscription. */
  readonly cleanupModel: string;
  readonly claudeBinary: string;
  /** His writing mode for an app, by exe name; anything else is chosen from the app. */
  readonly appModes: Readonly<Record<string, DictationMode>>;
  /** All enabled words listen at once. A new word needs `<word>.onnx` in `<state dir>/voice/models`. */
  readonly wakeWords: ReadonlyArray<WakeWordSetting>;
  /** The default wake-word set this file has been given (wakeDefaults.ts). */
  readonly wakeDefaults: number;
  /** The default hold key this file has been moved to (`HOLD_KEY_DEFAULTS`). */
  readonly holdKeyDefaults: number;
  /** Keys and mouse buttons he set for actions; an action not listed has its default (D141). */
  readonly bindings: ReadonlyArray<Binding>;
}

/**
 * Hold to dictate. The sidecar's hook masks the release, so neither Start nor the app's menu bar opens; any other key
 * pressed with it (Win+Alt+R) cancels it and goes on to Windows. Clear of Wispr Flow's Ctrl+Win and Ctrl+Alt+Win.
 */
export const HOLD_KEY = "Alt+Win";
/** Bumped when the default hold key moves: a file still on an older default is moved once, a key he chose is kept. */
const HOLD_KEY_DEFAULTS = 3;
/** Each old default, by the `holdKeyDefaults` it stopped being the default at. */
const OLD_HOLD_KEYS: ReadonlyArray<readonly [number, string]> = [
  [2, "Ctrl+Alt+Space"],
  [3, "Ctrl+Shift+Win"],
];

/** His hold key after this file's moves: a default a later build replaced becomes today's, anything else is his. */
export const holdKeyFrom = (saved: Record<string, unknown>): string => {
  const held = typeof saved["holdKey"] === "string" ? saved["holdKey"] : HOLD_KEY;
  const seen = typeof saved["holdKeyDefaults"] === "number" ? saved["holdKeyDefaults"] : 0;
  return OLD_HOLD_KEYS.some(([until, key]) => seen < until && key === held) ? HOLD_KEY : held;
};

const DEFAULT_SETTINGS: VoiceSettings = {
  enabled: false,
  openAtLogin: false,
  openTessayaOnStart: false,
  openSessionsOnStart: true,
  pinnedLabel: null,
  modelsDir: null,
  // Empty on purpose: a machine lists the interfaces it prefers in its own settings file.
  micOrder: [],
  appearance: "system",
  palette: "woad",
  t3ThemeLinked: false,
  motion: "full",
  glass: "on",
  hideFromCapture: false,
  cues: "normal",
  holdKeyCues: false,
  showWords: true,
  // The pill until D has been tried on Windows; the text box is opt-in under Settings → Dictation → Pill style.
  pillStyle: "pill",
  pillDesign: "tessaya",
  pillWaveform: "match",
  frosted: false,
  waitMs: WAIT_DEFAULT_MS,
  wakeListenMs: 8_000,
  conversationOpenMs: 30_000,
  verifyWake: true,
  learnWords: true,
  quietSpeech: false,
  outputDevice: "auto",
  pronounce: {},
  voiceBargeIn: false,
  voiceId: VOICE_ID_DEFAULTS,
  doubleTap: true,
  keepVoice: false,
  keepDays: 30,
  keepCapGb: 2,
  pillAtRest: false,
  pillHiddenUntil: 0,
  hideInFullscreen: true,
  duckWhileDictating: "off",
  micSilenceSeconds: DEFAULT_SILENCE_SECONDS,
  noticeMode: "written",
  quietHours: "22-8",
  doNotDisturb: false,
  snoozeUntil: 0,
  briefMode: "written",
  awarenessWindow: false,
  awarenessIdle: false,
  awarenessFocus: false,
  awarenessJobs: false,
  initiativeMode: "written",
  initiativePerHour: 3,
  ciRepos: [],
  needsRepos: [],
  needsDeadlinesFile: null,
  needsFeeds: [],
  needsExpect: [],
  pillEdge: "bottom",
  dictation: "baton",
  speechModel: "v3",
  holdKey: HOLD_KEY,
  toggleKey: "Ctrl+Alt+Shift+Space",
  paste: "ctrl_v",
  composerMic: "tessaya",
  languages: ["en"],
  recognition: "local",
  cloudProvider: "openai",
  cloudModel: null,
  recognizers: [],
  recognizeOnServers: false,
  gpuRecognition: "auto",
  // Local until D31 is ruled on: "claude" sends flagged dictation to Anthropic (D105).
  dictationCleanup: "local",
  cleanupModel: "haiku",
  claudeBinary: "claude",
  appModes: {},
  wakeWords: FRESH_WAKE_WORDS,
  wakeDefaults: WAKE_DEFAULTS,
  holdKeyDefaults: HOLD_KEY_DEFAULTS,
  bindings: [],
};

/** Time for the window he was in to come forward after Home steps aside for Paste again. */
const PASTE_AGAIN_MS = 350;
/** The renderer has this long to answer an intent call before the core is told it failed. */
const REQUEST_TIMEOUT_MS = 20_000;
const PHONE_POLL_MS = 5_000;
/** Between held syncs of an agent's settings changes (each waits on the server until one comes), and after a failure. */
const REMOTE_SETTINGS_GAP_MS = 1_000;
const REMOTE_SETTINGS_RETRY_MS = 30_000;
/** Sent again at least this often, so the server can tell a quiet desktop from a gone one. */
const STATE_REFRESH_MS = 5 * 60_000;
/** Under the context bus's 30 s TTL, so what Baton has open never expires while it is open. */
const CONTEXT_REFRESH_MS = 10_000;
/** As the paste's own caret read: a field that hangs UI Automation teaches nothing. */
const LEARN_CARET_MS = 1_500;
/** Joins a taught form to its word in the toast, and splits it back on Discard. */
const TAUGHT = " \u2192 ";
/** How soon a plugged or unplugged mic is noticed; listing devices costs a few milliseconds. */
const MIC_POLL_MS = 5_000;
/** The pointer does not wait on a slow accessibility tree. */
const LOCATE_TIMEOUT_MS = 1_500;
const LOCATE_MAX_DIP = 160;

/** Only ws:// addresses on his tailnet (`recognizerUrlAllowed`); a token is never read from settings. */
export const recognizersFrom = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value)
    ? value.filter((url): url is string => typeof url === "string" && recognizerUrlAllowed(url))
    : [];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const readSettings = (path: string): VoiceSettings => {
  try {
    // A damaged file goes aside as .bad, so the defaults saved next never land on his settings.
    const saved = createJsonStore<Record<string, unknown> | null>(path, null, isRecord).read();
    if (saved === null) return DEFAULT_SETTINGS;
    const wakeWords = wakeWordsFor(saved);
    const holdKey = holdKeyFrom(saved);
    // The file records what was resolved (the one-time defaults too), not only memory.
    if (
      saved["wakeDefaults"] !== WAKE_DEFAULTS ||
      saved["holdKeyDefaults"] !== HOLD_KEY_DEFAULTS ||
      (JSON.stringify(wakeWords) !== JSON.stringify(saved["wakeWords"]) &&
        Array.isArray(saved["wakeWords"]))
    ) {
      try {
        writeJsonFile(path, {
          ...saved,
          wakeWords,
          wakeDefaults: WAKE_DEFAULTS,
          holdKey,
          holdKeyDefaults: HOLD_KEY_DEFAULTS,
        });
      } catch {
        // The file is the user's; if it cannot be written the memory copy is still right.
      }
    }
    return {
      ...DEFAULT_SETTINGS,
      ...cleanupFromSaved(saved),
      // After the spread: it carries every saved field raw, and these are the resolved ones.
      wakeWords,
      wakeDefaults: WAKE_DEFAULTS,
      holdKey,
      holdKeyDefaults: HOLD_KEY_DEFAULTS,
      bindings: parseBindings(saved["bindings"]),
      learnWords: saved["learnWords"] !== false,
      composerMic: saved["composerMic"] === "t3" ? "t3" : "tessaya",
      showWords: saved["showWords"] !== false,
      openTessayaOnStart: saved["openTessayaOnStart"] === true,
      openSessionsOnStart: saved["openSessionsOnStart"] !== false,
      pillStyle: saved["pillStyle"] === "field" ? "field" : "pill",
      pillDesign: parsePillDesign(saved["pillDesign"]),
      pillWaveform: parsePillWave(saved["pillWaveform"]),
      frosted: saved["frosted"] === true,
      quietSpeech: saved["quietSpeech"] === true,
      outputDevice: outputDeviceFrom(saved),
      pronounce: pronounceFrom(saved["pronounce"]),
      voiceBargeIn: saved["voiceBargeIn"] === true,
      voiceId: parseVoiceIdSettings(saved["voiceId"]),
      doubleTap: saved["doubleTap"] !== false,
      appearance: parseAppearance(saved["appearance"]),
      palette: parsePalette(saved["palette"]),
      t3ThemeLinked: saved["t3ThemeLinked"] === true,
      motion: parseMotion(saved["motion"]),
      glass: parseGlass(saved["glass"]),
      hideFromCapture: saved["hideFromCapture"] === true,
      languages: languagesFromSaved(saved),
      recognition: saved["recognition"] === "cloud" ? "cloud" : "local",
      cloudProvider:
        CLOUD_STT_PROVIDERS.find((p) => p === saved["cloudProvider"]) ??
        DEFAULT_SETTINGS.cloudProvider,
      cloudModel:
        typeof saved["cloudModel"] === "string" && saved["cloudModel"] !== ""
          ? saved["cloudModel"]
          : null,
      recognizers: recognizersFrom(saved["recognizers"]),
      recognizeOnServers: saved["recognizeOnServers"] === true,
      gpuRecognition:
        saved["gpuRecognition"] === "on" || saved["gpuRecognition"] === "off"
          ? saved["gpuRecognition"]
          : "auto",
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
};

/** Longer than the spoken 15 s, for reading; a typed yes must still run out. */
const TYPED_CONFIRM_MS = 30_000;
const APP_CHECK_MS = 500;
/** A clean-up slower than this says where its time went. */
const SLOW_CLEANUP_MS = 400;
/** A second Esc within this discards a dictation. */
const ESC_AGAIN_MS = 2_000;
/** How long "Discarded · click to undo" stays. */
const UNDO_MS = 6_000;
/** Long enough to read one line once. */
const OFFER_MS = 6_000;
/** Jobs change slowly; a local read every so often once he has loaded them. */
const JOBS_REFRESH_MS = 15_000;
const ATTENTION_MS = 5 * 60_000;
const AWARENESS_SAMPLE_MS = 30_000;
const INITIATIVE_MS = 2 * 60_000;
const COMMIT_SYNC_MS = 60_000;
const COMMIT_SYNC_SOON_MS = 3_000;
const NOW_REFRESH_MS = 5 * 60_000;
/** The first minute after launch belongs to the speech models: work that can wait starts after it. */
const QUIET_START_MS = 60_000;
const CI_REFRESH_MS = 10 * 60_000;
/** Changes this close together make one tray and window update. */
const RENDER_COALESCE_MS = 40;

/**
 * A value that costs file reads, kept for a few seconds: the window asks for its rows on every update, and
 * the folders do not change that fast. `reset` after anything that does change them.
 */
const cachedFor = <T>(ms: number, make: () => T) => {
  let at = -Infinity;
  let value: T;
  const get = (): T => {
    const now = Date.now();
    if (now - at > ms) {
      value = make();
      at = now;
    }
    return value;
  };
  return Object.assign(get, { reset: () => void (at = -Infinity) });
};
/** The choices for how long it listens. Eight seconds and 30 s are the defaults; the wait covers only the start of speech. */
export const LISTEN_AFTER_WAKE_MS: ReadonlyArray<number> = [4_000, 6_000, 8_000, 12_000];
export const CONVERSATION_MS: ReadonlyArray<number> = [15_000, 30_000, 60_000, 120_000];
const MIC_TEST_MS = 4_000;
const PILL_TEXT_CHARS = 90;

/**
 * The tray mark: the logo's hinted cut for the taskbar's own theme (white on dark, black on light), at
 * every size Windows may ask for (100, 125, 150, 200, 250 and 300 %), with the state as a dot.
 */
const trayIconCache = new Map<string, Electron.NativeImage>();
const trayIcon = (options: MarkOptions): Electron.NativeImage => {
  const dark = Electron.nativeTheme.shouldUseDarkColorsForSystemIntegratedUI;
  // Six PNGs decoded and drawn on per call: the same few states come round again and again.
  const key = `${dark}|${JSON.stringify(options)}`;
  const known = trayIconCache.get(key);
  if (known !== undefined) return known;
  const image = Electron.nativeImage.createEmpty();
  for (const size of TRAY_SIZES) {
    const source = Electron.nativeImage.createFromBuffer(
      Buffer.from(TRAY_PNG[`${dark ? "white" : "black"}-${size}`]!, "base64"),
    );
    image.addRepresentation({
      scaleFactor: size / 16,
      width: size,
      height: size,
      buffer: withTrayState(source.toBitmap(), size, options, dark),
    });
  }
  if (trayIconCache.size > 32) trayIconCache.clear();
  trayIconCache.set(key, image);
  return image;
};

export interface VoiceCoreHooks {
  /** The core router's intent calls, answered by the Baton window and the paste adapter. */
  readonly intent: VoiceIntentClient;
  /** Replies and confirmation prompts, shown on the HUD's line. */
  readonly onReply: (text: string) => void;
  readonly settings: {
    readonly modelsDir: string | null;
    readonly wakeWords: ReadonlyArray<WakeWordSetting>;
  };
  /** Parakeet, in the dictation sidecar. */
  readonly stt: SttProvider;
  /** This computer's recogniser for the stop listener, never the cloud one. */
  readonly stopStt: SttProvider;
  /** Everything the core reports, for the cue after a wake word. */
  readonly onEvent: (event: VoiceCoreEvent) => void;
  /** "Add X to my dictionary": the reply to speak, or null when the words were something else. */
  readonly vocabulary: (text: string) => Promise<string | null>;
  /** How long he must be quiet for a turn to be over, read each turn. */
  readonly waitMs: () => number;
  /** How long the command window and the conversation stay open. */
  readonly listening: () => { readonly commandWindowMs: number; readonly conversationMs: number };
  /** The second check before a wake: true heard the name, false did not, null did not check (off, or failed). */
  readonly verifyWake: (
    pcm: Int16Array,
    word: string | null,
    score: number,
  ) => Promise<boolean | null>;
  /** The model is sure of this word past any doubt (see `wakeTrusted`). */
  readonly trustWake: (word: string, score: number) => boolean;
  /** A key dictation is recording or being written out: a wake with nothing after it must not end that. */
  readonly recording: () => boolean;
  /** Hears him over Baton's own voice through the speakers (docs/baton/BARGE_IN.md). */
  readonly echo: EchoGuard | undefined;
  readonly speakerMode: () => "speakers" | "headphones";
  /** Voice ID: whose voice each turn and cut-in is. */
  readonly speaker: SpeakerIdentityService;
}

/** Linear resampling to the microphone's 16 kHz, for the echo guard's reference only. */
export const resampleTo16k = (pcm: Int16Array, rate: number): Int16Array => {
  if (rate === 16_000) return pcm;
  const out = new Int16Array(Math.floor((pcm.length * 16_000) / rate));
  for (let i = 0; i < out.length; i += 1) {
    const at = (i * rate) / 16_000;
    const k = Math.floor(at);
    const frac = at - k;
    out[i] = Math.round((pcm[k] ?? 0) * (1 - frac) + (pcm[k + 1] ?? pcm[k] ?? 0) * frac);
  }
  return out;
};

/** The assistant, as the voice side sees it: its tray entries (D84) and the one brain (D100). */
export interface TrayExtras extends BrainVoiceHook {
  /** A question about something that is not his words (a run's log): an ordinary turn, the text marked as not his. */
  readonly askAbout?: (text: string) => void;
  /** One run of his own standing job (KIRO-1), as an unattended turn his own turns stop. */
  readonly runStanding?: ScreenCompanion["runStanding"];
  /** The lead's nightly learning pass over the turns these Record rows trace. */
  readonly learnNightly?: (rows: ReadonlyArray<BatonRecordEntry>) => Promise<string>;
  /** The phone's words run as a typed ask; the reply comes back. "device" words are never his own. */
  readonly askFromPhone?: (
    text: string,
    source: "phone" | "device",
  ) => Promise<{ readonly spoken: string; readonly card: string }>;
  /** What it may tell its server about itself (desktopState.ts adds the voice side and versions). */
  readonly stateForServer?: () => Omit<DesktopStateInput, "voice" | "appVersion" | "environments">;
  readonly setPhoneMirror?: (mirror: PhoneMirror | null) => void;
  readonly menuItems: () => ReadonlyArray<Electron.MenuItemConstructorOptions>;
  readonly controls: () => ReadonlyArray<HomeControl>;
  readonly setAskHotkey: (accelerator: string | null) => void;
  readonly signIn: () => Promise<BrainStatus>;
  readonly applySetting: (id: string, value: string | boolean | null) => void;
  readonly setActions: (actions: AssistantActions) => void;
  readonly notice: (text: string) => void;
  /** An unprompted line: a card, and aloud when `speak` and spoken answers are on. */
  readonly announce: (text: string, speak: boolean, spoken?: string) => void;
  /** Registers or drops the Transforms shortcuts. */
  readonly setTransformHotkeys?: (on: boolean) => void;
  readonly writtenOnly: () => boolean;
  readonly askMirrored?: (
    input: {
      readonly title: string;
      readonly detail: string;
      readonly buttons: ReadonlyArray<string>;
      readonly cancel: number;
      readonly expiresMs?: number;
      readonly armMs?: number;
    },
    needs?: "cloud-approve",
  ) => Promise<number>;
  readonly ask: (input: {
    readonly title: string;
    readonly detail: string;
    readonly buttons: ReadonlyArray<string>;
    readonly cancel: number;
    readonly expiresMs?: number;
    /** Unasked: its Yes stays disabled this long, so a keystroke meant for something else cannot answer. */
    readonly armMs?: number;
  }) => Promise<number>;
}

export interface DesktopBatonVoiceInput {
  readonly stateDir: string;
  /** The one conversation (D142), shared with the screen side. */
  readonly conversation?: ConversationLog;
  /** Every reply and refusal worth the turn log. */
  readonly onNote?: (kind: string, fields: Readonly<Record<string, unknown>>) => void;
  /** Where the turn log and the lifecycle log are, for Home and Checks. */
  readonly logDir: string;
  readonly appVersion: string;
  readonly env: NodeJS.ProcessEnv;
  /** `HostProcessPlatform`, injected rather than read here. */
  readonly platform: string;
  /** The main window, created if needed — where session and intent words go. */
  readonly ensureMainWindow: () => Promise<Electron.BrowserWindow>;
  /** Whether T3's main window exists now, without opening it. */
  readonly mainWindowUp?: () => Promise<boolean>;
  /** One Tessaya method on this machine's own server, for when T3's window is closed. */
  readonly direct?: (method: string, input: unknown, timeoutMs?: number) => Promise<unknown>;
  /** His private memory stores on this machine's server, for the Memory tab. */
  readonly privateMemory?: PrivateMemory;
  /** The voice core (`@t3tools/baton-voice`); null leaves the tray saying so. */
  readonly makeCore: ((hooks: VoiceCoreHooks) => Promise<BatonVoiceCore>) | null;
  /** The voice match model in the voice model worker (VOICE-ID); absent, Voice ID cannot run here. */
  readonly speakerModel?: (path: string, model: string) => Promise<HostedScorer<SpeakerEmbedder>>;
  /** His environment, for the `claude` that cleans text up. */
  /** `tessaya-voice`; null only in a build that left it out. */
  readonly dictationBinary: string | null;
  /** A wake word cut across Baton's voice. */
  readonly onBargeIn?: () => void;
  /** Lower Tessaya's voice while someone may be talking over it; false brings it back. */
  readonly onDuck?: (on: boolean) => void;
  readonly extras?: TrayExtras;
  /** The Sessions area's rows and actions (D138). */
  readonly sessions?: SessionsBridge;
  /**
   * Dictation's cleanup through his own Anthropic key, kept by this machine's server: null with no key saved; it throws
   * with the reason (invalid-key, rate-limit, timeout, unreachable) when the call fails.
   */
  readonly cleanupApi?: (
    system: string,
    message: string,
    maxTokens: number,
  ) => Promise<string | null>;
  /** Every session on every environment, running or stopped, with Resume and New session. */
  readonly catalog?: ReturnType<typeof import("../sessions/catalogRows.ts").createCatalog>;
  /** Baton's self-update (D137): its rows, its action, and whether one is waiting. */
  readonly updates?: BatonUpdates;
  /** Where the wake and listening models are, for the Check area. */
  readonly voiceAssets?: (modelsDir: string | null) => VoiceAssets;
  readonly holdEscape: (onPress: () => void, rank?: EscapeRank) => () => void;
  /** The one Stop (the companion's `stop`): `quiet` for Esc, a click or "never mind", which say nothing. */
  readonly onStop?: (quiet: boolean) => void;
  /** Plays one fixed line in a voice (null: the chosen one), for the Voice page's Play. */
  readonly audition?: (voice: string | null) => void;
  /** Bring the main window up, however it was left. */
  readonly openMainWindow: () => void;
  /** Wake-to-pill, for the record. */
  readonly onWakeShown?: (ms: number) => void;
  /** Start the assistant's sessions, so the first turn after launch does not wait for them. */
  readonly warmAssistant?: () => void;
  /** Each change of what the pill says, and "idle" when it goes: for the turn log. */
  readonly onPillState?: (phase: string) => void;
  /** How a pill drag ended, for the turn log. */
  /** BATON_TEST_WAV is set: the start of the recording, each file as it begins, and its end, for the turn log. */
  /** The Run entry name the installer writes: the app's AppUserModelId. */
  readonly loginEntry: string;
  readonly onTestAudio?: (event: TestAudioEvent) => void;
  readonly onPillDrag?: (outcome: {
    readonly reason: string;
    readonly dx: number;
    readonly dy: number;
    readonly ms: number;
  }) => void;
}

export interface DesktopBatonVoice {
  /** Rebuild the tray menu, after the companion's state changed. */
  readonly refresh: () => void;
  /** In the middle of a turn: speaking, or listening past the wake word. */
  readonly busy: () => boolean;
  /** Bring Baton's own window up. */
  readonly openHome: () => void;
  /** Baton's voice started or stopped. */
  readonly onSpeaking: (active: boolean) => void;
  /** A sentence going to the speakers. */
  readonly onSpoken: (text: string) => void;
  /** His own pronunciations, for the voice. */
  readonly respellings: () => Readonly<Record<string, string>>;
  /** A sentence starting to play, for where he cut in. */
  readonly onPlaying: (text: string) => void;
  /** The assistant finished a turn. */
  readonly onTurnEnd: () => void;
  /** The assistant is looking, planning or driving; null when it stops. */
  readonly onActivity: (label: string | null, caption?: string) => void;
  /** A lesson or drive sound, through the pill's own cue path. */
  readonly cue: (name: "start" | "stepDone" | "waiting" | "error" | "finished") => void;
  /** How loud Baton's voice is right now, for the pill. */
  readonly onSpeechLevel: (level: number) => void;
  /** What the player is about to play (16-bit mono at `rate`) and when it will sound. */
  readonly onReference: (pcm: Int16Array, rate: number, soundsAtMs: number) => void;
  /** He dismissed the assistant's output. */
  readonly onDismissed: () => void;
  /** A line for the tray: a voice downloading, or why it could not. */
  readonly onNote: (message: string | null) => void;
}

const wordName = (word: string | null): string | null =>
  word === null ? null : `${word[0]!.toUpperCase()}${word.slice(1)}`;

/** Recognition slower than this, and slower than the clip itself, logs the machine's load. */
/** After the voice has started, so the sessions' start does not compete with it. */
/** A microphone list or open that has not answered in this long has hung. */
const DEVICE_ANSWER_MS = 20_000;
const LAUNCH_WARM_MS = 5_000;
const SLOW_RECOGNITION_MS = 2_000;
const CPU_SAMPLE_MS = 3_000;
/** A minute of readings: enough to find one from before the slowest recognition. */
const CPU_READINGS_KEPT = 20;

export const startDesktopBatonVoice = (input: DesktopBatonVoiceInput): DesktopBatonVoice => {
  // Legacy name (D71): existing settings live in this file, so it keeps "fabric".
  const settingsPath = NodePath.join(input.stateDir, "fabric-voice.json");
  /** Written once on a fresh install; the guide is shown while it exists and is not marked done. */
  const setupMarker = NodePath.join(input.stateDir, "baton-setup.pending");
  let settings = readSettings(settingsPath);
  const tourMemory = () => ({
    freshInstall: NodeFS.existsSync(setupMarker),
    ...(settings.setupDone === undefined ? {} : { done: settings.setupDone }),
    ...(settings.setupOffered === undefined ? {} : { offered: settings.setupOffered }),
    ...(settings.setupStep === undefined ? {} : { step: settings.setupStep }),
  });
  setHideFromCapture(settings.hideFromCapture);
  /** The window is told again whenever settings change, so Home never keeps the list it was first built from. */
  const pushHome = () => {
    try {
      home.refresh();
    } catch {
      // The window is not built yet; it reads the settings when it is.
    }
  };
  /** The pill, its cards and prompts follow the design, waveform and palette (pillTheme.ts). */
  const syncPillLook = () =>
    setPillSettings({
      design: settings.pillDesign,
      wave: settings.pillWaveform,
      palette: settings.palette,
    });
  syncPillLook();
  const save = (next: Partial<VoiceSettings>) => {
    settings = { ...settings, ...next };
    writeJsonFile(settingsPath, settings);
    syncPillLook();
    pushHome();
  };
  const freshInstall =
    NodeFS.existsSync(setupMarker) ||
    !NodeFS.existsSync(NodePath.join(input.stateDir, "baton-home.shown"));
  const pickForMachine = () => {
    const weak = weakMachine({
      freshInstall,
      cpus: NodeOS.availableParallelism(),
      memoryBytes: NodeOS.totalmem(),
      slowStarts: settings.slowStarts ?? 0,
    });
    if (!machinePicksFast(settings, weak)) return false;
    save({ speechModel: "fast", speechModelPicked: "machine" });
    input.onNote?.("speech_model_auto", { model: "fast", reason: weak });
    return true;
  };
  pickForMachine();

  const tray = new Electron.Tray(
    trayIcon({
      color: hudView("sleeping").color,
      caps: [settings.enabled, false, false],
      muted: false,
    }),
  );
  const loginItem = createLoginItemState(Electron.app, input.loginEntry);
  // Renamed from Baton: drop the old login entry, and write the one he asked for for the new exe.
  if (input.platform === "win32") {
    Electron.app.setLoginItemSettings({ openAtLogin: false, name: "Baton" });
  }
  // The switch follows the real entry (the installer writes it too); an entry from an older exe is rewritten.
  void loginItem.refresh().then((on) => {
    if (on && input.platform === "win32") setLoginItem(Electron.app, input.loginEntry, true);
    render();
  });
  // Only now is there something to quit from, and a way back to a window.
  keepRunningForTray();
  // A left click is what an icon invites, and without this it did nothing on Windows.
  tray.on("click", () => home.open());
  const modelsDir = NodePath.join(input.stateDir, "voice", "models");
  const voiceId = createVoiceId({
    stateDir: input.stateDir,
    ownerName: () => "You",
    settings: () => settings.voiceId,
    ensureModel: () => ensureModel({ dir: modelsDir, model: SPEAKER_MODEL, onProgress: () => {} }),
    openModel: async (path) => {
      if (input.speakerModel === undefined) throw new Error("No voice model worker here.");
      return input.speakerModel(path, SPEAKER_MODEL.id);
    },
    model: SPEAKER_MODEL.id,
    appData: input.env["APPDATA"],
    onChange: () => pushHome(),
    ...(input.onNote === undefined ? {} : { onNote: input.onNote }),
    // Deleting a person deletes their private store with them.
    ...(input.privateMemory === undefined
      ? {}
      : { onPersonDeleted: (id: string) => void input.privateMemory?.onPersonDeleted(id) }),
  });
  voiceId.sync();
  /** Who is speaking, for the core, the approval path and the memory stores (one identity for all). */
  const speakerIdentity = createSpeakerIdentity({
    voiceId,
    settings: () => settings.voiceId,
    policy: { ...CAMPLUS_POLICY, model: SPEAKER_MODEL.id },
    now: Date.now,
    ...(input.onNote === undefined ? {} : { onNote: input.onNote }),
  });
  const binary = input.dictationBinary;
  let sidecar: DictationSidecar | null = null;
  let parakeetPath: string | null = null;
  let modelJob: Promise<string> | null = null;
  let sidecarDevices: ReadonlyArray<SidecarDevice> = [];
  let releaseRecordingEscape: (() => void) | null = null;
  /** The running helper recording was started by a mouse button held down: only its release ends it. */
  let heldByButton = false;
  /** The sidecar is recording or writing out a key dictation (`busyAfter`). */
  let sidecarBusy = false;
  let lastDictation: string | null = null;
  /** Paste-last's words: the last real dictation, never a command, a discard or a secret (`lastLanded`). */
  const lastInserted = createLastLanded();
  const landed = (text: string) => {
    if (lastInserted.landed(text)) lastDictation = text;
  };
  /** Every paste of his words, one at a time in the order he spoke: the hold key's and the buffered flush's. */
  const pasteInOrder = createInOrder();
  /** The pill's bars follow his speech, not full scale. */
  const pillGain = createSpeechGain();
  /** What Baton last answered, so Copy last transcript can take it; cleared by his next words. */
  let lastReply: string | null = null;
  let spokenTurnId: string | null = null;
  let focusedApp: FocusedApp = { exe: "", title: "" };
  /** Names on screen as this recording started, read while he speaks, for the clean-up to spell names by. */
  let screenNow: ReadonlyArray<string> = [];
  let dictionary: ReadonlyArray<VocabularyEntry> = [];
  let seenWords: SeenWords = {};
  const seenPath = NodePath.join(input.stateDir, "voice", "vocabulary-seen.json");
  try {
    seenWords = createJsonStore(seenPath, {}, isRecord).read() as SeenWords;
  } catch {}
  const changeVocabulary = async (
    change: (
      entries: ReadonlyArray<VocabularyEntry>,
      now: string,
    ) => ReadonlyArray<VocabularyEntry>,
  ) => {
    // Re-read for his hand edits, synchronously so no other write lands in between.
    dictionary = change(readDictionary(input.stateDir, dictionary), new Date().toISOString());
    saveDictionary(input.stateDir, dictionary);
  };
  const saveSeen = () => {
    try {
      writeJsonFile(seenPath, seenWords);
    } catch {}
  };
  // Words he deleted or discarded never come back by themselves.
  const neverPath = NodePath.join(input.stateDir, "voice", "vocabulary-never.json");
  let never: NeverList = [];
  try {
    never = parseNever(createJsonStore<unknown>(neverPath, [], Array.isArray).read());
  } catch {}
  const rememberNever = (words: ReadonlyArray<string>) => {
    never = words.reduce(addNever, never);
    try {
      writeJsonFile(neverPath, never);
    } catch {}
  };
  const toast = createVocabToast({
    anchor: () => pill.anchor(),
    holdEscape: input.holdEscape,
    frosted: () => settings.frosted && acrylicSupported(input.platform, NodeOS.release()),
    onDiscard: (all) => {
      // "heard → meant" undoes one taught form; any other is a whole word.
      const taught = all.flatMap((w) => {
        const [heard, meant] = w.split(TAUGHT);
        return heard !== undefined && meant !== undefined ? [{ heard, meant }] : [];
      });
      const words = all.filter((w) => !w.includes(TAUGHT));
      rememberNever([...words, ...taught.map((t) => t.heard)]);
      void changeVocabulary((entries) =>
        words.reduce(
          (all, word) =>
            all.filter(
              (e) =>
                e.phrase.toLowerCase() !== word.toLowerCase() &&
                (e.replacement ?? "").toLowerCase() !== word.toLowerCase(),
            ),
          taught.reduce(unteach, entries),
        ),
      );
    },
  });
  const announce = (added: ReadonlyArray<VocabularyEntry>) => {
    for (const entry of added) toast.add(entry.replacement ?? entry.phrase);
  };
  /** Names and terms he keeps using join the vocabulary once they repeat. */
  const learnWording = (text: string) => {
    if (!settings.learnWords) return;
    void changeVocabulary((entries, now) => {
      const next = observeWording(
        seenWords,
        entries,
        text,
        now,
        settings.wakeWords.map((w) => w.word),
        never,
      );
      seenWords = next.seen;
      saveSeen();
      announce(next.added);
      return next.entries;
    }).catch(() => undefined);
  };
  /** Ends the watch of the last paste's field: a newer dictation's words are not that paste's. */
  let stopWatching = () => {};
  /**
   * For a minute after the paste, what he changes in the field teaches the words he meant, the moment it settles. Only
   * through the sidecar, which never reads a password or secret field, never in a private app, never once focus has
   * left that window, and never when either side looks like a secret.
   */
  const learnFromEdits = (written: string, turnId: string | null, app: FocusedApp) => {
    stopWatching();
    if (!settings.learnWords || cleanupLevelFor("claude", app) !== "claude") return;
    if (written.trim().length === 0 || detectSecret(written) !== null) return;
    let watching = true;
    stopWatching = () => void (watching = false);
    const within = <A>(work: Promise<A>) =>
      Promise.race([
        work.catch(() => null),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), LEARN_CARET_MS)),
      ]);
    void watchField({
      reads: WATCH_MS / WATCH_EVERY_MS,
      wait: () =>
        new Promise<boolean>((resolve) =>
          setTimeout(() => resolve(watching), WATCH_EVERY_MS).unref(),
        ),
      stillThere: async () => {
        const now = sidecar === null ? null : await within(sidecar.foreground());
        if (now === null || cleanupLevelFor("claude", now) !== "claude") return false;
        // A paste whose window and app are both unknown is never watched: any field could be in front.
        return app.window !== undefined
          ? now.window === app.window
          : app.exe !== "" && now.exe === app.exe;
      },
      // A read that times out comes back null, which ends the watch.
      read: async () => {
        const around = sidecar === null ? null : await within(sidecar.caret());
        return around === null || detectSecret(around.before) !== null ? null : around.before;
      },
      ours: (before) => stillOurs(written, before),
      learn: (before) => {
        const { fixes, fixed } = correctionsAtCaret(written.trim(), before);
        if (fixes.length === 0) return false;
        if (turnId !== null) history?.update(turnId, { corrected: true, fixed });
        void teachFixes(fixes);
        return true;
      },
    }).finally(() => {
      watching = false;
    });
  };
  /** Each fix teaches the word he meant, announced as "Learned X" so he can undo it. */
  const teachFixes = (fixes: ReadonlyArray<{ readonly heard: string; readonly meant: string }>) =>
    changeVocabulary((entries, now) =>
      fixes.reduce((all, fix) => {
        const next = learnCorrection(seenWords, all, fix, now, never);
        seenWords = next.seen;
        announce(next.added);
        for (const t of next.taught ?? []) toast.add(`${t.heard}${TAUGHT}${t.meant}`);
        return next.entries;
      }, entries),
    )
      .then(saveSeen)
      .catch(() => undefined);
  /** History's Edit and teach: his fixed words become the row's, and teach under the same rules as a fix in the field. */
  const teachFromHistory = (turn: HistoryTurn, text: string): ReadonlyArray<string> => {
    const meant = text.trim();
    if (history === null || turn.hidden !== null || meant === "") return [];
    const fixes = correctionsBetween(rowText(turn), meant);
    history.update(turn.id, { fixed: meant, corrected: true });
    if (!mayTeach(turn, meant, settings.learnWords)) return [];
    void teachFixes(fixes);
    return fixes.map((fix) => fix.meant);
  };
  let keptTimer: ReturnType<typeof setTimeout> | null = null;
  let recordFailures = 0;
  let audio: AudioInputProvider | null = null;
  let core: BatonVoiceCore | null = null;
  const clipboardInjection = makeClipboardInjection({
    platform: input.platform,
    clipboard: Electron.clipboard,
  });
  /** His past dictations most like the one being cleaned, as the model's examples; built once at start. */
  let styleIndex: ReturnType<typeof makeStyleIndex> | null = null;
  const rewriter = makeRewriter({
    claudeBinary: settings.claudeBinary,
    model: settings.cleanupModel,
    workDir: NodePath.join(input.stateDir, "voice", "cleanup"),
    env: input.env,
    platform: input.platform,
    dictionary: () => dictionary,
    keepWarm: () => cleanupStaysWarm(),
    ...(input.cleanupApi === undefined ? {} : { api: input.cleanupApi }),
    examples: (text, mode) => styleIndex?.nearest(text, mode, 4) ?? [],
  });
  /** Held to where the words came from and where he is now. Unknown counts as secret. */
  const levelNow = (spokenIn: { readonly exe: string; readonly title: string }) =>
    cleanupLevelNow(
      settings.dictationCleanup,
      spokenIn,
      () => sidecar?.foreground() ?? Promise.resolve(null),
      APP_CHECK_MS,
    );
  const snippets = createSnippetStore(input.stateDir);
  const transforms = createTransformStore(input.stateDir);
  const styles = createStyleStore(input.stateDir);
  const scratch = createScratchStore(input.stateDir);
  let scratchQuery = "";
  /** The next dictation becomes a note (the keyboard shortcut); cleared when it lands. */
  let noteNext = false;
  const setNoteHotkey = (on: boolean) => {
    Electron.globalShortcut.unregister(SCRATCH_HOTKEY);
    if (!on) return;
    Electron.globalShortcut.register(SCRATCH_HOTKEY, () => {
      noteNext = true;
      input.extras?.notice("The next thing you dictate goes to your Scratchpad.");
    });
  };
  setNoteHotkey(scratch.hotkeyOn());
  /** Worked out from History at most every half minute; Home redraws far more often. */
  let deepAt = 0;
  let deepKey = "";
  let deepValue: ReturnType<typeof computeDeepInsights> | null = null;
  let profileValue: ReturnType<typeof computeVoiceProfile> = null;
  /** Changes when History is written or his day turns over: nothing else changes what the counts say. */
  const historyKey = () => `${historyRev}|${new Date().toDateString()}`;
  const deepInsights = () => {
    if (history === null) return null;
    if (deepKey !== historyKey() && Date.now() - deepAt > 30_000) {
      deepKey = historyKey();
      const turns = history.list({ query: "", limit: 20_000 });
      deepValue = turns.some((t) => t.kind === "dictation")
        ? computeDeepInsights(turns, Date.now())
        : null;
      profileValue = computeVoiceProfile(turns);
      deepAt = Date.now();
    }
    return deepValue;
  };
  const askModel = createModelAsk({
    claudeBinary: () => settings.claudeBinary,
    model: () => settings.cleanupModel,
    workDir: NodePath.join(input.stateDir, "voice", "transform"),
    env: () => input.env,
    platform: input.platform,
    timeoutMs: 25_000,
  });
  const autoRewrite = async (t: Transform, text: string): Promise<string | null> => {
    if (refuseTransformInput(text) !== null) return null;
    const checked = checkTransformOutput(
      text,
      await askModel(transformSystemPrompt(t), transformMessage(text)),
    );
    return checked.ok ? checked.text : null;
  };
  let transformNote = "";
  /** Four questions, one per kind of writing, as the card with buttons; Skip leaves that one as it was. */
  const runStyleGuide = async (): Promise<void> => {
    for (const c of STYLE_CATEGORIES) {
      const q = guideQuestion(c);
      const index = await (input.extras?.ask({
        ...q,
        buttons: GUIDE_BUTTONS,
        cancel: GUIDE_BUTTONS.length - 1,
        expiresMs: 120_000,
      }) ?? Promise.resolve(GUIDE_BUTTONS.length - 1));
      const style = guideAnswer(index);
      if (style !== null) styles.set(c, style);
      render();
    }
  };
  input.extras?.setTransformHotkeys?.(transforms.read().enabled);
  /** Clean-up, then the spoken cues he saved expand (Snippets). */
  const writeClean = async (raw: string, app: { readonly exe: string; readonly title: string }) => {
    // Words that look like a secret are never put in a Claude prompt, whatever the level.
    const started = Date.now();
    const decided =
      detectSecret(raw) === null ? await levelNow(app) : { level: "local" as const, why: "secret" };
    const { level } = decided;
    const levelMs = Date.now() - started;
    // A model clean-up stepped down to this computer is never silent: the turn log says why.
    if (decided.why !== null && settings.dictationCleanup === "claude")
      input.onNote?.("dictation_cleanup_level", { level, why: decided.why });
    const out = await rewriter.clean({
      raw: raw,
      mode: chooseMode(app, settings.appModes),
      level,
      context: { screen: screenNow },
    });
    // Every fallback keeps its reason (a refused name, a timeout, the API's error), so a slow or failed clean-up can be
    // told apart from a right refusal (0.1.92 fell back after 2.95 s with no reason logged).
    if (out.stage === "fallback")
      input.onNote?.("dictation_cleanup", { fallback: out.why ?? "unknown" });
    // Which part of a slow clean-up took the time, so the next one names it (a local 1.5 s on 0.1.105 could not be).
    if (Date.now() - started > SLOW_CLEANUP_MS)
      input.onNote?.("dictation_cleanup_slow", {
        levelMs,
        cleanMs: Date.now() - started - levelMs,
        level,
        stage: out.stage,
      });
    const styled =
      chooseMode(app, settings.appModes) === "code" || chooseMode(app, settings.appModes) === "raw"
        ? out.text
        : applyStyle(out.text, styles.read()[categoryForApp(app)]);
    let text = expandSnippets(styled, snippets.list(), app.exe);
    // Transforms: one chosen rewrite after every dictation, if he asked. A failure inserts the cleaned text.
    const tcfg = transforms.read();
    const auto = tcfg.enabled ? transforms.all().find((t) => t.id === tcfg.autoApply) : undefined;
    if (auto !== undefined && cleanupLevelFor("claude", app) === "claude") {
      const rewritten = await autoRewrite(auto, text).catch(() => null);
      if (rewritten !== null) text = rewritten;
    }
    // The level decided here goes on its History row, so a retry never goes above it.
    return { ...out, text, level };
  };
  let snippetNote = "";
  /** What Baton last put in a field, where an app will not say what is around the caret. */
  let lastInsert: { text: string; at: number; key: string } | null = null;
  const windowKey = (app: { readonly exe: string; readonly title: string }) =>
    `${app.exe}\n${app.title}`;
  const CARET_LIMIT_MS = 1_500;
  /**
   * The words around the caret, read at key-down while he speaks: a first UI Automation read of a field can take 0.9 s,
   * which release would otherwise wait for (0.1.98). Used only for that window, and only if nothing was pasted since.
   */
  let caretEarly: {
    readonly key: string;
    readonly pastes: number;
    readonly read: Promise<CaretContext | null>;
  } | null = null;
  let pastes = 0;
  const readCaretEarly = (app: { readonly exe: string; readonly title: string }) => {
    caretEarly =
      sidecar === null
        ? null
        : { key: windowKey(app), pastes, read: sidecar.caret().catch(() => null) };
  };
  /** The text made to fit the words already there: spacing, capitals, punctuation. */
  const fitToCaret = async (
    text: string,
    app: { readonly exe: string; readonly title: string },
  ): Promise<string> => {
    const key = windowKey(app);
    const early = caretEarly?.key === key && caretEarly.pastes === pastes ? caretEarly.read : null;
    caretEarly = null;
    // The sidecar reads it in-process; PowerShell (300 ms or more to start) only without one.
    const around =
      (await (sidecar === null
        ? readCaretContext(input.platform)
        : Promise.race([
            early ?? sidecar.caret().catch(() => null),
            // A field that hangs UI Automation never holds the paste: past the old PowerShell limit it did not say.
            new Promise<null>((resolve) => setTimeout(() => resolve(null), CARET_LIMIT_MS)),
          ]))) ??
      contextFromLastInsert(
        lastInsert === null ? null : { ...lastInsert, sameWindow: lastInsert.key === key },
        Date.now(),
      );
    const mode = chooseMode(app, settings.appModes);
    // Code and raw mode take the words exactly as said: no stop and no space added; chat keeps his ending too.
    const plain = mode === "code" || mode === "raw";
    const closed = plain || mode === "chat" ? text : closeLastSentence(text, around?.after ?? null);
    const fitted =
      around !== null ? fitInsertion(around, closed) : plain ? closed : fitWithoutContext(closed);
    lastInsert = { text: fitted, at: Date.now(), key };
    pastes += 1;
    return fitted;
  };
  // Everything he says and what it became, kept forever on this machine (the History tab).
  let historyRev = 0;
  const flaggedDir = NodePath.join(input.stateDir, "reports", "flagged");
  const history = (() => {
    try {
      const opened = openHistory(
        NodePath.join(input.stateDir, "voice", "history.sqlite"),
        undefined,
        flaggedDir,
      );
      const bump =
        <A extends ReadonlyArray<unknown>, R>(write: (...args: A) => R) =>
        (...args: A): R => {
          historyRev += 1;
          return write(...args);
        };
      return {
        ...opened,
        add: bump(opened.add),
        update: bump(opened.update),
        remove: bump(opened.remove),
        hide: bump(opened.hide),
      };
    } catch {
      return null;
    }
  })();
  let insightsKey = "";
  let insightsValue = computeInsights([], new Date());
  /** Home redraws many times a second while busy; the 20,000-row read runs only when History changed. */
  const insights = () => {
    if (insightsKey !== historyKey()) {
      insightsKey = historyKey();
      insightsValue = computeInsights(history?.list({ limit: 20_000 }) ?? [], new Date());
    }
    return insightsValue;
  };
  let toolNames: ReadonlyArray<string> | null = null;
  const audioDir = NodePath.join(input.stateDir, "voice", "recordings");
  // A proof run's recorded files are not his words: they leave nothing in History or in the recordings.
  const testRun = (process.env["BATON_TEST_WAV"] ?? "") !== "";
  const keepSettings = (): KeepSettings => ({
    enabled: settings.keepVoice,
    days: settings.keepDays,
    capBytes: settings.keepCapGb * 1024 ** 3,
    minFreeBytes: 5 * 1024 ** 3,
  });
  const encoder = makeOpusEncoder();
  let keepNote: string | null = null;
  /** Saves a clip for a turn, in the background, if he asked for it and the drive has room. */
  const keepAudio = (turnId: string | null, pcm: Int16Array | null) => {
    if (history === null || testRun || turnId === null || pcm === null || pcm.length === 0) return;
    // A row redacted for a secret keeps no recording of it (the store also drops one kept before it was marked).
    if (history.get(turnId)?.raw === REDACTED) return;
    const gate = saveGate(keepSettings(), freeBytesOf(input.stateDir));
    keepNote = gate.ok ? null : settings.keepVoice ? gate.reason : null;
    if (!gate.ok) return;
    void encoder
      .encode(pcm)
      .then((bytes) => {
        // A secret can be found while the clip encodes (a later chunk, the cleaned words): then none is kept.
        if (history.get(turnId)?.raw === REDACTED) return;
        const saved = saveClip({
          dir: audioDir,
          id: `${turnId}-${Date.now().toString(36)}`,
          bytes,
          at: new Date(),
          keep: keepSettings(),
          freeBytes: freeBytesOf(input.stateDir),
        });
        if (saved.path === null) return;
        const turn = history.get(turnId);
        if (turn?.raw === REDACTED) return void NodeFS.rmSync(saved.path, { force: true });
        history.update(turnId, {
          audio: [
            ...(turn?.audio === null || turn === null ? [] : clipPaths(turn.audio)),
            saved.path,
          ].join("\n"),
        });
      })
      .catch(() => undefined);
  };
  let lastPcm: Int16Array | null = null;
  const _tidyStatus = (stage: string | undefined, failed: boolean): TidyStatus =>
    failed ? "raw" : stage === "model" || stage === "local" ? "ok" : "raw";
  /** A secret in his words: the vault is offered them as written, not as heard. Null when there is none. */
  const offerVault = (raw: string, cleaned: string | null) => {
    const safe = redactForHistory(raw, cleaned);
    if (safe.secret === null) return null;
    pendingSecret.set(cleaned ?? raw, Date.now());
    input.extras?.notice(
      `That looked like ${safe.secret}, so I kept it out of History. Say "put that in the vault" to keep it safely.`,
    );
    return safe;
  };
  /** Said into a password box or a private app (the apps whose edits are never learned from): no words, no recording. */
  const hideIfPrivate = (
    id: string | null,
    app: { readonly exe: string; readonly title: string },
    passwordBox: boolean,
  ) => {
    const reason = privateReason(app, passwordBox);
    if (reason !== null && id !== null) history?.hide(id, reason);
    return reason;
  };
  const record = (turn: {
    readonly kind: "dictation" | "spoken";
    readonly app: string;
    readonly raw: string;
    readonly cleaned: string | null;
    readonly status: TidyStatus;
    readonly model?: string | null;
    readonly delivery: string | null;
    readonly error?: string | null;
    readonly seconds?: number | null;
    readonly cleanup?: "local" | "claude" | null;
    readonly hidden?: HiddenReason | null;
  }): string | null => {
    if (history === null || testRun || turn.raw.trim().length === 0) return null;
    // A dictated password is not kept in plain text (VAULT.md section 6): History gets a mark, the vault gets an offer.
    const safe = offerVault(turn.raw, turn.cleaned);
    if (safe !== null) turn = { ...turn, raw: safe.raw, cleaned: safe.cleaned };
    try {
      return history.add({
        at: new Date().toISOString(),
        kind: turn.kind,
        app: turn.app,
        raw: turn.raw,
        cleaned: turn.cleaned,
        status: turn.status,
        model: turn.model ?? null,
        delivery: turn.delivery,
        error: turn.error ?? null,
        seconds: turn.seconds ?? null,
        cleanup: turn.cleanup ?? null,
        hidden: turn.hidden ?? null,
      });
    } catch {
      return null;
    }
  };
  const retention = () => {
    if (history !== null) runRetention({ history, now: Date.now(), keep: keepSettings() });
  };
  setTimeout(retention, 2 * QUIET_START_MS).unref();
  setInterval(retention, 24 * 3_600_000).unref();
  let retrying: string | null = null;
  /** A row's kept clips, decoded and joined. */
  const joinedPcm = async (turn: HistoryTurn) => {
    const parts: Int16Array[] = [];
    for (const path of clipPaths(turn.audio ?? "")) {
      parts.push(await encoder.decode(NodeFS.readFileSync(path)));
    }
    const pcm = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
      pcm.set(p, at);
      at += p.length;
    }
    return pcm;
  };
  /** Flagged rows are written where the clean-up eval's new cases are picked from; unflagging takes it back. */
  const flagTurn = (turn: HistoryTurn, on: boolean) => {
    history?.flag(turn.id, on);
    if (!on) return;
    const file = flaggedReport(flaggedDir, turn.id);
    NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
    NodeFS.writeFileSync(
      file,
      buildTranscriptReport(turn, { version: input.appVersion, platform: input.platform }),
      { mode: 0o600 },
    );
  };
  /** Home steps aside so the window he was in before comes forward, then the words go in with the dictation paste's checks. */
  const pasteAgain = async (text: string, app: string, home: Electron.BrowserWindow | null) => {
    const side = sidecar;
    if (side === null || text === "") return { failed: "Pasting is not available right now" };
    home?.minimize();
    await new Promise((resolve) => setTimeout(resolve, PASTE_AGAIN_MS));
    const why = await pasteInOrder(async () => {
      const now = await side.foreground().catch(() => null);
      if (now?.window === undefined) return "gone" as const;
      if (!mayPasteInto(app, now.exe)) return "elsewhere" as const;
      return await side.pasteChecked(text, now.window, now.title).catch(() => "refused" as const);
    });
    if (why === "ok") return { pasted: true };
    Electron.clipboard.writeText(text);
    return {
      failed:
        why === "secret"
          ? "That box is for a password, so the words are on your clipboard"
          : why === "elsewhere"
            ? `${app === "" ? "Its app" : app} is not in front, so the words are on your clipboard`
            : "Not pasted, so the words are on your clipboard",
    };
  };
  const extractAudio = async (turn: HistoryTurn, home: Electron.BrowserWindow | null) => {
    if (!hasRecording(turn)) return { failed: NO_RECORDING };
    const options = {
      title: "Save the recording",
      defaultPath: `tessaya-${turn.at.slice(0, 19).replace(/[T:]/g, "-")}.wav`,
      filters: [{ name: "WAV audio", extensions: ["wav"] }],
    };
    const chosen = await (home === null
      ? Electron.dialog.showSaveDialog(options)
      : Electron.dialog.showSaveDialog(home, options));
    if (chosen.canceled || chosen.filePath === undefined) return null;
    try {
      NodeFS.writeFileSync(chosen.filePath, encodeWav(await joinedPcm(turn)));
      return { saved: chosen.filePath };
    } catch {
      return { failed: "That recording could not be saved" };
    }
  };
  const withMenu = (turn: HistoryTurn) => ({ ...turn, menu: rowMenu(turn, retrying !== null) });
  // shortcut: commands and actions come from the turn log's last 96 KB, so older ones drop out of History first.
  const listHistory = (query: string) =>
    mergeFeed(
      (history?.list({ query, limit: 300 }) ?? []).map(withMenu),
      parseLogEntries(tailOf(NodePath.join(input.logDir, "voice-turns.ndjson"))).map((entry) => ({
        ...entry,
        menu: [],
      })),
      query,
    );
  Electron.ipcMain.handle("baton-history:list", (event, query: unknown) =>
    Electron.BrowserWindow.fromWebContents(event.sender) === null
      ? []
      : listHistory(typeof query === "string" ? query : ""),
  );
  Electron.ipcMain.handle("baton-history:delete-many", (event, ids: unknown) => {
    if (Electron.BrowserWindow.fromWebContents(event.sender) === null || history === null) return 0;
    if (!Array.isArray(ids)) return 0;
    let removed = 0;
    for (const id of ids) {
      if (typeof id === "string" && history.remove(id) !== null) removed += 1;
    }
    return removed;
  });
  Electron.ipcMain.handle("baton-history:act", async (event, id: unknown, action: unknown) => {
    if (Electron.BrowserWindow.fromWebContents(event.sender) === null || history === null)
      return null;
    if (typeof id !== "string" || typeof action !== "string") return null;
    const turn = history.get(id);
    if (turn === null) return null;
    if (action === "copy_raw") void Electron.clipboard.writeText(turn.raw);
    else if (action === "undo_ai") {
      // The heard words become the row's words (the written ones stay as a version) and go on the clipboard.
      history.update(id, undoAiEdit(turn, new Date().toISOString()));
      void Electron.clipboard.writeText(turn.raw);
    } else if (action === "copy" || action === "copy_cleaned") {
      void Electron.clipboard.writeText(rowText(turn));
    } else if (action === "paste") {
      return pasteAgain(
        rowText(turn),
        turn.app,
        Electron.BrowserWindow.fromWebContents(event.sender),
      );
    } else if (action.startsWith("teach:")) {
      const taught = teachFromHistory(turn, action.slice("teach:".length));
      const after = history.get(id);
      return after === null ? null : { ...withMenu(after), taught };
    } else if (action === "extract") {
      return extractAudio(turn, Electron.BrowserWindow.fromWebContents(event.sender));
    } else if (action === "flag" || action === "unflag") {
      flagTurn(turn, action === "flag");
    } else if (action.startsWith("copy_version:")) {
      const v = useVersion(turn, Number(action.slice("copy_version:".length)));
      if (v !== null) void Electron.clipboard.writeText(v.cleaned ?? v.raw);
    } else if (action.startsWith("use_version:")) {
      const v = useVersion(turn, Number(action.slice("use_version:".length)));
      if (v !== null) history.update(id, { raw: v.raw, cleaned: v.cleaned, model: v.model });
    } else if (action === "delete") {
      history.remove(id);
      return { deleted: true };
    } else if (action === "play") {
      // The kept clips, joined, as a WAV the page plays itself: nothing leaves this computer.
      if (!hasRecording(turn)) return { failed: NO_RECORDING };
      try {
        const pcm = await joinedPcm(turn);
        return {
          playback: `data:audio/wav;base64,${Buffer.from(encodeWav(pcm)).toString("base64")}`,
        };
      } catch {
        return { failed: "That recording could not be played" };
      }
    } else if (action === "retry_transcript") {
      // Not while he is dictating, and one at a time. The original stays as it was if this fails.
      if (retrying !== null || dictatingByVoice || releaseRecordingEscape !== null) {
        return { failed: "Not now: finish dictating first" };
      }
      if (retryPlan(turn).kind !== "transcript" || sidecar === null) {
        return { failed: retryPlan(turn).kind === "transcript" ? "Retry failed" : NO_RECORDING };
      }
      retrying = id;
      try {
        const pcm = await joinedPcm(turn);
        // A row kept at the local level, or from an app kept private, is heard again on this computer only.
        const level = retryCleanupLevel(settings.dictationCleanup, turn.app, turn.cleanup);
        const heard = (
          await makeSidecarStt(
            sidecar,
            undefined,
            undefined,
            level === "claude" ? recognise : undefined,
          ).transcribe(pcm)
        ).trim();
        if (heard === "") throw new Error("nothing recognised");
        let cleaned: string | null = null;
        let model: string | null = null;
        if (turn.kind === "dictation") {
          const tidy = await rewriter
            .clean({
              raw: heard,
              mode: chooseMode({ exe: turn.app, title: "" }, settings.appModes),
              level,
            })
            .catch(() => null);
          const settled = settleOneShot(heard, tidy);
          cleaned = settled.text;
          model = settled.failed ? null : settings.cleanupModel;
        }
        history.update(id, {
          versions: withRetry(turn, { at: new Date().toISOString(), raw: heard, cleaned, model }),
        });
      } catch {
        return { failed: "Retry failed" };
      } finally {
        retrying = null;
      }
    } else if (action === "retry") {
      // Re-runs the tidy-up on the stored words; nothing is inserted unless he copies it.
      const cleaned = await rewriter
        .clean({
          raw: turn.raw,
          mode: chooseMode({ exe: turn.app, title: "" }, settings.appModes),
          level: retryCleanupLevel(settings.dictationCleanup, turn.app, turn.cleanup),
        })
        .catch(() => null);
      const { text, failed } = settleOneShot(turn.raw, cleaned);
      history.update(id, {
        cleaned: text,
        status: failed ? "failed" : "ok",
        model: failed ? null : settings.cleanupModel,
        error: failed ? "Clean-up failed again" : null,
      });
    }
    const after = history.get(id);
    return after === null ? null : withMenu(after);
  });

  // Spoken dictation, all at once: the chunks wait here, on disk too, until one clean paste.
  const pendingFile = NodePath.join(input.stateDir, "voice", "dictation-pending.json");
  let collecting = false;
  /** The window and field he was in at the wake word: dictation and the turn's focus go there. */
  /** Esc is global while he dictates, so one stray press must not lose his words: the first asks, the second discards. */
  let escArmedUntil = 0;
  const dictationHold = createDictationHold<Promise<FocusedApp | null>>(input.holdEscape, () => {
    if (Date.now() < escArmedUntil) return endVoiceDictation(false);
    escArmedUntil = Date.now() + ESC_AGAIN_MS;
    pill.on({ type: "dictating", caption: "Press Esc again to discard" });
  });
  /** What ✕ or Esc threw away, for a few seconds: a click on the pill puts it back where it was going. */
  let undo: { readonly text: string; readonly target: Promise<FocusedApp | null> | null } | null =
    null;
  /** ✕ or Esc threw the words away: a chunk still being recognised is dropped too, not pasted. */
  let discarding = false;
  /** The window dictation types into, by name, for the pill. */
  let dictatingInto: string | null = null;
  /** A window as the assistant is told of it. */
  const asFocus = (app: FocusedApp | null | undefined): AssistantFocus | null => {
    if (app == null || app.exe.length === 0) return null;
    const rect = app.rect == null ? null : Electron.screen.screenToDipRect(null, app.rect);
    // Tessaya's sessions window is his workspace; only the pill, cards and Home are hers.
    const own = Electron.BrowserWindow.getAllWindows().find((w) => {
      const raw = w.getNativeWindowHandle();
      return (raw.length >= 8 ? Number(raw.readBigUInt64LE()) : raw.readUInt32LE()) === app.window;
    });
    const note =
      own === undefined
        ? ""
        : isCompanionWindow(own)
          ? " (Tessaya's own window, not one of his)"
          : " (his sessions window: his session panes and their message boxes)";
    const label = `${app.exe}: ${app.title}${note}`;
    return {
      label,
      ...(app.window === undefined ? {} : { window: app.window }),
      centre: rect === null ? null : { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
    };
  };
  const restored = ((): Array<string> => {
    try {
      return JSON.parse(NodeFS.readFileSync(pendingFile, "utf8")) as Array<string>;
    } catch {
      return [];
    }
  })();
  // Words a crash left behind are offered from the tray, never pasted with the next dictation.
  if (restored.length > 0) {
    landed(restored.join(" "));
    setTimeout(() => {
      note = "A dictation was not inserted. Tray: Copy last transcript.";
      render();
    }, 0);
  }
  // shortcut: one dictation timed at a time, a second ending before the first pastes takes over its line; key the timer
  // by turn id once overlapping dictations show up in dictation_timing.
  let dictationTimer: DictationTimer | null = null;
  const noteTiming = () => {
    const line = dictationTimer?.line(true);
    dictationTimer = null;
    if (line != null) input.onNote?.("dictation_timing", { ...line });
  };
  const ghost = createPillGhost({
    look: () => ({ motion: settings.motion, glass: settings.glass }),
    windows: input.platform === "win32",
  });
  /** The ghost showed this flush's words in his field, so the pill does not play the cleanup again. */
  let ghostPlayed = false;
  /** As a dictation starts: the words go at the caret when the field says where it is, else in the pill. */
  const startGhost = () => {
    ghost.stop();
    if (settings.pillStyle !== "field" || !settings.showWords || sidecar === null) return;
    void sidecar
      .caretAt()
      .catch(() => null)
      .then((at) => {
        if (!(keyRecording() || dictatingByVoice)) return;
        if (at === null) return input.onNote?.("ghost_start", { shown: false, why: "no caret" });
        // The boxes the field gave (no words): how its ghost was laid out, or why the pill shows them instead.
        const not = ghost.start(at);
        input.onNote?.("ghost_start", { ...at, shown: not === null, ...not });
      });
  };
  const dictationWords = (text: string) =>
    ghost.active() && !composer.active() ? ghost.words(text) : pill.words(text);
  /** The dictation whose ghost holds his typing keys until its paste lands (the sidecar's `hold_keys`); 0 for none. */
  let keyHold = 0;
  let keyHolds = 0;
  /** T3's composer microphone asked for Tessaya's dictation: its words go back to the composer, not through a paste. */
  let composerWaiter: ((text: string) => void) | null = null;
  const oneShotOptions: Parameters<typeof createOneShot<FocusedApp>>[0] = {
    // The paste never waits for the ghost (it held every paste ~2.8 s): its words go as the cleaned ones land.
    beforePaste: async (_raw, _text, app) => {
      ghostPlayed = ghost.active();
      // Enter pressed while the ghost is up must land after the words, so typing keys wait for this paste.
      if (ghostPlayed && app.window !== undefined && sidecar !== null) {
        keyHold = ++keyHolds;
        sidecar.holdKeys(keyHold, app.window);
      }
    },
    afterPaste: () => {
      if (keyHold !== 0) sidecar?.releaseKeys(keyHold);
      keyHold = 0;
      ghost.stop();
    },
    save: (chunks) => {
      try {
        NodeFS.mkdirSync(NodePath.dirname(pendingFile), { recursive: true });
        if (chunks.length === 0) NodeFS.rmSync(pendingFile, { force: true });
        else NodeFS.writeFileSync(pendingFile, JSON.stringify(chunks));
      } catch {}
    },
    // With no window of its own nothing is sent to clean it: the words go to the clipboard as heard.
    clean: (raw, app) =>
      app.window === undefined
        ? Promise.resolve(null)
        : writeClean(raw, app).then((c) => (dictationTimer?.cleaned(c.stage, c.speculated), c)),
    fit: (text, app) =>
      app.window === undefined
        ? Promise.resolve(text)
        : fitToCaret(text, app).then((t) => (dictationTimer?.fitted(), t)),
    paste: (text, app) =>
      composerWaiter !== null
        ? Promise.resolve((composerWaiter(text), true))
        : noteNext
          ? Promise.resolve(
              (() => {
                noteNext = false;
                try {
                  scratch.add(text);
                  input.extras?.notice("Saved to your Scratchpad.");
                  return true;
                } catch {
                  return false;
                }
              })(),
            )
          : sidecar === null || app.window === undefined
            ? // Never into whatever has the keyboard now: with no window of its own the words are kept.
              Promise.resolve(false)
            : ((side: NonNullable<typeof sidecar>, target: number, title: string) =>
                pasteInOrder(async () => {
                  // Tessaya's own window answers for itself: Windows sees its page as one document that takes text.
                  if ((await ownFieldFocused(target)) === false) {
                    keptWhy = "nofield";
                    input.onNote?.("paste_refused", {
                      why: "nofield",
                      own: true,
                      chars: text.length,
                    });
                    return false;
                  }
                  // One helper call: its window forward, the same window and page checked (his words were not for
                  // another), then the paste.
                  const why = await side
                    .pasteChecked(text, target, title, (late) => {
                      if (late !== "ok") return;
                      // It landed after all: its copy card would only invite a second paste.
                      toast.retract(text);
                      pill.on({ type: "done", label: "Pasted after all" });
                      input.onNote?.("paste_late", { chars: text.length });
                    })
                    .catch(() => "refused" as const);
                  if (why === "ok") return true;
                  keptWhy = why;
                  // Which check stopped it, never the words: a refusal that keeps happening shows in the turn log.
                  input.onNote?.("paste_refused", { why, chars: text.length });
                  return false;
                }))(sidecar, app.window, app.title),
  };
  /** Our own chat box took the dictation: it takes the words itself, no paste (composerDictation.ts). */
  const oneShot = createOneShot<FocusedApp>({
    ...oneShotOptions,
    paste: async (text, app) => {
      const ours = composer.active();
      const took = await composer.commit(text);
      // Which way the words went, for the turn log: the chat box took them, or they fell back to the paste.
      if (ours) input.onNote?.("composer_commit", { took, chars: text.length });
      return took ? (ghostPlayed = true) : oneShotOptions.paste(text, app);
    },
  });
  let openTurn: string | null = null;
  /** Why the last flush kept its words rather than pasting them. */
  let keptWhy: Exclude<PasteVerdict, "ok"> = "refused";
  /** The words go on the clipboard, out of the buffer, and a card beside the pill says why, with Copy. */
  const toClipboard = (text: string, taken: number, why: string, code: string) => {
    Electron.clipboard.writeText(text);
    oneShot.release(taken);
    landed(text);
    showDictation(null);
    toast.show({ kind: "copy", why: `${why}, so it is on your clipboard`, text });
    // The decision, never the words: "no field, showed copy card" and its like, in the turn log.
    input.onNote?.("copy_card", { why: code, chars: text.length });
  };
  /**
   * `target` is the window that dictation started in, read when it ended: never one a newer dictation started in.
   * Flushes run in turn inside `oneShot`, each with its own window. A key flush shows no preview card (`preview`).
   */
  const flushDictation = async (target: Promise<FocusedApp | null> | null) => {
    if (!dictatingByVoice) collecting = false;
    if (oneShot.pending().length === 0 || sidecar === null) return;
    // The window it was started in, never wherever the keyboard went since (LIVE-2240).
    const app = (await target) ?? { exe: "", title: "" };
    const turnId = openTurn;
    openTurn = null;
    // The paste below sets it again; the cast keeps TypeScript from narrowing past that closure.
    keptWhy = "refused" as Exclude<PasteVerdict, "ok">;
    if (app.window !== undefined) showDictation("Tidying…", true);
    ghostPlayed = false;
    const result = await oneShot.flush(app);
    if (result.status !== "pasted") {
      ghost.stop();
      composer.cancel();
    }
    if (result.status === "pasted") dictationTimer?.pasted();
    if (result.status === "empty") return showDictation(null);
    landed(result.text);
    // A secret that came in a later chunk, or only in the cleaned words, is offered to the vault like one at the start.
    if (turnId !== null && history?.get(turnId)?.raw !== REDACTED)
      offerVault(result.raw, result.text);
    history?.update(turnId ?? "", {
      // The window the words went to, for spoken dictation too (its row was opened before the window was known).
      ...(app.exe === "" ? {} : { app: app.exe }),
      // The level its clean-up used (a bank or sign-in page by its title): a retry never goes above it.
      cleanup: result.level === "claude" ? "claude" : "local",
      raw: result.raw,
      cleaned: result.text,
      status: result.failed ? "raw" : "ok",
      // Named only when the model could have cleaned it: a local clean-up said "tidied by haiku" (0.1.106).
      model: result.failed || result.level !== "claude" ? null : settings.cleanupModel,
      error: result.failed
        ? "Clean-up failed, inserted what was heard"
        : result.status === "kept"
          ? "Not pasted"
          : null,
    });
    const hidden = hideIfPrivate(turnId, app, result.status === "kept" && keptWhy === "secret");
    if (result.status === "pasted") {
      // Pasted already: the pill plays the cleanup over his words afterwards, so it never holds the paste up.
      if (!ghostPlayed) pill.cleanup(result.raw, result.text);
      // Nothing said into a private app or a password box is learned from.
      if (hidden === null) {
        learnWording(result.text);
        learnFromEdits(result.text, turnId, app);
      }
      if (result.failed) {
        showDictation(null);
        toast.show({ kind: "error", message: CLEANUP_FAILED_LINE });
      } else offerSmarterCleanup();
      dictationTimer?.pillGone();
    } else {
      const name = app.title.trim() || app.exe || "Its window";
      toClipboard(
        result.text,
        result.taken,
        app.window === undefined
          ? "There was no window to paste into"
          : keptWhy === "gone"
            ? `${name} has closed`
            : keptWhy === "changed"
              ? `${name} changed while you spoke`
              : keptWhy === "secret"
                ? "That box is for a password"
                : keptWhy === "nofield"
                  ? "No text box was selected"
                  : `${name} did not take it`,
        app.window === undefined ? "nowindow" : keptWhy,
      );
    }
    noteTiming();
  };
  /** ✓ (or "stop dictation") inserts what was said; ✕ or Esc throws it away. Nothing else ends spoken dictation. */
  const endVoiceDictation = (insert: boolean) => {
    if (!dictatingByVoice) return;
    // ✓ is the spoken dictation's release: its line runs from here to the pill leaving.
    if (insert)
      dictationTimer = startDictationTiming(
        { ev: "text", id: null, text: oneShot.pending().join(" "), releaseMs: 0 },
        "voice",
      );
    if (!insert) {
      ghost.stop();
      discarding = true;
      const text = oneShot.pending().join(" ");
      if (text !== "") {
        undo = { text, target: dictationHold.target() };
        lastDictation = text;
      }
      oneShot.discard();
      if (openTurn !== null) {
        history?.update(openTurn, { error: "Discarded" });
        const discarded = openTurn;
        void dictationHold
          .target()
          ?.then((app) => app !== null && hideIfPrivate(discarded, app, false));
      }
      openTurn = null;
    }
    void core?.setDictation(false).then(() => {
      if (insert || undo === null) return;
      showDictation("Discarded · click to undo", false, true);
      if (keptTimer !== null) clearTimeout(keptTimer);
      keptTimer = setTimeout(() => {
        undo = null;
        showDictation(null);
      }, UNDO_MS);
    });
  };
  /** A click on the pill while it says "Discarded": the words go where they were going, as ✓ would have sent them. */
  const undoDiscard = () => {
    const back = undo;
    if (back === null) return false;
    undo = null;
    if (keptTimer !== null) clearTimeout(keptTimer);
    oneShot.push(back.text);
    void flushDictation(back.target);
    return true;
  };
  const injection: typeof clipboardInjection = {
    ...clipboardInjection,
    // The sidecar pastes on every platform, where Electron alone cannot.
    canInject: (target) => binary !== null || clipboardInjection.canInject(target),
    // Handy's paste keeps his clipboard; PowerShell's stays for when the sidecar is not there.
    insertText: async (request) => {
      if (sidecar === null) return clipboardInjection.insertText(request);
      if (discarding) return;
      if (collecting) {
        oneShot.push(request.text);
        const joined = oneShot.pending().join(" ");
        if (dictatingByVoice) {
          pill.on({ type: "dictating", caption: dictationCaption(dictatingInto, joined) });
          dictationWords(joined);
        }
        if (openTurn === null) {
          openTurn = record({
            kind: "dictation",
            app: "",
            raw: joined,
            cleaned: null,
            status: "none",
            delivery: "oneshot",
            cleanup: "local",
            seconds: (lastPcm?.length ?? 0) / 16_000,
          });
        } else {
          history?.update(openTurn, {
            raw: joined,
            seconds: (history.get(openTurn)?.seconds ?? 0) + (lastPcm?.length ?? 0) / 16_000,
          });
        }
        keepAudio(openTurn, lastPcm);
        return;
      }
      // Wake-word dictation takes the same path as the hold key, so the same text comes out.
      const app =
        (await dictationHold.target()) ??
        (await sidecar.foreground().catch(() => null)) ??
        focusedApp;
      const timer = startDictationTiming({ ev: "text", id: null, text: request.text }, "voice");
      const { text, stage, speculated } = await writeClean(request.text, app);
      timer.cleaned(stage, speculated);
      const fitted = await fitToCaret(text, app);
      timer.fitted();
      const target = app.window;
      const side = sidecar;
      const pasted = await pasteInOrder(async () =>
        target === undefined
          ? (await side.paste(fitted), true)
          : side.pasteInto(fitted, target).catch(() => false),
      );
      if (pasted) {
        timer.pasted();
        input.onNote?.("dictation_timing", { ...timer.line(true) });
        return;
      }
      // The router hears inserted: false, and the outcome keeps the words on the pill and in the tray.
      throw new Error("Not pasted");
    },
  };
  // Only where this desktop can paste is the focused field a dictation target.
  const field = injection.canInject(FOCUSED_FIELD) ? FOCUSED_FIELD : null;

  let state: VoiceState = "sleeping";
  let devices: ReadonlyArray<AudioInputDevice> = [];
  let choice: DeviceChoice = {
    kind: "default",
    deviceId: null,
    reason: "Not started.",
    label: null,
  };
  let loop: VoiceLoop | null = null;
  let note: string | null = input.makeCore === null ? "Voice core not installed." : null;
  let focusedWorkSessionId: string | null = null;
  let contextTimer: ReturnType<typeof setInterval> | null = null;

  const deviceName = () => choiceSummary(choice).mic ?? "System microphone";
  const markOptions = (): MarkOptions => {
    const on = (id: string) =>
      input.extras?.controls().some((c) => c.id === id && c.kind === "toggle" && c.on) ?? false;
    return {
      color: hudView(state).color,
      caps: [settings.enabled, on("s.capture"), on("s.act")],
      muted: state === "muted",
      badge: input.updates?.ready() ?? false,
    };
  };
  // The taskbar's theme changes the tray mark's colour (white on dark, black on light).
  Electron.nativeTheme.on("updated", () => render());
  // Each tray call is synchronous on Windows: only when the image or text changed.
  let trayImage: Electron.NativeImage | null = null;
  let trayTip = "";
  const renderNow = () => {
    pill.setReason(loop === null ? "off" : state === "muted" ? "muted" : "sleeping");
    const image = trayIcon(markOptions());
    if (image !== trayImage) tray.setImage((trayImage = image));
    const taskbarDark = Electron.nativeTheme.shouldUseDarkColorsForSystemIntegratedUI;
    showTaskbarIcon(
      NodePath.join(ART_DIR, taskbarIconFile(settings.palette, taskbarDark ? "dark" : "light")),
      input.platform,
    );
    const tip = `Tessaya: ${hudView(state).label} · ${deviceName()}${note ? ` · ${note}` : ""}`;
    if (tip !== trayTip) tray.setToolTip((trayTip = tip));
    rebuildMenu();
  };
  // Several changes in a burst (a state, a note, a reply) repaint the tray, rebuild its menu and push the whole
  // window state once, not once each.
  let renderTimer: ReturnType<typeof setTimeout> | null = null;
  const render = () => {
    if (renderTimer !== null) return;
    renderTimer = setTimeout(() => {
      renderTimer = null;
      renderNow();
    }, RENDER_COALESCE_MS);
  };
  /** A reply to something said: on the pill, and in full when nothing will read it out. */
  const flash = (caption: string) => {
    if (input.extras?.writtenOnly() === true) input.extras.notice(caption);
    else pill.on({ type: "done", label: caption.slice(0, PILL_TEXT_CHARS) });
    render();
  };

  // The intent RPCs live in the Baton window's renderer: main asks, it answers.
  let nextRequest = 0;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  let mainContents: Electron.WebContents | null = null;
  const request = async (
    body:
      | VoiceIntentRequest
      | BatonJobBridgeRequest
      | BatonMemoryBridgeRequest
      | BatonCommitmentBridgeRequest
      | BatonWeaveBridgeRequest
      | BatonCloudBridgeRequest
      | BatonPhoneBridgeRequest
      | HomeBridgeRequest,
  ): Promise<unknown> => {
    // With T3's window closed, this machine's server answers instead of opening the window; acting on another
    // computer is refused in a sentence, since only T3's own session to it may do that.
    const direct = input.direct;
    if (direct !== undefined && (serverOnly(body) || (await input.mainWindowUp?.()) === false)) {
      const here = (await input.sessions?.ready()) ?? null;
      const call = deskCall(body, here, (id) => input.sessions?.labelOf(id) ?? "that computer");
      if (call !== null && "refuse" in call) throw new Error(call.refuse);
      if (call !== null) return direct(call.method, call.input);
    }
    // Listing servers for the Memory tab never reopens T3's window; the tab shows the last list.
    if (
      body.kind === "memory" &&
      body.op === "syncPeers" &&
      (await input.mainWindowUp?.()) === false
    )
      throw new Error("T3's window is closed.");
    const window = await input.ensureMainWindow();
    mainContents = window.webContents;
    const id = ++nextRequest;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("Tessaya did not answer."));
      }, REQUEST_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      window.webContents.send(BATON_VOICE_REQUEST_CHANNEL, { id, request: body });
    });
  };
  Electron.ipcMain.on(BATON_VOICE_RESPONSE_CHANNEL, (event, message: unknown) => {
    if (event.sender !== mainContents || typeof message !== "object" || message === null) return;
    const { id, ok, value, error } = message as {
      id?: unknown;
      ok?: unknown;
      value?: unknown;
      error?: unknown;
    };
    const entry = typeof id === "number" ? pending.get(id) : undefined;
    if (entry === undefined) return;
    pending.delete(id as number);
    clearTimeout(entry.timer);
    if (ok === true) entry.resolve(value);
    else entry.reject(new Error(typeof error === "string" ? error : "That could not be done."));
  });
  /** What the sessions side answered joins the one conversation, with what it was about. */
  const requestKept = async (
    body:
      | VoiceIntentRequest
      | BatonJobBridgeRequest
      | BatonMemoryBridgeRequest
      | BatonCommitmentBridgeRequest
      | BatonWeaveBridgeRequest
      | BatonCloudBridgeRequest
      | BatonPhoneBridgeRequest
      | HomeBridgeRequest,
  ): Promise<unknown> => {
    const value = await request(body);
    if (body.kind === "run" && input.conversation !== undefined) {
      const run = value as {
        reply?: string;
        resolution?: { outcome?: string; description?: string; workSessionId?: string | null };
      };
      const target =
        run.resolution?.outcome === "resolved" && run.resolution.description !== undefined
          ? {
              label: run.resolution.description,
              ...(typeof run.resolution.workSessionId === "string"
                ? { workSessionId: run.resolution.workSessionId }
                : {}),
            }
          : undefined;
      if (typeof run.reply === "string" && run.reply.length > 0) {
        input.conversation.add({
          route: "act",
          said: body.text,
          reply: run.reply,
          ...(target === undefined ? {} : { target }),
        });
        input.onNote?.("reply", { route: "act", said: body.text, reply: run.reply });
      }
    }
    return value;
  };
  // The phone relay: the desktop assistant answers what the phone page asked. It only talks while the app's own window is
  // already open (it never opens one to ask), so a tray-only app is "not connected" to the phone, and the ask waits.
  const phoneCall = guardedPhoneCall({
    windowUp: async () => (await input.mainWindowUp?.()) === true,
    request: (op, args) =>
      request({ kind: "phone", op: op as BatonPhoneBridgeRequest["op"], args }),
    mark: markPhase,
  });
  const phoneRelay = createPhoneRelay({
    call: phoneCall,
    run: (text, source) =>
      input.extras?.askFromPhone === undefined
        ? Promise.reject(new Error("No assistant here."))
        : input.extras.askFromPhone(text, source),
  });
  input.extras?.setPhoneMirror?.(phoneRelay.mirror);
  let phoneQuiet = 0;
  // Its account of itself for `tessaya_state`, sent when it changes and at least every few minutes.
  let statePublished = { json: "", at: 0 };
  const publishState = async (): Promise<void> => {
    const own = input.extras?.stateForServer?.();
    if (own === undefined) return;
    // Asking the window never reopens it: with it closed there is nothing new to say.
    if ((await input.mainWindowUp?.()) !== true) return;
    const peers = ((await request({ kind: "cloud", op: "environments", args: {} }).catch(
      () => [],
    )) ?? []) as ReadonlyArray<{ label?: unknown; state?: unknown }>;
    const state = desktopState({
      ...own,
      voice: settings,
      appVersion: Electron.app.getVersion(),
      environments: peers.map((p) => ({
        label: String(p.label ?? ""),
        state: typeof p.state === "string" ? p.state : "unknown",
      })),
    });
    const json = JSON.stringify(state);
    if (json === statePublished.json && Date.now() - statePublished.at < STATE_REFRESH_MS) return;
    await phoneCall("state", { state });
    statePublished = { json, at: Date.now() };
  };
  const phoneLoop = async (): Promise<void> => {
    markPhase("phone-tick:begin");
    const outcome = await phoneRelay.tick().finally(() => markPhase("phone-tick:end"));
    if (outcome !== "away") void publishState().catch(() => undefined);
    phoneQuiet = outcome === "idle" || outcome === "away" ? phoneQuiet + 1 : 0;
    setTimeout(() => void phoneLoop(), nextPollMs(phoneQuiet)).unref();
  };
  setTimeout(() => void phoneLoop(), PHONE_POLL_MS).unref();
  const voiceIntent = makeVoiceIntentClient({
    request: requestKept,
    injection,
    field: FOCUSED_FIELD,
  });
  const typedRouter = createVoiceRouter(voiceIntent);
  const routeContext = () => ({
    bus: desktopVoiceContext({ focusedWorkSessionId, field, observedAt: new Date() }),
    now: Date.now(),
  });
  const commitments = createCommitmentStore(input.stateDir, Date.now, undefined, () =>
    setTimeout(() => void syncCommitments(), COMMIT_SYNC_SOON_MS).unref(),
  );
  const userJobStore = createUserJobStore(input.stateDir, (why) =>
    input.onNote?.("user_jobs_skipped", { why }),
  );
  /** When Tessaya started: a timed job whose time came before this, the same day, was missed (its missed-run choice). */
  const voiceStartedAt = Date.now();
  // The server copy is shared by his devices. Without this machine's server door it follows only while the
  // window exists, since asking through a closed one would open it.
  const commitmentSync = createCommitmentSync({
    store: commitments,
    call: (op, args) => requestKept({ kind: "commitments", op, args }),
  });
  const syncCommitments = async (): Promise<void> => {
    if (input.direct === undefined && (mainContents === null || mainContents.isDestroyed())) return;
    await commitmentSync.sync();
  };
  setInterval(() => void syncCommitments(), COMMIT_SYNC_MS).unref();
  const externalNeeds = createExternalNeeds();
  const needsConfig = () => ({
    repos: settings.needsRepos,
    deadlinesFile: settings.needsDeadlinesFile,
    feeds: settings.needsFeeds,
    expect: settings.needsExpect,
  });
  /** The house and device tools: the server answers ok with a value or a sentence; the model gets it as JSON text. */
  const homeOp = async (
    args: Readonly<Record<string, unknown>>,
    kind: "home" | "devices" = "home",
  ): Promise<string> => {
    try {
      const reply = (await requestKept({
        kind,
        op: args["method"] === "act" ? "act" : args["method"] === "owner" ? "owner" : "read",
        args: {
          op: String(args["op"] ?? ""),
          args: {
            ...(args["args"] as Readonly<Record<string, unknown>>),
            surface: "assistant",
            who: "Tessaya",
          },
        },
      })) as { ok?: boolean; error?: string; value?: unknown } | null;
      if (reply?.ok !== true) return reply?.error ?? "Home did not answer.";
      return JSON.stringify(reply.value ?? null).slice(0, 8000);
    } catch (error) {
      return error instanceof Error ? error.message : "Home did not answer.";
    }
  };
  const weaveOp = async (
    op: "weave_send" | "weave_list",
    args: Readonly<Record<string, unknown>>,
  ) => {
    if (op === "weave_list") {
      // Through the window, a list first delivers what is due; the server's own drainer does that otherwise.
      if (mainContents !== null && !mainContents.isDestroyed())
        await requestKept({ kind: "weave", op: "tick", args: {} }).catch(() => undefined);
      const out = (await requestKept({ kind: "weave", op: "list", args: {} })) as {
        items?: ReadonlyArray<WeaveRecord>;
      } | null;
      return describeWeaves(out?.items ?? [], Date.now());
    }
    const out = (await requestKept({
      kind: "weave",
      op: "send",
      args: {
        to: String(args["session"] ?? ""),
        text: String(args["text"] ?? ""),
        from: "Tessaya",
        ...(typeof args["job"] === "string" ? { job: args["job"] } : {}),
      },
    })) as { weave?: WeaveRecord } | null;
    const w = out?.weave;
    if (w === undefined) return "The message was not sent.";
    return w.status === "delivered"
      ? `Delivered to ${w.toLabel}. Ask for weave_list later to read its reply [id: ${w.id}].`
      : w.status === "queued"
        ? `Not delivered yet, queued in order: ${w.reason ?? "it cannot take it now"} [id: ${w.id}].`
        : `Not delivered: ${w.reason ?? "unknown"} [id: ${w.id}].`;
  };
  /** A finished job as a draft SKILL.md in its own folder, opened for him to read; never installed by itself. */
  const draftSkill = async (id: string): Promise<string> => {
    const job = (jobsCache ?? []).find((j) => j.workSessionId === id);
    if (job === undefined) return "There is no such job.";
    if (job.group !== "done") return "Only a finished job can become a skill.";
    const draftJob = { title: job.title, goal: job.goal, notes: notesOf(job.terms.revisions) };
    let text = fallbackDraft(draftJob);
    let how = "from a plain template, because the model did not answer";
    try {
      const made = usableDraft(await askModel(draftSystemPrompt, draftMessage(draftJob)));
      if (made !== null) {
        text = made;
        how = "by your own Claude";
      }
    } catch {
      // The template stands in.
    }
    const file = writeDraft(input.stateDir, job.title, text);
    void Electron.shell.openPath(file);
    return `A skill draft was written ${how}, and opened for you to read and edit: ${file}. To add it, paste its path under "Add a skill" on the Skills tab; it is reviewed first.`;
  };
  /** Asks a failed job's worker to try again, inside its retry budget. */
  const retryJob = async (id: string, reason: string): Promise<string> => {
    const job = (jobsCache ?? []).find((j) => j.workSessionId === id);
    if (job === undefined) return "There is no such job. Ask for jobs_list.";
    const why = retryRefusal(job);
    if (why !== null) return why;
    const last = input.sessions?.rows().find((r) => r.key === id);
    await requestKept({
      kind: "job",
      op: "refine",
      args: { id, text: retryText(job, reason, last?.session ?? null), via: "text" },
    });
    return `Asked the worker to try again (${retriesUsed(job.terms.revisions) + 1} of ${retryBudget(job)}).`;
  };
  const briefExtra = (): ReadonlyArray<string> => {
    const lines = [
      briefCommitments(commitments.list(), Date.now()),
      jobsDigest(jobsCache ?? [], Date.now()),
      waitingSkillsLine(skillsDirOf(NodePath.join(input.stateDir, PACK_FOLDER)), new Date()),
    ];
    return lines.filter((l): l is string => l !== null);
  };
  /** The Record's notes that a persona passed the day's turn guide; none when the server cannot be read. */
  const recordNotes = async (
    kind: string,
    limit: number,
    since = Date.now() - 24 * 3_600_000,
  ): Promise<ReadonlyArray<BatonRecordEntry>> => {
    const value = (await input
      .direct?.("baton.record.list", {
        kind,
        since: new Date(since).toISOString(),
        limit,
      })
      .catch(() => null)) as { entries?: ReadonlyArray<BatonRecordEntry> } | null | undefined;
    return value?.entries ?? [];
  };
  const guideNotes = () => recordNotes("background_turns", 20);
  const awareness = createAwareness({
    switches: () => ({
      window: settings.awarenessWindow,
      idle: settings.awarenessIdle,
      focus: settings.awarenessFocus,
      jobs: settings.awarenessJobs,
    }),
    foreground: async () => {
      const app = await sidecar?.foreground();
      return app === undefined || app.exe.length === 0 ? null : `${app.exe}: ${app.title}`;
    },
    idleSeconds: () => Electron.powerMonitor.getSystemIdleTime(),
    focusSession: () =>
      input.sessions?.rows().find((r) => r.key === focusedWorkSessionId)?.session ?? null,
    runningJobs: () => (jobsCache ?? []).filter((j) => j.group === "running").map((j) => j.title),
    doing: () =>
      buildApprovals({ jobs: jobsCache ?? [], sessions: input.sessions?.rows() ?? [] })
        .slice(0, 3)
        .map((a) => `waiting for his answer: ${a.title}`),
    now: () => Date.now(),
  });
  setInterval(() => {
    if (awareness.active()) void awareness.sample().catch(() => undefined);
  }, AWARENESS_SAMPLE_MS).unref();
  // A typed ask has no spoken "confirm", so the read-back becomes a box he answers himself.
  input.extras?.setActions({
    presence: () => awareness.describe(),
    projectOf: (session) =>
      input.sessions?.rows().find((r) => r.key === session.split(" ")[0])?.project || null,
    projectRefOf: (session) => {
      const row = input.sessions?.rows().find((r) => r.key === session.split(" ")[0]);
      return row === undefined || row.project === ""
        ? null
        : { title: row.project, computer: row.box };
    },
    projects: () =>
      (input.sessions?.rows() ?? [])
        .filter((r) => r.project !== "")
        .map((r) => ({ title: r.project, computer: r.box })),
    jobProjects: async (id) => {
      const value = (await requestKept({ kind: "job", op: "list", args: {} }).catch(
        () => null,
      )) as {
        jobs?: ReadonlyArray<BatonJob>;
      } | null;
      const job = value?.jobs?.find((j) => j.workSessionId === id);
      // A job's projects are named by title; the computer it runs on is not on its card.
      return job === undefined
        ? null
        : job.terms.permissions.projects.map((title) => ({ title, computer: null }));
    },
    sessionsList: () => {
      const rows = input.sessions?.rows() ?? [];
      return rows.length === 0
        ? "No sessions are loaded yet."
        : rows
            .map(
              (r) =>
                `${r.session} (${r.project}, ${r.box}, ${r.state}${r.urgent ? ", needs him" : ""}) [id: ${r.key}]`,
            )
            .join("\n");
    },
    memory: (op, args) =>
      requestKept({ kind: "memory", op: op as BatonMemoryBridgeRequest["op"], args }),
    jobs: async (op, args) => {
      if (op === "approvals") {
        const jobs = (await requestKept({ kind: "job", op: "list", args: {} })) as {
          jobs?: ReadonlyArray<BatonJob>;
        } | null;
        return describeApprovals(
          buildApprovals({ jobs: jobs?.jobs ?? [], sessions: input.sessions?.rows() ?? [] }),
        );
      }
      if (op === "commit_add" || op === "commit_done" || op === "commit_list") {
        return runCommitOp(commitments, op, args, Date.now());
      }
      if (op === "user_job_save" || op === "user_job_update" || op === "user_job_delete") {
        const said = userJobOp(op, args);
        render();
        return said;
      }
      if (op === "weave_send" || op === "weave_list") return weaveOp(op, args);
      if (op === "home") return homeOp(args);
      if (op === "devices") return homeOp(args, "devices");
      if (op === "note_add") {
        try {
          return `Saved to the Scratchpad [id: ${scratch.add(String(args["text"] ?? "")).id}].`;
        } catch (error) {
          return error instanceof Error ? error.message : "That was not saved.";
        }
      }
      if (op === "note_search") {
        const found = searchNotes(scratch.notes(), String(args["query"] ?? "")).slice(0, 10);
        return found.length === 0
          ? "No note has all of those words."
          : found.map((n) => `${previewOf(n.text, 300)} [id: ${n.id}]`).join("\n");
      }
      if (op === "skill_draft") return draftSkill(String(args["id"] ?? ""));
      if (op === "retry")
        return retryJob(String(args["id"] ?? ""), String(args["reason"] ?? "it failed"));
      if (op === "handoff") {
        await requestKept({ kind: "job", op: "handoff", args });
        return "Handed the job to that worker. The same thread continues there.";
      }
      if (op === "cloud_dispatch") {
        return cloud.tool.dispatch({
          ...(typeof args["provider"] === "string" ? { provider: args["provider"] } : {}),
          repo: String(args["repo"] ?? ""),
          branch: String(args["branch"] ?? ""),
          brief: String(args["brief"] ?? ""),
          ...(typeof args["label"] === "string" ? { label: args["label"] } : {}),
          ...(typeof args["expected_points"] === "number"
            ? { expectedUsage: args["expected_points"] }
            : {}),
          fromWeb: args["from_web_or_file"] === true,
        });
      }
      if (op === "cloud_status")
        return cloud.tool.status(
          String(args["id"] ?? ""),
          typeof args["provider"] === "string" ? args["provider"] : undefined,
        );
      if (op === "cloud_list")
        return cloud.tool.list(
          args["mine"] === true,
          typeof args["label"] === "string" ? args["label"] : undefined,
        );
      if (op === "cloud_cancel")
        return cloud.tool.cancel(
          String(args["id"] ?? ""),
          typeof args["provider"] === "string" ? args["provider"] : undefined,
        );
      if (op === "cloud_usage") return cloud.tool.usage();
      if (op === "cloud_approve")
        return cloud.tool.approve(
          String(args["id"] ?? ""),
          String(args["account"] ?? ""),
          typeof args["provider"] === "string" ? args["provider"] : undefined,
        );
      if (op === "trust_show") return describeTrust(trustData(), Date.now());
      if (op === "activity_today") return describeToday(trustData().entries, new Date());
      if (op === "record") {
        // The Record lives on this machine's own server, read directly whether or not T3's window is up.
        if (input.direct === undefined) return "The Record is not available here.";
        const hours = typeof args["since_hours"] === "number" ? args["since_hours"] : null;
        const value = (await input.direct("baton.record.list", {
          ...(hours === null
            ? {}
            : { since: new Date(Date.now() - hours * 3_600_000).toISOString() }),
          ...(typeof args["project"] === "string" ? { project: args["project"] } : {}),
          limit: 60,
        })) as { entries?: ReadonlyArray<BatonRecordEntry> } | null;
        return describeAuditTrail(buildAuditTrail({ record: value?.entries ?? [] }), (iso) =>
          new Date(iso).toLocaleString(undefined, {
            weekday: "short",
            hour: "2-digit",
            minute: "2-digit",
          }),
        );
      }
      if (op === "permission_off") {
        const what = permissionFromWords(String(args["what"] ?? ""));
        if (what === null)
          return "I do not know which permission that is. Ask for trust_show to see them.";
        applyHome(`trust.revoke:${what}`, null);
        return `Turned off: ${what}. You can turn it back on in the Trust page.`;
      }
      if (op === "notices_stop") return initiative.stop(String(args["about"] ?? ""));
      if (op === "notices_resume") return initiative.resume(String(args["about"] ?? ""));
      if (op === "needs") {
        const jobs = (await requestKept({ kind: "job", op: "list", args: {} })) as {
          jobs?: ReadonlyArray<BatonJob>;
        } | null;
        return answerNeeds({
          jobs: jobs?.jobs ?? [],
          sessions: input.sessions?.rows() ?? [],
          findings: await watchFindings(),
          extra: [
            ...needsFromCommitments(commitments.list(), Date.now()),
            ...syncNeeds(syncNow, Date.now()),
            ...cloudLoginsNeeds(cloudNow(), Date.now()),
          ],
          config: needsConfig(),
          external: externalNeeds,
          now: Date.now(),
        });
      }
      if (op === "brief") {
        const jobs = (await requestKept({ kind: "job", op: "list", args: {} })) as {
          jobs?: ReadonlyArray<BatonJob>;
        } | null;
        const memory = (await requestKept({
          kind: "memory",
          op: "list",
          args: { includeProposed: true, limit: 500 },
        }).catch(() => null)) as { items?: ReadonlyArray<{ proposed: boolean }> } | null;
        const held = memory?.items?.filter((i) => i.proposed).length ?? 0;
        return morningBrief({
          jobs: jobs?.jobs ?? [],
          findings: await watchFindings(),
          now: Date.now(),
          guide: await guideNotes(),
          extra: [
            ...briefExtra(),
            ...(held === 0
              ? []
              : [
                  `${held} ${held === 1 ? "memory waits" : "memories wait"} for his yes in the Memory tab (held filter).`,
                ]),
          ],
        });
      }
      // Rewrites of the selection are answered by the companion, which holds the keyboard.
      if (op === "text_transform" || op === "text_undo" || op === "text_command")
        return "That is not available here.";
      // The card for his yes is the companion's (createUserJob); only the save reaches here.
      if (op === "user_job_create" || op === "user_job_propose")
        return "That is not available here.";
      const value = (await requestKept({ kind: "job", op, args })) as {
        jobs?: ReadonlyArray<BatonJob>;
        findings?: ReadonlyArray<WatchFinding>;
        terms?: { phase?: string; workSessionId?: string; scheduleTaskId?: string | null } | null;
        stopped?: boolean;
        threadId?: string;
      } | null;
      if (op === "rule_preview" || op === "rule_run")
        return (value as { text?: string } | null)?.text ?? "Nothing was set up.";
      if (op === "list") return describeJobs(value?.jobs ?? []);
      if (op === "watch") return describeWatch(value?.findings ?? []);
      if (op === "team")
        return describeTeam((value as BatonTeamBoardResult | null) ?? { members: [] });
      if (op === "start") {
        return `Started. The worker is writing its plan in its own thread; nothing happens until he agrees. The job id is ${value?.terms?.workSessionId ?? "unknown"}.`;
      }
      if (op === "split") {
        const started = (value as { started?: ReadonlyArray<unknown> } | null)?.started ?? [];
        return started.length === 0
          ? "Nothing was split: the job is not agreed yet, or it has no thread."
          : `Started ${started.length} workers, one per part. One summary will go to the job's thread when they are all in.`;
      }
      if (op === "stop")
        return value?.stopped === true ? "Stopped." : "Nothing was running to stop.";
      if (value?.terms === null || value?.terms === undefined) return "There is no job by that id.";
      if (op === "agree") {
        return value.terms.phase === "approved"
          ? "Agreed. The worker has been told to go ahead."
          : "The plan is not written yet, so nothing started. Ask again when it is ready.";
      }
      if (op === "schedule") {
        return value.terms.scheduleTaskId === null
          ? "It is not scheduled now (only a job he has agreed to can be scheduled)."
          : "Scheduled. Each run reports in the job's own thread.";
      }
      return op === "refine" ? "Passed on. The worker will make the plan again." : "Done.";
    },
    sessionShow: (idOrName) => {
      const row = findSession(input.sessions?.rows() ?? [], idOrName);
      return row === null ? null : describeSession(row, Date.now());
    },
    sessionSend: (idOrName, text) => {
      const row = findSession(input.sessions?.rows() ?? [], idOrName);
      if (row === null || input.sessions === undefined) return null;
      if (row.pane === null)
        return Promise.resolve(
          `${row.session} has no terminal pane here to type into. Nothing was sent.`,
        );
      return input.sessions.act(`n:${row.key}`, text);
    },
    fleetStatus: async () => {
      const rows = orderSessions(input.sessions?.rows() ?? []);
      const now = Date.now();
      const sessions =
        rows.length === 0
          ? "No sessions are loaded yet."
          : rows.map((r) => `${describeSession(r, now)} [id: ${r.key}]`).join("\n");
      return `${sessions}\n${describeWatch(await watchFindings())}`;
    },
    dictation: async (on) => {
      if (binary === null || sidecar === null)
        return "Dictation is not available on this computer.";
      if (parakeetPath === null) {
        requestDictation();
        return "The speech model is not downloaded yet; I started fetching it.";
      }
      // A key or button dictation is the same dictation: the tool ends it too, and says so truthfully.
      if (!on) {
        // A voice dictation is ended below, by the core; only a helper recording is ended here.
        const step = dictationStep("stop_tool", {
          voice: dictatingByVoice,
          keyRecording: keyRecording(),
          heldByButton,
          ready: true,
        });
        if (step === "helper_finish") {
          sidecar.finish();
          return "Dictation has stopped; what he said is being written out.";
        }
        if (step === "none") return "No dictation is running.";
      }
      // The same dictating mode as "Tessaya, dictate": his next words are typed, not answered.
      if (core === null) return "Dictation needs the voice to be on.";
      const dictating = await core.setDictation(on);
      if (on && !dictating) return "Dictation did not start.";
      return dictating
        ? 'Dictation is listening. What he says is held, not typed yet, and is pasted into the window that has the keyboard when he says "stop dictation" or clicks ✓ on the pill; ✕, or Esc twice, throws it away.'
        : "Dictation has stopped; what he said is being tidied and pasted now.";
    },
    focus: async () => asFocus(await sidecar?.foreground()),
    // Once per wake: a follow-up with no new wake reads where the keyboard is now.
    wakeFocus: async () => {
      // While he dictates the target is dictation's: reading it must not unbind the paste.
      return asFocus(
        (await (dictatingByVoice ? dictationHold.target() : dictationHold.takeTarget())) ??
          undefined,
      );
    },
    windowAt: async (point) => {
      if (sidecar === null) return null;
      const physical = Electron.screen.dipToScreenPoint(point);
      return Promise.race([
        sidecar.windowAt(physical).catch(() => null),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), APP_CHECK_MS)),
      ]);
    },
    uiChanges: async () => {
      if (sidecar === null) return null;
      const out = await Promise.race([
        sidecar.uiChanges(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), APP_CHECK_MS)),
      ]).catch(() => null);
      return typeof out?.count === "number" ? out.count : null;
    },
    uiTree: async (find, numbered) => {
      if (sidecar === null) return null;
      const tree = await Promise.race([
        sidecar.uiTree(undefined, find, numbered),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), LOCATE_TIMEOUT_MS * 2)),
      ]).catch(() => null);
      if (tree === null || tree.controls === undefined) return null;
      return {
        window: tree.window ?? "",
        controls: tree.controls,
        ...(tree.shown === undefined ? {} : { shown: tree.shown }),
        ...(tree.tree === undefined ? {} : { tree: tree.tree }),
      };
    },
    focusState: async () => {
      if (sidecar === null) return null;
      const state = await Promise.race([
        sidecar.focusState(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), APP_CHECK_MS)),
      ]).catch(() => null);
      if (state === null || typeof state.error === "string") return null;
      return { window: state.window ?? "", focus: state.focus ?? null };
    },
    hands: () =>
      sidecar === null
        ? null
        : {
            locate: sidecar.locate,
            uiTree: sidecar.uiTree,
            focusState: sidecar.focusState,
            captureWindow: sidecar.captureWindow,
            focusWindow: sidecar.focusWindow,
            focusWindowTitled: sidecar.focusWindowTitled,
            input: sidecar.input,
            pasteInto: sidecar.pasteInto,
            paste: sidecar.paste,
            setValue: sidecar.setValue,
          },
    locate: async (label, near, anywhere, invoke, ref) => {
      if (sidecar === null) return null;
      const physical = Electron.screen.dipToScreenPoint(near);
      // The sidecar answers an invoke within 2 s ("pending" when a dialog it opened is up), so it waits past that.
      const found = await Promise.race([
        sidecar.locate({
          label,
          x: physical.x,
          y: physical.y,
          ...(anywhere === true ? { foreground: true } : {}),
          ...(invoke === true ? { invoke: true } : {}),
          ...(ref === undefined ? {} : { ref: ref.line, tree: ref.tree }),
        }),
        new Promise<"slow">((resolve) =>
          setTimeout(() => resolve("slow"), LOCATE_TIMEOUT_MS * (invoke === true ? 2 : 1)),
        ),
      ]).catch(() => null);
      // The pointer does not wait on a slow tree; a click by name must not hear "not there" when it simply was not read.
      if (found === "slow") {
        if (anywhere !== true) return null;
        throw new Error(
          invoke === true
            ? `The window's controls took too long to read; "${label}" may still have been pressed. Look before trying again.`
            : "The window's controls took too long to read.",
        );
      }
      if (found?.stale === true) {
        throw new Error(
          `The window changed since ui_tree, so ${label} may be another control now. Read ui_tree again.`,
        );
      }
      if (found?.found === true && found.invoked !== undefined) {
        // Where the control is, so her cursor can show it; the press itself needed no point.
        const at =
          found.x === undefined || found.y === undefined
            ? near
            : Electron.screen.screenToDipPoint({ x: found.x, y: found.y });
        return {
          ...at,
          name: found.name ?? label,
          invoked: found.invoked,
          ...(found.state === undefined ? {} : { state: found.state }),
        };
      }
      if (found?.found !== true || found.x === undefined || found.y === undefined) return null;
      const real = Electron.screen.screenToDipPoint({ x: found.x, y: found.y });
      // Same name far from where the model saw it is a different thing.
      if (anywhere !== true && Math.hypot(real.x - near.x, real.y - near.y) > LOCATE_MAX_DIP) {
        return null;
      }
      // The size comes in physical pixels; the overlay draws in desktop points.
      const scale = Electron.screen.getDisplayNearestPoint(real).scaleFactor || 1;
      return {
        ...real,
        name: found.name ?? label,
        ...(found.covered_by === undefined ? {} : { coveredBy: found.covered_by }),
        ...(found.width === undefined || found.height === undefined
          ? {}
          : { width: found.width / scale, height: found.height / scale }),
      };
    },
    confirm: (prompt) => core?.confirm(prompt) ?? null,
    // D4: while Voice ID runs, a spoken yes stands alone only for ordinary things and only in his voice.
    spokenYes: (risk) =>
      !speakerIdentity.running() ||
      !voiceApproval(speakerIdentity.current(), risk, settings.voiceId.voiceYes).cardRequired,
    savedMessages: () => settings.voiceId.savedMessages,
    folder: (window) => focusedFolder(window, input.platform),
    grammarPlaces: async (said) => {
      if (mainContents === null) return false;
      const resolution = await voiceIntent.resolve({
        text: said,
        focusedWorkSessionId,
        allowModel: false,
      });
      return resolution.outcome === "resolved";
    },
    act: async (command, restated) => {
      const outcome = await typedRouter.route(
        {
          kind: "command",
          text: command,
          inheritedTarget: null,
          ...(restated === true ? { restated } : {}),
        },
        routeContext(),
      );
      if (outcome.kind !== "needs_confirmation") return "reply" in outcome ? outcome.reply : "";
      const response = await (input.extras?.ask({
        title: outcome.prompt.replace(/ Say "confirm" to go ahead\.$/, ""),
        detail: "",
        buttons: ["Go ahead", "Not now"],
        cancel: 1,
        expiresMs: TYPED_CONFIRM_MS,
      }) ?? Promise.resolve(1));
      const next = await typedRouter.route(
        response === 0
          ? { kind: "confirmed", token: outcome.token }
          : { kind: "cancelled", token: outcome.token, reason: "declined" },
        routeContext(),
      );
      return "reply" in next ? next.reply : "";
    },
  });

  const pushContext = () =>
    core?.setContext(desktopVoiceContext({ focusedWorkSessionId, field, observedAt: new Date() }));
  Electron.ipcMain.on(BATON_VOICE_FOCUS_CHANNEL, (event, id: unknown) => {
    // Our own windows only; preview panes load other people's pages.
    if (Electron.BrowserWindow.fromWebContents(event.sender) === null) return;
    focusedWorkSessionId = typeof id === "string" && id.length > 0 ? id : null;
    pushContext();
  });

  const preference = () => ({
    pinnedLabel: settings.pinnedLabel,
    micOrder: settings.micOrder.map((mic) => mic.name),
  });
  const silence = createSilenceWatch({ seconds: () => settings.micSilenceSeconds });
  let chosen: string | null = null;
  // Every mic pick is logged; keeping his mic over a hands-free headset is announced once.
  const choose = (next: DeviceChoice) => {
    const was = choiceSummary(choice);
    const now = choiceSummary(next);
    choice = next;
    if (JSON.stringify(now) === chosen) return;
    chosen = JSON.stringify(now);
    silence.reset();
    // A new microphone has its own room and level: the waveform learns them afresh.
    pillGain.reset();
    input.onNote?.("mic", now);
    if (now.why === "kept" && was.why !== "kept") {
      const headset = devices.find((d) => d.isDefault === true)?.label ?? "a Bluetooth headset";
      input.extras?.notice(
        `Your system switched the microphone to ${headset}. I stayed on ${now.mic}. Right-click the tray icon to pick another.`,
      );
    }
  };
  const reselect = () =>
    choose(selectInputDevice(devices, preference(), choiceSummary(choice).mic));
  const pickMic = (label: string | null) => {
    save({ pinnedLabel: label });
    void restart();
  };
  const channelFor = (device: string): number | null =>
    micChannel(
      device,
      sidecarDevices.find((known) => known.name === device)?.channels ?? null,
      settings.micOrder,
    );

  /** Every key set for an action, for the sidecar's hotkeys. */
  const keysOf = (action: string): ReadonlyArray<string> =>
    currentBindings()
      .find((row) => row.def.id === action)
      ?.inputs.flatMap((i) => (i.type === "key" ? [i.accelerator] : [])) ?? [];
  let bindingsNote: string | null = null;
  /** Keys Windows or another app would not give up: said on the page, never a binding that silently does nothing. */
  let takenNote: string | null = null;
  /** The provider's own HTTPS API on his key; plain fetch, as the adapters are pure and take any fetch. */
  // @effect-diagnostics-next-line globalFetch:off
  const cloudFetch = (url: string, init: RequestInit) => fetch(url, init);
  // Linux's basic_text backend is a fixed key, not encryption: no key is kept there (as memory sync).
  const osProtection = () =>
    Electron.safeStorage.isEncryptionAvailable() &&
    (input.platform !== "linux" ||
      Electron.safeStorage.getSelectedStorageBackend() !== "basic_text")
      ? {
          protect: (plain: string) => Electron.safeStorage.encryptString(plain).toString("base64"),
          unprotect: (wrapped: string) =>
            Electron.safeStorage.decryptString(Buffer.from(wrapped, "base64")),
        }
      : null;
  const cloudKeys = createCloudKeys(
    NodePath.join(input.stateDir, "voice", "cloud-keys.json"),
    osProtection,
  );
  /** His recogniser tokens, by server address, encrypted like the cloud keys; never in the settings file. */
  const recognizerKeys = createCloudKeys<string>(
    NodePath.join(input.stateDir, "voice", "recognizer-keys.json"),
    osProtection,
  );
  /** The servers he turned on that have a token kept; one without is skipped, never tried open. */
  const recognizersWithTokens = (): ReadonlyArray<RecognizerServer> =>
    settings.recognizers.flatMap((url) => {
      const token = recognizerKeys.get(url);
      return token === null ? [] : [{ url, token }];
    });
  const cloudModelOf = (provider: CloudSttProvider) =>
    (settings.cloudProvider === provider ? settings.cloudModel : null) ??
    RECOMMENDED[provider].model;
  /** His cloud recogniser, or null: audio leaves this computer only when he chose Cloud and a key is kept. */
  const cloudChoice = () => {
    if (settings.recognition !== "cloud") return null;
    const key = cloudKeys.get(settings.cloudProvider);
    return key === null
      ? null
      : { provider: settings.cloudProvider, model: cloudModelOf(settings.cloudProvider), key };
  };
  /** One clip: the cloud within its budget, else this computer, with one quiet note. Never loses the words. */
  const recognise = async (
    wav: Uint8Array,
    audioMs: number,
    local: () => Promise<string>,
  ): Promise<string> => {
    const cloud = cloudChoice();
    if (cloud === null) return local();
    const started = Date.now();
    const { text, via } = await transcribeWithFallback({
      cloud: (signal) =>
        cloudTranscribe({
          ...cloud,
          wav,
          language: recogniserHint(settings.languages),
          fetch: cloudFetch,
          signal,
        }),
      local,
      audioMs,
      onFallback: ({ failure, detail }) => {
        // Only the status and the provider's short code reach the log, never the key or a body.
        step("cloud-fallback", { provider: cloud.provider, failure, detail });
        const name = PROVIDER_LABEL[cloud.provider];
        if (failure === "key") {
          cloudKeys.refuse(cloud.provider);
          configureDictation();
        }
        note =
          failure === "key"
            ? `${name} refused your key, so recognition is back on this computer until you save a new one.`
            : failure === "model"
              ? `${name} has no model "${cloud.model}", so this computer heard that one. Pick another under Cloud model.`
              : failure === "timeout"
                ? `${name} did not answer in time, so this computer heard that one.`
                : failure === "empty"
                  ? `${name} heard nothing in that, so this computer listened instead.`
                  : `${name} failed (${detail}), so this computer heard that one.`;
        render();
      },
    });
    step("cloud-recognised", { provider: cloud.provider, via, audioMs, ms: Date.now() - started });
    return text;
  };
  /** Each provider's models, fetched on his key when the Dictation settings are shown, at most every ten minutes. */
  const cloudModels: Partial<
    Record<
      CloudSttProvider,
      { readonly at: number; readonly models?: ReadonlyArray<CloudModel>; readonly error?: string }
    >
  > = {};
  const loadingModels = new Set<CloudSttProvider>();
  const loadCloudModels = (provider: CloudSttProvider, force = false) => {
    const cached = cloudModels[provider];
    if (
      loadingModels.has(provider) ||
      (!force && cached !== undefined && Date.now() - cached.at < 10 * 60_000)
    )
      return;
    const key = cloudKeys.get(provider);
    if (key === null) return;
    loadingModels.add(provider);
    void listCloudModels(provider, key, cloudFetch)
      .then(
        (models) => (cloudModels[provider] = { at: Date.now(), models }),
        (error: unknown) =>
          (cloudModels[provider] = {
            at: Date.now(),
            error: error instanceof Error ? error.message : String(error),
          }),
      )
      .finally(() => {
        loadingModels.delete(provider);
        render();
      });
  };
  let cloudTestResult: string | null = null;
  let cloudTesting = false;
  /** The Test button: the sample clip on his chosen provider and model, with what came back and how long it took. */
  const testCloud = async () => {
    const provider = settings.cloudProvider;
    const key = cloudKeys.get(provider);
    if (key === null || cloudTesting) return;
    cloudTesting = true;
    render();
    const model = cloudModelOf(provider);
    try {
      const pcm = await encoder.decode(Buffer.from(CLOUD_TEST_CLIP_WEBM_BASE64, "base64"));
      const started = Date.now();
      const heard = await cloudTranscribe({
        provider,
        key,
        model,
        wav: encodeWav(pcm),
        language: recogniserHint(settings.languages),
        fetch: cloudFetch,
        signal: AbortSignal.timeout(30_000),
      });
      cloudTestResult = `${model} answered in ${((Date.now() - started) / 1000).toFixed(1)} s: "${heard.slice(0, 120)}"`;
    } catch (error) {
      cloudTestResult = `${model} failed: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      cloudTesting = false;
      render();
    }
  };
  /** Recognition on this computer or in the cloud, and, for Cloud, the provider, his key, the model and a test. */
  const cloudRows = (): ReadonlyArray<HomeControl> => {
    const provider = settings.cloudProvider;
    const label = PROVIDER_LABEL[provider];
    const hasKey = cloudKeys.has(provider);
    const recognition: HomeControl = {
      id: "v.recognition",
      section: "Dictation",
      label: "Recognition",
      hint:
        settings.recognition === "cloud"
          ? `Your dictation and what you say to Tessaya are sent to ${label} on your own key. If it does not answer in a few seconds, this computer hears it instead. Wake word checks always stay on this computer.`
          : "Nothing you say leaves this computer.",
      kind: "choice",
      value: settings.recognition,
      options: [
        { value: "local", label: "On this computer (default)" },
        {
          value: "cloud",
          label: "Cloud",
          note: "Your audio goes to the provider you pick, on your own key.",
        },
      ],
      disabled: binary === null,
    };
    if (settings.recognition !== "cloud") return [recognition];
    // Shown again whenever the page is drawn: a stale or missing list is fetched in the background.
    loadCloudModels(provider);
    const listed = cloudModels[provider];
    const model = cloudModelOf(provider);
    const models = listed?.models ?? [];
    return [
      recognition,
      {
        id: "v.cloudProvider",
        section: "Dictation",
        label: "Cloud provider",
        kind: "choice",
        value: provider,
        options: CLOUD_STT_PROVIDERS.map((p) => ({
          value: p,
          label: PROVIDER_LABEL[p],
          note: cloudKeys.has(p) ? "Key saved" : "No key yet",
        })),
      },
      {
        id: "v.cloudKey",
        section: "Dictation",
        label: `${label} key`,
        hint: cloudKeys.refused(provider)
          ? `${label} refused this key, so this computer does the recognition. Save a new key to try again.`
          : hasKey
            ? "Encrypted by your computer's account and kept on it; never in settings or logs."
            : "Paste your own API key. Until one is saved, this computer does the recognition.",
        kind: "list",
        secret: true,
        items: hasKey ? ["Saved, encrypted on this computer"] : [],
        placeholder: "Paste your API key",
        addLabel: hasKey ? "Replace" : "Save",
      },
      {
        id: "v.cloudModel",
        section: "Dictation",
        label: "Cloud model",
        hint: !hasKey
          ? "The list loads once a key is saved."
          : listed?.error !== undefined
            ? `Could not load ${label}'s models: ${listed.error}`
            : listed === undefined
              ? `Loading ${label}'s models…`
              : `Recommended: ${RECOMMENDED[provider].model}. ${RECOMMENDED[provider].why}`,
        kind: "choice",
        value: model,
        options: (models.some((m) => m.id === model)
          ? models
          : [{ id: model, label: model, recommended: false }, ...models]
        ).map((m) => ({
          value: m.id,
          label: m.label,
          ...(m.recommended ? { note: RECOMMENDED[provider].why } : {}),
        })),
        disabled: !hasKey,
      },
      {
        id: "v.cloudTest",
        section: "Dictation",
        label: "Test cloud recognition",
        hint:
          cloudTestResult ??
          "Sends a 7-second sample clip (not your voice) and shows what came back and how long it took.",
        kind: "action",
        button: cloudTesting ? "Testing…" : "Test",
        disabled: !hasKey || cloudTesting,
      },
    ];
  };
  let cloudDictations: Promise<void> = Promise.resolve();
  /** Where the sidecar writes a recording for the cloud: his own folder, not the shared temp one, emptied at each start. */
  const cloudTmpDir = NodePath.join(input.stateDir, "voice", "tmp");
  const resetCloudTmp = () => {
    NodeFS.rmSync(cloudTmpDir, { recursive: true, force: true });
    NodeFS.mkdirSync(cloudTmpDir, { recursive: true, mode: 0o700 });
  };
  /** A hold-key recording the sidecar handed back for cloud recognition; the file is gone once it is heard. */
  const recogniseWav = async (wav: string, audioMs: number): Promise<string> => {
    try {
      const bytes = await NodeFS.promises.readFile(wav);
      return await recognise(bytes, audioMs, () =>
        sidecar === null ? Promise.reject(new Error("no speech helper")) : sidecar.transcribe(wav),
      );
    } finally {
      await NodeFS.promises.rm(wav, { force: true });
    }
  };

  const configureDictation = () => {
    if (sidecar === null) return;
    const device = choice.kind === "pinned" ? choice.device.label : null;
    const baton = settings.dictation === "baton" && parakeetPath !== null;
    sidecar.configure({
      model: parakeetPath,
      hold: baton ? keysOf("hold") : null,
      toggle: baton ? keysOf("toggle") : null,
      device,
      fallbacks: backupMics(devices, preference(), device),
      channel: device === null ? null : channelFor(device),
      paste: settings.paste,
      language: recogniserHint(settings.languages),
      external: cloudChoice() === null ? null : cloudTmpDir,
      keepAudio: settings.keepVoice ? cloudTmpDir : null,
      cleanup: true,
      latch: settings.doubleTap,
      mouse: NodePath.join(input.stateDir, "voice", "input-bindings.json"),
      // The memory line weakMachine uses: under 10 GB the model is let go after ten idle minutes, as before.
      keepLoaded: NodeOS.totalmem() >= 10 * 2 ** 30,
      liveWords: settings.showWords,
      meter: loop === null,
      recognizers: settings.recognizeOnServers ? recognizersWithTokens() : [],
      // Only the Windows build has the card's module; elsewhere a change would only restart the sidecar.
      gpu: input.platform === "win32" ? settings.gpuRecognition : "off",
    });
    syncCleanupSession();
  };
  /** Up at the claude level, gone below it: a session nobody will ask holds memory for nothing. */
  const syncCleanupSession = () => (cleanupStaysWarm() ? rewriter.warm() : rewriter.dispose());
  /** A dictation key (or mouse button) is bound and its words go to Claude: the first dictation must not wait for it. */
  const cleanupStaysWarm = () =>
    settings.dictationCleanup === "claude" &&
    settings.dictation === "baton" &&
    parakeetPath !== null &&
    currentBindings().some(
      (row) => (row.def.id === "hold" || row.def.id === "toggle") && row.inputs.length > 0,
    );

  /** The dictation pill's line is a message after the words (Discarded, an offer), not a dictation in progress. */
  let dictationMessage = false;
  const showDictation = (caption: string | null, tidying = false, message = false) => {
    dictationMessage = message;
    if (tidying) ghost.release();
    pill.on({ type: "dictating", caption, tidying }, { silent: !settings.holdKeyCues });
    render();
  };
  // Esc is taken only while the microphone is open, so it stays his the rest of the time.
  /** Erases what he typed the word for. Returns a sentence for the card. */
  const eraseData = async (scope: ResetScope): Promise<string> => {
    let removed = 0;
    if (scope === "history" || scope === "recordings") {
      for (const turn of history?.list({ limit: 1_000_000 }) ?? []) {
        if (turn.audio !== null) {
          for (const path of clipPaths(turn.audio)) NodeFS.rmSync(path, { force: true });
          if (scope === "recordings") history?.update(turn.id, { audio: null });
        }
        if (scope === "history") history?.remove(turn.id);
        removed += 1;
      }
      if (scope === "history") {
        lastDictation = null;
        lastInserted.clear();
        NodeFS.rmSync(NodePath.join(input.stateDir, "voice", "dictation-pending.json"), {
          force: true,
        });
      }
      return scope === "history"
        ? `History is erased (${removed} entries and their recordings).`
        : "The voice recordings are erased. The words in History stay.";
    }
    let forgotten = 0;
    try {
      const listed = (await requestKept({
        kind: "memory",
        op: "list",
        args: { includeSuperseded: true, includeProposed: true, limit: 100_000 },
      })) as { items?: ReadonlyArray<{ id: string }> } | null;
      for (const item of listed?.items ?? []) {
        await requestKept({ kind: "memory", op: "forget", args: { id: item.id } });
        forgotten += 1;
      }
    } catch {
      return `Memory could not be reached, so only your notes folder was erased (${forgotten} server memories were).`;
    } finally {
      NodeFS.rmSync(NodePath.join(input.stateDir, "memory"), { recursive: true, force: true });
    }
    return `Memory is erased (${forgotten} items and your notes folder).`;
  };
  const output = createOutputWatch({
    platform: input.platform,
    dir: NodePath.join(input.stateDir, "voice"),
  });
  void output.refresh();
  const duck = createVolumeDuck({
    file: NodePath.join(input.stateDir, "voice", "volume-before-dictation.json"),
    platform: input.platform,
  });
  void duck.recover();
  const setRecording = (next: boolean) => {
    if (next === (releaseRecordingEscape !== null)) return;
    if (next) void duck.start(settings.duckWhileDictating);
    else void duck.stop();
    if (!next) heldByButton = false;
    if (next) releaseRecordingEscape = input.holdEscape(() => keyEsc(), "recording");
    else {
      releaseRecordingEscape?.();
      releaseRecordingEscape = null;
    }
  };
  /** Wispr Flow's wrong-language notice: what it was heard as, and where his languages are set. */
  const heardOutside = (code: string) => {
    note = `Heard ${languageName(code)}, which is not one of your languages. Change them under Dictation: Languages you speak.`;
    render();
  };
  /** Words that have no home yet: an error card with Copy beside the pill, and in the tray until the next ones. */
  const keepText = (why: string, text: string) => {
    landed(text);
    showDictation(null);
    toast.show({ kind: "error", message: why, text });
  };
  /** Short utterances cut from the mic while the helper records, each heard for a whole stop or cancel. */
  const commandClips = createCommandClips();
  /** One command clip is heard at a time; another cut meanwhile is let go. */
  let hearingCommand = false;
  const hearKeyCommand = (frame: Int16Array, level: number) => {
    const clip = commandClips.feed({ level, pcm: frame });
    if (clip === null || sidecar === null || hearingCommand) return;
    // The recording it was cut from: a late answer never acts on the next one.
    const id = recordingSeq;
    hearingCommand = true;
    // Always the local model: no upload per phrase, and nothing reconfigured mid-recording.
    void makeSidecarStt(sidecar)
      .transcribe(clip)
      .then((said) => {
        if (id !== recordingSeq || !keyRecording()) return;
        // The one spoken command: a whole "stop dictation". Discarding is only ever ✕ or Esc twice.
        if (keyDictationCommand(said) !== "stop") return;
        const recording = recordings.find((r) => r.id === id);
        if (recording !== undefined) recording.heard = "stop";
        // Only ever an end: a stale state can never start a recording from here.
        void moveDictation("stop_tool");
      })
      .catch(() => undefined)
      .finally(() => {
        hearingCommand = false;
      });
  };
  /**
   * Each helper recording, oldest first: our id, the sidecar's (`dictation`; null from an older one), its window, a
   * command heard while it recorded, and Esc twice or ✕ on it (its words are then held for undo, not pasted).
   */
  const recordings: Array<RecordingEntry> = [];
  let recordingSeq = 0;
  /** A text event with its recording's window, discard and heard command on it, taken once, as it arrives. */
  const withRecording = <
    E extends {
      readonly dictation?: number;
      readonly app?: FocusedApp;
      readonly discarded?: boolean;
      readonly heard?: "stop" | null;
      readonly unmatched?: boolean;
    },
  >(
    event: E,
  ): E & {
    readonly app?: FocusedApp;
    readonly discarded?: boolean;
    readonly heard?: "stop" | null;
    readonly unmatched?: boolean;
  } => {
    if (event.app !== undefined || event.unmatched !== undefined) return event;
    const recording = takeRecording(recordings, event.dictation);
    // Words for a recording we no longer hold: never the next one's window, so they are kept, not pasted.
    if (recording === undefined)
      return { ...event, unmatched: event.dictation !== undefined, discarded: false };
    return { ...event, app: recording.app, heard: recording.heard, discarded: recording.discarded };
  };
  /** The newest recording: the one recording, or the one being written out, that ✕ or Esc twice throws away. */
  const discardNewest = () => {
    const last = recordings.at(-1);
    if (last !== undefined) last.discarded = true;
  };
  const discardKeyDictation = () => {
    discardNewest();
    composer.cancel();
    sidecar?.finish();
  };
  /** One stray Esc must not lose his words, as in spoken dictation: the first asks, the second discards. */
  const keyEsc = () => {
    if (Date.now() < escArmedUntil) return discardKeyDictation();
    escArmedUntil = Date.now() + ESC_AGAIN_MS;
    showDictation("Press Esc again to discard");
  };
  /**
   * A key or button dictation's words take the spoken one's path: one buffer, the window and title check, the
   * clipboard when it cannot paste, History with the app, learning and the Scratchpad.
   */
  const keyToBuffer = (
    text: string,
    target: number | null | undefined,
    spokenIn: FocusedApp,
    discarded: boolean,
    heard: "stop" | null,
  ) => {
    const app: FocusedApp = {
      exe: spokenIn.exe,
      title: spokenIn.title,
      ...(typeof target === "number" ? { window: target } : {}),
    };
    if (discarded) {
      ghost.stop();
      if (text === "") return showDictation(null);
      undo = { text, target: Promise.resolve(app) };
      showDictation("Discarded · click to undo", false, true);
      if (keptTimer !== null) clearTimeout(keptTimer);
      keptTimer = setTimeout(() => {
        undo = null;
        showDictation(null);
      }, UNDO_MS);
      return;
    }
    if (text === "") return showDictation(null);
    // A heard "stop dictation" ended it, and the helper wrote that down too (and what came after): not his words.
    const words = heard === "stop" ? beforeSpokenStop(text) : text;
    if (words === "") return showDictation(null);
    // Words that land while a spoken dictation is collecting join it, and go with its one paste.
    if (collecting) return oneShot.push(words);
    openTurn = record({
      kind: "dictation",
      app: app.exe,
      raw: words,
      cleaned: null,
      status: "none",
      delivery: "hold key",
      cleanup: "local",
      hidden: privateReason(app, false),
    });
    oneShot.push(words);
    void flushDictation(Promise.resolve(app));
  };
  /** Once ever, at the local level: Claude can also fix the grammar and the false starts. */
  const offerSmarterCleanup = () => {
    if (settings.dictationCleanup !== "local" || settings.cleanupOffered === true) {
      showDictation(null);
      return;
    }
    save({ cleanupOffered: true });
    showDictation("Smarter cleanup with Claude? Settings → Dictation", false, true);
    if (keptTimer !== null) clearTimeout(keptTimer);
    keptTimer = setTimeout(() => showDictation(null), OFFER_MS);
  };
  let mouseHookReady = false;
  /** A mouse binding fired in the sidecar: the same things the keys do. */
  /** The keys' handlers, set where they are built below; a mouse binding runs the same one. */
  let bindingHandlers: Readonly<Record<string, () => void>> | null = null;
  /**
   * A mouse button bound on the Keyboard and mouse page: the same action as its key, through the same handler, so a
   * button never saves and then does nothing. Hold ends on release.
   */
  const onBinding = (id: string, up = false) => {
    if (id === "hold") return void moveDictation(up ? "hold_up" : "hold_down");
    if (up) return;
    if (id === "toggle") return void moveDictation("toggle");
    bindingHandlers?.[id]?.();
  };
  /** A tap under PRESS_SHOW_MS never shows the pill; the microphone opened on the press all the same. */
  const pressGate = createPressGate(PRESS_SHOW_MS, () => showDictation("Esc twice discards"));
  /** The helper is recording a key or button dictation (its Esc is held while it does). */
  const keyRecording = () => releaseRecordingEscape !== null;
  /** That recording is held to talk (`heldToTalk`), until a double tap latches it. */
  let keyHeldToTalk = false;
  /** One dictation, whichever key, button or word moves it (`dictationStep`): the engines never run side by side. */
  const moveDictation = (entry: DictationEntry): DictationStep => {
    const step = dictationStep(entry, {
      voice: dictatingByVoice,
      keyRecording: keyRecording(),
      heldByButton,
      ready: settings.dictation === "baton" && binary !== null && parakeetPath !== null,
    });
    if (step === "voice_insert") endVoiceDictation(true);
    else if (step === "helper_toggle") sidecar?.toggle();
    else if (step === "helper_start") {
      heldByButton = true;
      sidecar?.start();
    } else if (step === "helper_finish") sidecar?.finish();
    // The first press is the opt-in: it fetches the model, and the next one records.
    else if (step === "fetch_model" && settings.dictation === "baton" && binary !== null)
      requestDictation();
    if (entry === "hold_up") heldByButton = false;
    return step;
  };
  const COMPOSER_WAIT_MS = 60_000;
  Electron.ipcMain.handle(BATON_COMPOSER_MIC_CHANNEL, async (event) => {
    // Our own windows only; preview panes load other people's pages.
    if (Electron.BrowserWindow.fromWebContents(event.sender) === null) return { handled: false };
    if (settings.composerMic === "t3" || settings.dictation !== "baton" || binary === null)
      return { handled: false };
    if (!keyRecording()) {
      moveDictation("toggle");
      return { handled: true };
    }
    // The chat box has this dictation already: its words reach it through `composer`, not this answer.
    if (composer.active()) {
      moveDictation("toggle");
      return { handled: true };
    }
    // The second press ends the recording; its words, cleaned, come back here (`paste` below).
    const words = new Promise<string>((resolve) => {
      composerWaiter = resolve;
      setTimeout(() => resolve(""), COMPOSER_WAIT_MS);
    });
    moveDictation("toggle");
    const text = await words;
    composerWaiter = null;
    return { handled: true, text };
  });
  const recordingFramer = makeFramer((frame) => {
    const level = frameLevel(frame);
    pill.micLevel(level, pillGain(level), frame);
  });
  /** How long the sidecar has been reading the speech model, from its "loading" lines (0 when it is not). */
  let speechLoadMs = 0;
  /** What Tessaya plays, against what the microphone hears, so his voice over hers can be told apart. */
  const echoGuard = createEchoGuard();
  const onDictation = (event: DictationEvent) => {
    if (event.ev === "pcm") {
      // With wake words off no mic loop runs, so the recording's own audio is all the waveform has.
      if (loop === null) recordingFramer(pcmOf(event.b64));
      return;
    }
    if (event.ev === "loading") {
      if (speechLoadMs === 0) step("speech-model-loading");
      speechLoadMs = event.elapsedMs;
      return;
    }
    if (event.ev === "binding") return onBinding(event.id, event.up === true);
    if (event.ev === "mic_switched") {
      input.onNote?.("mic_switched", { from: event.from, to: event.to, why: event.why });
      return showDictation(`Using ${event.to.replace(/^Microphone \((.*)\)$/, "$1")}`);
    }
    if (event.ev === "key_edge")
      return input.onNote?.("key_edge", { down: event.down, at: event.at });
    // The pill on the press itself; the microphone opens 80 to 140 ms later (`recording`).
    // His own chat box has the keyboard: it takes the dictation now, before the press could show the pill.
    if (event.ev === "pressed") {
      claimComposer("held");
      return pressGate.press();
    }
    // At a pause the words so far are cleaned while he still holds, so a release right after has its answer ready.
    if (event.ev === "partial") {
      // Words for a dictation that is no longer the newest (late from his server after a new key press) are dropped.
      if (stalePartial(event.dictation, recordings.at(-1)?.dictation ?? null)) return;
      dictationWords(event.text);
      const app = focusedApp;
      // Each finished sentence is cleaned as he speaks, and at a pause the last one too.
      if (settings.dictationCleanup === "claude")
        void levelNow(app).then(({ level }) =>
          rewriter.speculate({
            raw: event.text,
            mode: chooseMode(app, settings.appModes),
            level,
            context: { screen: screenNow },
            pause: event.pause !== false,
          }),
        );
      return;
    }
    // A restarted helper forgets that voice dictation runs; told again, its key presses stay this dictation's ✓.
    if (event.ev === "ready") sidecar?.voice(dictatingByVoice);
    if (event.ev === "configured") mouseHookReady = event.mouse === true;
    setRecording(recordingAfter(event.ev, releaseRecordingEscape !== null));
    sidecarBusy = busyAfter(event.ev, sidecarBusy);
    if (event.ev === "recording") {
      pillGain.reset();
      focusedApp = { exe: event.app ?? "", title: event.title ?? "" };
      // Each recording's window goes with its own words, however soon the next starts.
      recordingSeq += 1;
      recordings.push({
        id: recordingSeq,
        dictation: event.dictation ?? null,
        app: focusedApp,
        heard: null,
        discarded: false,
      });
      escArmedUntil = 0;
      keyHeldToTalk = heldToTalk(event.via, heldByButton);
      if (settings.dictationCleanup === "claude") rewriter.warm();
      readCaretEarly(focusedApp);
      // Read on his machine while he speaks; only the claude level sends it on, inside the clean-up's prompt.
      screenNow = [];
      const seq = recordingSeq;
      void sidecar
        ?.uiTree()
        .then((tree) => {
          if (seq === recordingSeq)
            screenNow = screenNames([tree.window ?? "", ...(tree.controls ?? [])]);
        })
        .catch(() => undefined);
      if (keptTimer !== null) clearTimeout(keptTimer);
      note = null;
      claimComposer(keyHeldToTalk ? "held" : "free");
      pressGate.want();
      startGhost();
    } else if (event.ev === "latched") {
      keyHeldToTalk = false;
      composer.mode("free");
      showDictation("Esc twice discards");
    } else if (event.ev === "transcribing") {
      composer.finish();
      showDictation("Writing it out", true);
    } else if (event.ev === "idle") {
      // Nothing came of it (too short, or stopped): no words will carry its window or its discard.
      ghost.stop();
      composer.cancel();
      takeRecording(recordings, event.dictation);
      // A key that "did not fire" is often one let go within 200 ms: the log tells the two apart.
      if (event.tap === true) input.onNote?.("dictation_dropped", { reason: "short_tap" });
      if (event.joined === true) input.onNote?.("dictation_dropped", { reason: "chord_joined" });
      if (event.discarded === true) input.onNote?.("dictation_dropped", { reason: "esc_held" });
      // A tap whose pill never showed ends with nothing on screen to take away.
      if (!pressGate.cancel()) showDictation(null);
    } else if (event.ev === "error") {
      ghost.stop();
      composer.cancel();
      pressGate.cancel();
      takeRecording(recordings, event.dictation);
      note = event.message;
      showDictation(null);
      toast.show({ kind: "error", message: event.message });
    } else if (event.ev === "paste_check") {
      // What the clipboard held at the chord and whether the target read it, for the turn log (no words).
      input.onNote?.("paste_check", { ...event });
    } else if (event.ev === "unread") {
      keepText(
        event.onClipboard === false ? "Not pasted" : "Nothing took the paste. On your clipboard",
        event.text,
      );
    } else if (event.ev === "text" && typeof event.wav === "string") {
      const wav = event.wav;
      // Its window and its discard are taken now, as it arrives, not when the cloud has recognised it.
      // Timed from when the sidecar's recording arrived, so the cloud round trip counts in release → paste.
      const carried = { ...withRecording(event), arrivedAt: Date.now() };
      // One at a time, so dictations arrive in the order he spoke them; the paste re-checks its window (pasteInto).
      cloudDictations = cloudDictations.then(async () => {
        // Read before recognition removes the file: a cloud dictation keeps its audio like a local one.
        const keptPcm = settings.keepVoice
          ? await NodeFS.promises
              .readFile(wav)
              .then(decodeWav)
              .catch(() => null)
          : null;
        return recogniseWav(wav, event.audioMs ?? 0).then(
          (text) =>
            onDictation({ ...carried, wav: null, text, ...(keptPcm === null ? {} : { keptPcm }) }),
          (error: unknown) =>
            onDictation({
              ...carried,
              wav: null,
              error: error instanceof Error ? error.message : String(error),
            }),
        );
      });
    } else if (event.ev === "text") {
      // A recording he keeps: read once and its file removed on every path below, kept only on a dictated row.
      const kept = event.audio ?? null;
      const heardPcm: Promise<Int16Array | null> =
        event.keptPcm !== undefined
          ? Promise.resolve(event.keptPcm)
          : kept === null
            ? Promise.resolve(null)
            : NodeFS.promises
                .readFile(kept)
                .then(decodeWav)
                .catch(() => null)
                .finally(() => void NodeFS.promises.rm(kept, { force: true }));
      // The sidecar drops an idle model after 10 minutes; this is what having it back cost.
      if ((event.loadMs ?? 0) > 0)
        input.onNote?.("speech_model_reload", { model: event.model ?? null, loadMs: event.loadMs });
      note = event.error ?? event.pasteError ?? note;
      const text = event.text ?? "";
      const outside = outsideLanguages(text, settings.languages);
      if (event.dictated === true && event.error === undefined && outside !== null) {
        keepText(`Heard as ${languageName(outside)}, not pasted`, text);
        return void heardOutside(outside);
      }
      // A hold that leaves nothing: why, so it is never a silent loss.
      if (event.dictated === true && (event.error !== undefined || text.trim() === ""))
        input.onNote?.("dictation_dropped", {
          reason: event.error === undefined ? "no_text" : "error",
          audioMs: event.audioMs ?? null,
          ...(event.error === undefined ? {} : { error: event.error }),
        });
      if (event.dictated === true && event.error === undefined) {
        const own = withRecording(event);
        if (own.unmatched === true) return keepText("Not pasted", text);
        // The voice path drops a lone breath the same way (core.ts DICTATION_FILLER); here it never reaches the buffer.
        if (isLoneBreath(text)) {
          input.onNote?.("dictation_dropped", { reason: "breath", chars: text.length });
          return showDictation(null);
        }
        dictationTimer = startDictationTiming(event);
        keyToBuffer(
          text,
          event.target,
          own.app ?? focusedApp,
          own.discarded === true,
          own.heard ?? null,
        );
        // The key dictation's recording joins the row keyToBuffer just opened, as a spoken one's does.
        const turnId = own.discarded === true ? null : openTurn;
        void heardPcm.then((pcm) => keepAudio(turnId, pcm));
        return;
      }
      if (text.length > 0) landed(text);
      if (event.pasted === false && text.length > 0) keepText("Not pasted", text);
      else {
        showDictation(null);
        if (text.length > 0) {
          pill.on({ type: "done", label: "Pasted" });
          // Only the length is kept: dictated words are his, not the conversation's (D31).
          input.conversation?.add({
            route: "dictation",
            said: `(dictated ${text.length} characters)`,
            reply: "",
          });
        }
      }
    }
  };

  // Both the wake capture and the dictation recorder follow the same choice.
  const onDeviceChange = () => {
    // Recorded files are not a device to follow, and switching would play them from the start.
    if ((process.env["BATON_TEST_WAV"] ?? "") !== "") return;
    void (async () => {
      const source = audio ?? (sidecar === null ? null : { listDevices: listSidecarDevices });
      if (source === null) return;
      const listed = await source.listDevices();
      if (listed.length === 0) return;
      const listChanged = JSON.stringify(listed) !== JSON.stringify(devices);
      devices = listed;
      const next = reconcileDeviceChange({
        current: choice,
        devices,
        preference: preference(),
        previous: choiceSummary(choice).mic,
      });
      if (next !== null) {
        choose(next);
        note = next.kind === "default" ? next.reason : null;
        configureDictation();
        speakerIdentity.reset();
        await loop?.switchDevice(choiceDeviceId(next));
        render();
      } else if (listChanged) {
        // A backup mic plugged in or out: the helper's list of mics to listen on follows.
        configureDictation();
        render();
      }
    })();
  };
  const listSidecarDevices = async (): Promise<ReadonlyArray<AudioInputDevice>> => {
    sidecarDevices = (await sidecar?.devices()) ?? [];
    return sidecarDevices.map((d) => ({
      deviceId: d.name,
      label: d.name,
      isDefault: d.isDefault === true,
    }));
  };

  // Read every few seconds, so a slow clip's line shows the load during it, not an average since the last one.
  const cpuLoad = createCpuLoad();
  const cpuReadings: Array<{ at: number; busy: number | null }> = [];
  setInterval(() => {
    cpuReadings.push({ at: Date.now(), busy: cpuLoad() });
    cpuReadings.splice(0, Math.max(0, cpuReadings.length - CPU_READINGS_KEPT));
  }, CPU_SAMPLE_MS).unref();
  let recogniserPid: number | null = null;
  let recognisedAt: RecogniserPriority = "normal";
  // fullscreen is read only while the resting bar is on; with it off, a game does not hold the priority back.
  const recogniserPriority = createRecogniserPriority({
    fullscreen: () => fullscreen,
    set: (level) => {
      if (recogniserPid === null || input.platform !== "win32") return;
      try {
        NodeOS.setPriority(
          recogniserPid,
          level === "above"
            ? NodeOS.constants.priority.PRIORITY_ABOVE_NORMAL
            : NodeOS.constants.priority.PRIORITY_NORMAL,
        );
      } catch {}
    },
  });
  /** The sidecar holds no key and no microphone until `configureDictation` gives it a model. */
  let resumeHooked = false;
  const startSidecar = async () => {
    if (binary === null || sidecar !== null) return;
    if (!resumeHooked) {
      resumeHooked = true;
      // After sleep the graphics card may have been reset: its session is read and warmed again before he dictates.
      Electron.powerMonitor.on("resume", () => sidecar?.resume());
    }
    resetCloudTmp();
    markPhase("dictation-sidecar-spawn:begin");
    sidecar = startDictationSidecar({
      binary,
      onEvent: onDictation,
      recognising: (pid, active) => {
        recogniserPid = pid;
        if (active) recognisedAt = recogniserPriority.begin();
        else recogniserPriority.end();
      },
      // A slow clip (0.1.61: 10 s for 1.3 s of audio) says how busy the machine was around then.
      onRecognised: (timing) =>
        input.onNote?.(
          "recognised",
          timing.inferMs > Math.max(SLOW_RECOGNITION_MS, timing.audioMs)
            ? {
                ...timing,
                cpuBusy: cpuReadings.at(-1)?.busy ?? null,
                // The machine before this clip went in: a high cpuBusy over a low baseline is recognition's own.
                cpuBefore: loadBefore(cpuReadings, Date.now() - timing.roundTripMs),
                cores: NodeOS.cpus().length,
                priority: recognisedAt,
              }
            : { ...timing, priority: recognisedAt },
        ),
    });
    markPhase("dictation-sidecar-spawn:end");
    dictionary = await importWispr({
      stateDir: input.stateDir,
      appData: input.env["APPDATA"],
      entries: readDictionary(input.stateDir, []),
      never,
      putSnippet: ({ cue, text }) => {
        if (!snippets.list().some((s) => s.cue === cue.toLowerCase()))
          snippets.put({ cue: cue.toLowerCase(), text, apps: [] });
      },
    });
    void loadStylePairs({ stateDir: input.stateDir, appData: input.env["APPDATA"] }).then(
      (pairs) => {
        styleIndex = makeStyleIndex([
          ...pairs,
          ...historyPairs(history?.list({ limit: 5_000 }) ?? []),
        ]);
      },
    );
    markPhase("dictation-devices:begin");
    devices = await listSidecarDevices();
    markPhase("dictation-devices:end");
    reselect();
    note =
      choice.kind === "default" && choice.reason.includes("not connected") ? choice.reason : null;
    configureDictation();
    render();
  };

  /** The target window's rect in DIP: the pill shows on its screen. Read by the pill as soon as it is built. */
  let workRect: Electron.Rectangle | null = null;
  /** Every Stop from this side (Esc, the pill, the Stop key or button, the Home page, "never mind") ends the same way. */
  const stopAll = (quiet: boolean) => {
    pill.on({ type: "dismissed" });
    loop?.activate("dismiss");
    input.onStop?.(quiet);
  };
  const dictationAction = (insert: boolean) =>
    dictatingByVoice
      ? endVoiceDictation(insert)
      : keyRecording()
        ? insert
          ? sidecar?.finish()
          : discardKeyDictation()
        : // Released and still being written out: ✕ still throws it away (✓ is what happens anyway).
          !insert && sidecarBusy
          ? discardNewest()
          : undefined;
  /** Which of our windows say their chat box has the keyboard, by webContents id. */
  const composerFocus = new Map<number, boolean>();
  Electron.ipcMain.on(BATON_COMPOSER_FOCUS_CHANNEL, (event, focused: unknown) => {
    if (Electron.BrowserWindow.fromWebContents(event.sender) === null) return;
    composerFocus.set(event.sender.id, focused === true);
  });
  const composer = createComposerDictation({
    target: () => {
      const window = Electron.BrowserWindow.getFocusedWindow();
      if (window === null || window.isDestroyed()) return null;
      const contents = window.webContents;
      return {
        send: (message) => contents.send(BATON_COMPOSER_DICTATION_CHANNEL, message),
        gone: () => contents.isDestroyed(),
        focused: () => composerFocus.get(contents.id) === true,
      };
    },
    onAction: dictationAction,
  });
  const claimComposer = (mode: "held" | "free") =>
    void composer.start(mode).then((claimed) => {
      if (claimed) ghost.stop();
      else pill.replay();
    });
  Electron.ipcMain.on(BATON_COMPOSER_DICTATION_REPLY_CHANNEL, (event, reply: unknown) => {
    // Our own windows only; preview panes load other people's pages.
    if (Electron.BrowserWindow.fromWebContents(event.sender) === null) return;
    if (typeof reply === "object" && reply !== null && "id" in reply && "type" in reply)
      composer.reply(reply as Parameters<typeof composer.reply>[0]);
  });
  const pillOptions: Parameters<typeof createVoicePill>[0] = {
    look: () => ({ motion: settings.motion, glass: settings.glass }),
    menuItems: () => [
      {
        label: Date.now() < settings.snoozeUntil ? "End the snooze" : "Snooze for an hour",
        click: () => toggleSnooze(),
      },
    ],
    ...((process.env["BATON_TEST_DIR"] ?? "") === ""
      ? {}
      : { captureDir: process.env["BATON_TEST_DIR"] as string }),
    cueGain: () => CUE_GAIN[settings.cues],
    cueGate: {
      // Never over his speech: wait up to 300 ms for him to stop, then drop the cue.
      quiet: async () => {
        for (let waited = 0; core?.hearingSpeech() === true; waited += 25) {
          if (waited >= CUE_WAIT_MS) return false;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        return true;
      },
      playing: (ms) => core?.playingCue(ms),
    },
    rest: () => restWanted(),
    edge: () => settings.pillEdge,
    stateDir: input.stateDir,
    holdEscape: input.holdEscape,
    onDictation: dictationAction,
    // ✕ | waveform | ✓ while the pill stays up on its own; a key or button held to talk ends on its release.
    voiceDictating: () => dictatingByVoice || (keyRecording() && !keyHeldToTalk),
    showWords: () => settings.showWords && !ghost.active(),
    frosted: () => settings.frosted && acrylicSupported(input.platform, NodeOS.release()),
    dictationMessage: () => dictationMessage,
    workArea: () => workRect,
    onDismiss: () => {
      // Spoken dictation ends only by its ✓, ✕, Esc or "stop dictation", never a stray click on the pill.
      if (dictatingByVoice || undoDiscard()) return;
      // A click on the pill while a key dictation records ends it, written out: never the pill gone and the mic on.
      if (moveDictation("pill_click") !== "none") return;
      stopAll(true);
    },
    ...(input.onWakeShown === undefined ? {} : { onShown: input.onWakeShown }),
    onChange: (turn) => input.onPillState?.(turn.phase),
    ...(input.onPillDrag === undefined ? {} : { onDrag: input.onPillDrag }),
    onMoving: () => render(),
    foreground: async () => {
      const app = await sidecar?.foreground();
      // The tray's hidden window, the taskbar and our own windows are not where he was working.
      const ours = NodePath.basename(process.execPath).toLowerCase();
      const exe = NodePath.basename(app?.exe ?? "").toLowerCase();
      const back =
        app?.window !== undefined && exe !== ours && exe !== "explorer.exe" ? app.window : null;
      input.onNote?.("pill_return", { exe: app?.exe ?? null, back: back !== null });
      return back;
    },
    focusWindow: (window) => void sidecar?.focusWindow(window).catch(() => undefined),
  };
  const pill: VoicePill & { readonly replay: () => void } = routePill(
    createVoicePill(pillOptions),
    composer,
  );
  let fullscreen = false;
  const restWanted = () =>
    restBarWanted({
      atRest: settings.pillAtRest,
      hiddenUntil: settings.pillHiddenUntil,
      hideInFullscreen: settings.hideInFullscreen,
      fullscreen,
      now: Date.now(),
    });
  if (restWanted()) pill.setRest(true);
  // The resting bar steps aside for a full-screen app or game, and for the hour he hid it.
  let barShown = restWanted();
  setInterval(() => {
    void (async () => {
      if (!settings.pillAtRest || sidecar === null) return;
      const app = await sidecar.foreground().catch(() => null);
      const rect = app?.rect == null ? null : Electron.screen.screenToDipRect(null, app.rect);
      fullscreen =
        app !== null &&
        isFullscreenWindow(
          { exe: app.exe, rect },
          Electron.screen.getAllDisplays().map((d) => d.bounds),
        );
      const want = restWanted();
      if (want !== barShown) {
        barShown = want;
        pill.setRest(want);
      }
    })().catch(() => undefined);
  }, 3_000).unref();
  let dictatingByVoice = false;
  /** The target window's rect is read in the background: only the newest read may move the pill. */
  let workReads = 0;
  const noteWork = (app: Promise<FocusedApp | null> | null) => {
    const read = (workReads += 1);
    void app?.then((found) => {
      if (read !== workReads) return;
      workRect = found?.rect == null ? null : Electron.screen.screenToDipRect(null, found.rect);
      pill.retarget();
    });
    return app;
  };
  const stateTurn = (next: VoiceState, target: string | null): TurnEvent | null => {
    const wasDictating = dictatingByVoice;
    dictatingByVoice = next === "dictation";
    if (dictatingByVoice !== wasDictating) {
      // The helper hands its key presses to this dictation while it runs, and a key recording ends as it starts.
      sidecar?.voice(dictatingByVoice);
      if (dictatingByVoice && keyRecording()) sidecar?.finish();
    }
    if (dictatingByVoice) {
      // Where he is as dictation starts; the turn that started it may have used the wake's.
      if (!wasDictating) {
        // Bound to the window it starts in; the words wait here and go there in one paste when it ends.
        const target = sidecar === null ? null : noteWork(sidecar.foreground().catch(() => null));
        dictationHold.start(target);
        void duck.start(settings.duckWhileDictating);
        collecting = true;
        discarding = false;
        dictationMessage = false;
        dictatingInto = null;
        undo = null;
        escArmedUntil = 0;
        // A line left from the last dictation (kept text, the offer, an undo) must not end on this one.
        if (keptTimer !== null) clearTimeout(keptTimer);
        keptTimer = null;
        startGhost();
        void target?.then((app) => {
          if (!dictatingByVoice || app == null || app.exe === "") return;
          dictatingInto = app.title.trim() || app.exe;
          pill.on({
            type: "dictating",
            caption: dictationCaption(dictatingInto, oneShot.pending().join(" ")),
          });
        });
      }
      pill.on({ type: "window_open" });
      return {
        type: "dictating",
        caption: dictationCaption(dictatingInto, oneShot.pending().join(" ")),
      };
    }
    if (wasDictating) {
      dictationHold.stop();
      void duck.stop();
      pill.on({ type: "dictating", caption: null });
      // The last chunk is still on its way through the core: flush once everything has landed.
      const ended = dictationHold.target();
      const clearIfMine = () => {
        if (dictationHold.target() === ended) dictationHold.setTarget(null);
      };
      if (collecting)
        void core
          ?.idle()
          .then(() => flushDictation(ended))
          .finally(clearIfMine);
      else clearIfMine();
    }
    if (next === "sleeping" || next === "direct_session") {
      if (!collecting) dictationHold.setTarget(null);
      return { type: "window_closed" };
    }
    if (next !== "command_window" && next !== "conversation") return null;
    pill.on({ type: "window_open" });
    return target === null ? null : { type: "target", name: `to ${target}` };
  };
  let voiceDictated = "";
  const onCoreEvent = (event: VoiceCoreEvent) => {
    const turn = ((): TurnEvent | null => {
      switch (event.type) {
        case "wake":
          // Read before anything of ours shows: what he had in front of him when he said the name.
          if (!dictatingByVoice && sidecar !== null)
            dictationHold.setTarget(noteWork(sidecar.foreground().catch(() => null)));
          // Before she answers, and after the target is read: he may have put headphones on since the last look.
          setImmediate(() => void output.refresh());
          return { type: "wake", word: wordName(event.word) };
        case "speech_end":
          return null;
        case "audio":
          lastPcm = event.pcm;
          return null;
        case "thinking":
          return { type: "thinking" };
        case "nothing":
          return { type: "failed", message: "Didn't catch that" };
        case "dropped":
          // Set aside over her voice: the pill keeps saying she is speaking.
          if (OVER_HER_VOICE.has(event.reason)) return null;
          // A wake nothing showed was him (no words, and not the name to the recogniser): gone without a sound.
          if (event.reason === "wake not heard") {
            pill.on({ type: "dismissed" }, { silent: true });
            return null;
          }
          return { type: event.reason === "wake not confirmed" ? "unconfirmed" : "resume" };
        case "stop_heard":
          input.onStop?.(false);
          return null;
        case "dismissed":
          // Said on its own, so no model was asked: the window is already closed.
          input.onStop?.(true);
          return { type: "dismissed" };
        case "transcript":
          // A spoken cancel takes the pill down at once, the way Esc does.
          if (
            !dictatingByVoice &&
            isCancelPhrase(
              stripWake(
                event.text,
                settings.wakeWords.map((w) => w.word),
              ),
            )
          ) {
            stopAll(true);
            return null;
          }
          if (!dictatingByVoice) {
            lastDictation = event.text;
            lastReply = null;
            keepAudio(
              (spokenTurnId = record({
                kind: "spoken",
                app: "",
                raw: event.text,
                cleaned: null,
                status: "none",
                delivery: null,
                seconds: lastPcm === null ? null : lastPcm.length / 16_000,
              })),
              lastPcm,
            );
          }
          return { type: "heard", text: event.text };
        case "error":
          return { type: "failed", message: event.message };
        case "state":
          return stateTurn(event.state, event.target);
        case "outcome": {
          // Words dictated by voice that nothing took are kept, as the hold key keeps them.
          if (event.outcome.kind === "dictated" && !event.outcome.inserted && voiceDictated !== "")
            keepText("Not pasted", voiceDictated);
          voiceDictated = "";
          const said = "reply" in event.outcome ? event.outcome.reply : "";
          if (said.length > 0 && !dictatingByVoice) {
            lastReply = said;
            if (spokenTurnId !== null) history?.update(spokenTurnId, { cleaned: said });
          }
          // The assistant reports its own end; everything else ends here, or with its speech.
          return "source" in event.outcome && event.outcome.source === "screen"
            ? null
            : { type: "finished" };
        }
        case "barge_in":
          input.onBargeIn?.();
          return null;
        case "barge_duck":
          input.onDuck?.(event.on);
          return null;
        case "effect":
          voiceDictated = event.effect.kind === "dictate" ? event.effect.text : "";
          // Only the name, so no turn will end the Thinking it showed: back to Listening for the command.
          if (event.effect.kind === "ignored" && event.effect.reason === "wake word only")
            return { type: "resume" };
          return null;
      }
    })();
    if (turn !== null) pill.on(turn);
  };

  const speechModel = () =>
    settings.speechModel === "fast" ? PARAKEET_FAST_MODEL : PARAKEET_MODEL;
  /** His own model's file once it has verified this session; the default whenever it is there and he has not picked. */
  let personalPath: string | null = null;
  const usePersonal = () =>
    personalPath !== null &&
    (settings.speechModel === "personal" ||
      (settings.speechModel === "v3" && settings.speechModelPicked === undefined));

  /** Fetched once a session, quietly, the first time the wake path wants a model dictation does not use. */
  let wakeModelFetched = false;
  /** This run downloaded dictation's model, so its first load reads a cold file and says nothing about the machine. */
  let speechModelDownloaded = false;
  /** A language only v3 knows, added while the machine had him on the fast model: offered with the switch. */
  let languageOffer: string | null = null;
  /** It would not load: dictation's model hears him for the rest of this session. */
  let wakeModelBroken = false;
  /**
   * The model file the wake path recognises with (LAT-1): the fast English one when he speaks only English, while
   * dictation keeps his choice. Null means dictation's, as it is until that model is on disk.
   */
  const wakeModelPath = (): string | null => {
    // Dictated words go through his chosen model on every entry point, so the same words come out the same.
    if (dictatingByVoice) return null;
    const model = wakeModelFor(settings.languages, settings.speechModel);
    if (model === null || wakeModelBroken) return null;
    if (modelPresent(modelsDir, model)) return NodePath.join(modelsDir, model.file);
    if (!wakeModelFetched) {
      wakeModelFetched = true;
      void ensureModel({ dir: modelsDir, model, onProgress: () => {}, attempts: 1 }).catch(
        (error: unknown) =>
          input.onNote?.("wake_model", {
            file: model.file,
            error: error instanceof Error ? error.message : String(error),
          }),
      );
    }
    return null;
  };
  const wakeModelFailed = (file: string, error: unknown) => {
    wakeModelBroken = true;
    input.onNote?.("wake_model", {
      file: NodePath.basename(file),
      error: error instanceof Error ? error.message : String(error),
      fallback: "dictation",
    });
  };
  /** The wake path's recogniser over the sidecar, on its own model (`wakeModelPath`). */
  const wakeStt = (on: DictationSidecar) =>
    makeSidecarStt(on, undefined, undefined, undefined, wakeModelPath, wakeModelFailed);

  /** One at a time; if the choice changed while it ran, the one now chosen is fetched next. */
  const loadSpeechModel = (): Promise<string> => {
    modelJob ??= (async () => {
      try {
        await startSidecar();
        for (;;) {
          if (usePersonal() && personalPath !== null) {
            parakeetPath = personalPath;
            note = null;
            configureDictation();
            render();
            return personalPath;
          }
          const model = speechModel();
          markPhase("speech-model-ensure:begin", { file: model.file });
          const path = await ensureModel({
            dir: modelsDir,
            model,
            onProgress: (fraction) => {
              if (fraction < 1) speechModelDownloaded = true;
              note =
                fraction < 1
                  ? `Downloading the speech model: ${Math.round(fraction * 100)}%`
                  : null;
              render();
            },
          }).finally(() => markPhase("speech-model-ensure:end"));
          if (model === speechModel() && !usePersonal()) {
            parakeetPath = path;
            note = null;
            configureDictation();
            render();
            return path;
          }
        }
      } catch (error) {
        note = `${error instanceof Error ? error.message : "The download failed."} Tray: Download speech model.`;
        render();
        throw error;
      } finally {
        modelJob = null;
      }
    })();
    return modelJob;
  };
  const requestDictation = () => void loadSpeechModel().catch(() => {});

  /** Each step of the voice start, in the turn log, so a start that stops says where. */
  const step = (name: string, fields: Readonly<Record<string, unknown>> = {}) =>
    input.onNote?.("voice_start", { step: name, ...fields });
  // The engine is set only when the warm-up ends: start, stop and relisten queue, so none acts on a half-built one.
  const lifecycle = serialQueue();
  const startNow = async () => {
    step("begin", {
      binary: binary !== null,
      enabled: settings.enabled,
      core: input.makeCore !== null,
      running: loop !== null,
    });
    if (binary === null) {
      note = "Voice is Windows only for now.";
      return render();
    }
    if (loop !== null || input.makeCore === null || !settings.enabled) return render();
    // The models first: if they are missing, no microphone is opened.
    await loadSpeechModel();
    // Turned off while loading or warming: stop before the mic opens.
    if (!settings.enabled) return render();
    step("speech-model-loaded", { sidecar: sidecar !== null });
    if (sidecar === null) throw new Error("Speech recognition is not installed.");
    markPhase("voice-core:begin");
    core = await input.makeCore({
      intent: voiceIntent,
      onReply: flash,
      settings: settings.quietSpeech
        ? {
            ...settings,
            wakeWords: settings.wakeWords.map((w) => ({
              ...w,
              threshold: quietThreshold(w.threshold),
            })),
          }
        : settings,
      stt: makeSidecarStt(
        sidecar,
        () => settings.languages,
        (code) => {
          heardOutside(code);
          pill.on({
            type: "failed",
            message: `Heard ${languageName(code)}, not one of your languages`,
          });
        },
        recognise,
        wakeModelPath,
        wakeModelFailed,
      ),
      // The stop listener hears the room while she talks over speakers: it never leaves this computer.
      stopStt: wakeStt(sidecar),
      onEvent: onCoreEvent,
      waitMs: () => clampWait(settings.waitMs),
      listening: () => ({
        commandWindowMs: LISTEN_AFTER_WAKE_MS.includes(settings.wakeListenMs)
          ? settings.wakeListenMs
          : 8_000,
        conversationMs: CONVERSATION_MS.includes(settings.conversationOpenMs)
          ? settings.conversationOpenMs
          : 30_000,
      }),
      echo: settings.voiceBargeIn ? echoGuard : undefined,
      speakerMode: () => speakerModeOf(settings.outputDevice, output.kind()),
      speaker: speakerIdentity,
      trustWake: (word, score) => wakeTrusted(settings.wakeWords, word, score),
      recording: () => sidecarBusy,
      verifyWake: async (pcm, word, score) => {
        // Null is "not checked" (switched off, or it failed): a wake, but not one the recogniser confirmed.
        if (!settings.verifyWake || word === null || sidecar === null) return null;
        try {
          const heard = await wakeStt(sidecar).transcribe(pcm);
          const ok = wakeWordHeard(heard, word, score);
          if (!ok) input.onNote?.("wake_check", { word, heard, score });
          return ok;
        } catch {
          return null;
        }
      },
      vocabulary: async (text) => {
        const word = parseAddToDictionary(text);
        if (word === null) return null;
        await changeVocabulary((entries, now) =>
          upsertEntry(entries, { phrase: word, replacement: null, source: "added" }, now),
        );
        return `Added ${word} to your dictionary.`;
      },
    });
    markPhase("voice-core:end");
    pushContext();
    contextTimer = setInterval(pushContext, CONTEXT_REFRESH_MS);
    step("core-made");
    // Models load on first use: do it now, before the microphone opens, so the first phrase is not lost.
    // Honest and live: how many of the two models are ready and how long it has taken, so a slow computer shows a
    // start that is working, not one that is stuck. The microphone opens only after this (or its generous limit).
    const warmStarted = Date.now();
    let modelsReady = 0;
    const showWarm = () => {
      const total = Math.round((Date.now() - warmStarted) / 1000);
      const reading =
        speechLoadMs > 0
          ? `, reading the speech model for ${Math.round(speechLoadMs / 1000)} s`
          : "";
      note = `Starting: loading the speech models (${modelsReady} of 2 ready${reading}, ${total} s).${total > 30 ? " This computer is busy; it is still working." : ""}`;
      render();
    };
    showWarm();
    const warmTicker = setInterval(showWarm, 1_000);
    const warming = core;
    const warmSidecar = sidecar;
    let modelRead = false;
    const warm = startWarmUp({
      pushFrame: (frame) => warming.pushAudio(frame),
      // Read the model first, on its own call that waits as long as the sidecar says it is loading, so the first real
      // phrase never sits behind a load that a fixed timer gave up on.
      transcribe: async (pcm) => {
        if (!modelRead) {
          modelRead = true;
          const loadMs = await warmSidecar.preload();
          step("speech-model-ready", { loadMs, sinceWarmStartMs: Date.now() - warmStarted });
          const slowStarts = slowStartsAfter(
            settings.slowStarts ?? 0,
            loadMs,
            speechModelDownloaded,
          );
          if (slowStarts !== (settings.slowStarts ?? 0)) save({ slowStarts });
          if (pickForMachine()) requestDictation();
          speechLoadMs = 0;
        }
        return wakeStt(warmSidecar).transcribe(pcm);
      },
      settled: () => warming.idle(),
      onStage: (ready) => {
        modelsReady = ready;
        showWarm();
      },
      onLonger: (seconds, ms) => step("warm-longer", { seconds, ms }),
    });
    const warmed = await warm.result.finally(() => clearInterval(warmTicker));
    note = null;
    // A slow computer: the microphone opens, what is said is kept, and it is heard the moment the models are ready.
    let startCore = core;
    if (!warmed) {
      const slow =
        "Still loading the speech models. What you say now is kept and heard as soon as they are ready.";
      note = slow;
      render();
      startCore = holdFramesUntil(core, warm.complete, 15_000, {
        first: () => step("first-audio-frame", { sinceWarmStartMs: Date.now() - warmStarted }),
        played: (frames) =>
          step("held-audio-played", { frames, sinceWarmStartMs: Date.now() - warmStarted }),
      });
      void warm.complete.then(() => {
        step("warm-complete", { sinceWarmStartMs: Date.now() - warmStarted });
        if (note === slow) {
          note = null;
          render();
        }
      });
    }
    step(warmed ? "warm-done" : "warm-timeout");
    // Turned off while warming: the core and its context timer are built, so they are taken down before the mic opens.
    if (!settings.enabled) return stopNow();
    // What Baton costs while nobody speaks, from the first minute (startup still settling) to five minutes in.
    for (const afterMs of [0, 4 * 60_000]) {
      setTimeout(() => {
        const before = process.cpuUsage();
        Electron.app.getAppMetrics();
        setTimeout(() => {
          const used = process.cpuUsage(before);
          const others = Electron.app
            .getAppMetrics()
            .filter((m) => m.type !== "Browser")
            .reduce((sum, m) => sum + m.cpu.percentCPUUsage, 0);
          step("idle-cpu", {
            sinceWarmMs: afterMs + 60_000,
            mainPct: Math.round((used.user + used.system) / 6_000) / 100,
            otherPct: Math.round(others * 100) / 100,
            state: core?.snapshot().state ?? "stopped",
          });
        }, 60_000).unref();
      }, afterMs).unref();
    }
    // With BATON_TEST_WAV set, recorded files stand in for the microphone; unset, nothing changes.
    const testSource = process.env["BATON_TEST_WAV"];
    audio =
      testSource !== undefined && testSource !== ""
        ? makeTestAudioInput({ source: testSource, onEvent: (event) => input.onTestAudio?.(event) })
        : makeSidecarAudioInput({
            binary,
            listDevices: listSidecarDevices,
            channelFor,
            // Back on the same mic if it was a hiccup, on the next one if it left.
            onLost: (reason, ranMs) => {
              recordFailures = ranMs >= HEALTHY_RUN_MS ? 1 : recordFailures + 1;
              const delay = restartDelayMs(recordFailures);
              note = `The microphone stopped${reason === null ? "" : ` (${reason})`}. Trying again in ${Math.round(delay / 1000)} s.`;
              pill.on({ type: "trouble", message: "Reconnecting your mic" });
              render();
              setTimeout(() => void restart(), delay);
            },
          });
    step("audio-created", { test: testSource !== undefined && testSource !== "" });
    pill.warm();
    devices = await within(audio.listDevices(), DEVICE_ANSWER_MS, "The microphone list");
    step("devices-listed", { devices: devices.length });
    reselect();
    note = choice.kind === "default" && settings.pinnedLabel !== null ? choice.reason : null;
    const opening = startVoiceLoop({
      audio,
      // Hold, toggle, the setup's test and the tray all record through the sidecar: no wake or turn while they do.
      core: silenceWhile(
        boostCore(startCore, () => settings.quietSpeech),
        () => releaseRecordingEscape !== null,
      ),
      deviceId: choiceDeviceId(choice),
      onState: (next) => {
        state = next;
        render();
      },
      onLevel: (frame) => {
        const level = frameLevel(frame);
        micNow = level;
        pill.micLevel(level, pillGain(level), frame);
        silence.feed(level, Date.now());
        // The voice core hears nothing while the helper records: a spoken stop or cancel is heard here instead.
        if (keyRecording()) hearKeyCommand(frame, level);
        else commandClips.reset();
        if (levelTest !== null) levelTest.peak = Math.max(levelTest.peak, level);
        voiceId.push(frame);
      },
      // The core's router has already sent the words on; this is the HUD's line.
      onUtterance: (utterance) => flash(utteranceCaption(utterance)),
    });
    loop = await within(opening, DEVICE_ANSWER_MS, "The microphone").catch((error: unknown) => {
      // Given up on: if it opens after all, it is closed rather than left listening unseen.
      void opening.then(
        (late) => late.stop(),
        () => undefined,
      );
      throw error;
    });
    step("loop-started");
    // The wake mic now feeds the waveform: the recording stops sending its own audio.
    configureDictation();
    // Not at his first wake: a cold start then cost the first turn 27 s (0.1.68).
    if (launchWarm === null)
      launchWarm = setTimeout(() => {
        launchWarm = null;
        if (loop !== null) input.warmAssistant?.();
      }, LAUNCH_WARM_MS);
  };
  /** A start that failed part-way leaves nothing behind: what it built is taken down. */
  const startOrClean = () =>
    startNow().catch(async (error: unknown) => {
      if (loop === null) await stopNow();
      throw error;
    });
  const start = () => lifecycle(startOrClean);
  let launchWarm: ReturnType<typeof setTimeout> | null = null;

  const stop = () => lifecycle(stopNow);
  const stopNow = async () => {
    if (launchWarm !== null) clearTimeout(launchWarm);
    launchWarm = null;
    // Off mid-dictation: Esc is his again and the old window is forgotten, so no later wake acts there.
    if (dictatingByVoice) stateTurn("sleeping", null);
    dictationHold.clear();
    await loop?.stop();
    if (loop === null) core?.dispose();
    loop = null;
    configureDictation();
    core = null;
    if (contextTimer !== null) clearInterval(contextTimer);
    contextTimer = null;
    await audio?.stop();
    audio = null;
    state = "sleeping";
    render();
  };

  /** The Check area (D134). Results are kept until he runs them again; none run on their own. */
  let checks: ReadonlyArray<CheckResult> | null = null;
  let micPeak: number | null = null;
  let levelTest: { peak: number } | null = null;
  let micNow = 0;

  const gather = async (): Promise<CheckInput> => {
    const assets = input.voiceAssets?.(settings.modelsDir);
    const wakeModels = assets === undefined ? null : resolveWakeModels(assets, settings.wakeWords);
    const model = speechModel();
    const present = modelPresent(modelsDir, model);
    let freeMb: number | null = null;
    try {
      const fsStat = NodeFS.statfsSync(NodeFS.existsSync(modelsDir) ? modelsDir : input.stateDir);
      freeMb = (fsStat.bavail * fsStat.bsize) / 1e6;
    } catch {
      freeMb = null;
    }
    return {
      mic: {
        devices: realDevices(devices).length,
        using: choice.kind === "pinned" ? choice.device.label : null,
        listening: loop !== null,
        trouble: note,
      },
      micPeak,
      wake: {
        enabled: settings.wakeWords.filter((w) => w.enabled).map((w) => w.word),
        missing: wakeModels?.missing ?? [],
        coreLoaded: loop !== null,
        baseModelsMissing: assets === undefined ? 0 : missingVoiceAssets(assets).length,
      },
      speech: {
        present,
        label: usePersonal()
          ? "Personal"
          : settings.speechModel === "fast"
            ? "Parakeet Fast"
            : "Parakeet v3",
        sizeMb: Math.round(model.size / 1e6),
      },
      signIn: (await input.extras?.signIn().catch(() => null)) ?? null,
      screenAccess:
        input.platform === "darwin"
          ? Electron.systemPreferences.getMediaAccessStatus("screen")
          : null,
      disk: { freeMb, neededMb: present ? 0 : model.size / 1e6 },
    };
  };
  const runAllChecks = async () => {
    checks = runChecks(await gather());
    home.refresh();
  };
  /** Four seconds of the stream that is already open, started by his press and never before. */
  const testMic = () => {
    if (loop === null || levelTest !== null) return;
    levelTest = { peak: 0 };
    home.refresh();
    setTimeout(() => {
      micPeak = levelTest?.peak ?? 0;
      levelTest = null;
      void runAllChecks();
    }, MIC_TEST_MS).unref();
  };

  const claudeDir = () =>
    process.env["CLAUDE_CONFIG_DIR"] ?? NodePath.join(Electron.app.getPath("home"), ".claude");
  const harnessItems = cachedFor(3_000, () =>
    readInventory({
      claudeDir: claudeDir(),
      claudeJson: NodePath.join(Electron.app.getPath("home"), ".claude.json"),
      codexDir: NodePath.join(Electron.app.getPath("home"), ".codex"),
    }),
  );
  /** A skill from a web address: fetched, reviewed, and filed only after he says yes on the card. */
  const addSkillFrom = async (address: string): Promise<void> => {
    const tell = (text: string) => input.extras?.notice(text);
    const draft = draftPath(input.stateDir, address);
    const target =
      draft === null
        ? normalizeSkillUrl(address)
        : { url: `file:///${draft}`, host: "this computer (your draft)" };
    if (target === null)
      return tell(
        "Use an https address, a GitHub page of a SKILL.md, or the path of one of your drafts.",
      );
    try {
      const text =
        draft === null ? await fetchSkillText(target.url) : NodeFS.readFileSync(draft, "utf8");
      const parsed = parseSkill(
        text,
        draft === null ? nameFromUrl(target.url) : NodePath.basename(NodePath.dirname(draft)),
      );
      if (!parsed.ok) return tell(`Not added: ${parsed.why}`);
      const card = reviewCard({
        host: target.host,
        skill: parsed.skill,
        findings: reviewSkill(parsed.skill, text),
        exists: skillExists(claudeDir(), parsed.skill.name),
      });
      const answer = await (input.extras?.ask({
        ...card,
        buttons: ["Add it", "Cancel"],
        cancel: 1,
        expiresMs: 5 * 60_000,
      }) ?? Promise.resolve(1));
      if (answer !== 0) return tell("Not added.");
      installSkill(claudeDir(), parsed.skill.name, text);
      forgetFiles();
      home.refresh();
      tell(`Added the skill ${parsed.skill.name}. Claude Code reads it in new sessions.`);
    } catch (error) {
      tell(
        `Not added: ${error instanceof Error ? error.message : "the address could not be read"}`,
      );
    }
  };
  /** A calendar, mail or chat server: the card shows the exact command, and `claude mcp add` runs only after his yes. */
  const addConnector = async (kind: ConnectorKind, address: string): Promise<void> => {
    const tell = (text: string) => input.extras?.notice(text);
    const plan = parseConnectorSource(kind, address);
    if (!plan.ok) return tell(`Not connected: ${plan.why}`);
    const exists = harnessItems().some((i) => i.kind === "mcp" && i.name === plan.name);
    const card = reviewConnector(kind, plan, exists);
    const answer = await (input.extras?.ask({
      ...card,
      buttons: ["Connect", "Cancel"],
      cancel: 1,
      expiresMs: 5 * 60_000,
    }) ?? Promise.resolve(1));
    if (answer !== 0) return tell("Not connected.");
    try {
      await new Promise<void>((resolve, reject) =>
        NodeChildProcess.execFile(
          settings.claudeBinary,
          [...plan.argv],
          { timeout: 60_000, windowsHide: true },
          (error, _stdout, stderr) =>
            error === null
              ? resolve()
              : reject(new Error(stderr.trim().split("\n").at(-1) ?? error.message)),
        ),
      );
      forgetFiles();
      harnessItems.reset();
      home.refresh();
      tell(
        `Connected ${CONNECTOR_INFO[kind].label.toLowerCase()} (${plan.name}). Claude Code signs you in the first time it uses it.`,
      );
    } catch (error) {
      tell(
        `Not connected: ${error instanceof Error ? error.message : "Claude Code did not accept it"}`,
      );
    }
  };
  const notes = createNotesStore(NodePath.join(input.stateDir, "memory"));
  const vaultState = vaultFor(input.stateDir);
  const vaultTab = createVaultTab({
    vault: vaultState.vault,
    hello: (message) => windowsHello(message, input.platform),
    clipboard: {
      read: () => Electron.clipboard.readText(),
      write: (t) => Electron.clipboard.writeText(t),
      clear: () => Electron.clipboard.clear(),
    },
    audit: vaultState.audit,
    readAudit: () => {
      try {
        return NodeFS.readFileSync(vaultState.auditFile, "utf8")
          .split("\n")
          .filter((l) => l !== "");
      } catch {
        return [];
      }
    },
    stateDir: input.stateDir,
    refresh: () => home.refresh(),
    saveRecovery: async (key) => {
      const r = await Electron.dialog.showSaveDialog({
        title: "Save the Tessaya recovery key",
        defaultPath: "tessaya-recovery-key.txt",
      });
      if (r.canceled || r.filePath === undefined) return null;
      NodeFS.writeFileSync(
        r.filePath,
        `Tessaya vault recovery key\n\n${key}\n\nIt is the only way in if the passphrase is forgotten. Keep it off this computer.\n`,
        { mode: 0o600 },
      );
      return r.filePath;
    },
    printRecovery: async (key) => {
      const win = new Electron.BrowserWindow({ show: false });
      try {
        const page = `<body style="font:16px sans-serif"><h2>Tessaya vault recovery key</h2><p style="font:20px monospace">${key}</p><p>It is the only way in if the passphrase is forgotten.</p>`;
        await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`);
        return await new Promise<boolean>((resolve) =>
          win.webContents.print({}, (ok) => resolve(ok)),
        );
      } finally {
        win.destroy();
      }
    },
    reveal: (file) => Electron.shell.showItemInFolder(file),
  });
  const memoryTab = createMemoryTab({
    call: (op, args) =>
      requestKept({ kind: "memory", op: op as BatonMemoryBridgeRequest["op"], args }),
    sync: createMemorySync({
      file: NodePath.join(input.stateDir, "baton-memory.json"),
      call: (op, args) =>
        requestKept({ kind: "memory", op: op as BatonMemoryBridgeRequest["op"], args }),
    }),
    notes,
    stateDir: input.stateDir,
    refresh: () => home.refresh(),
    reveal: (file) => Electron.shell.showItemInFolder(file),
  });
  const privateTab =
    input.privateMemory === undefined
      ? null
      : createPrivateTab({
          memory: input.privateMemory,
          voices: () =>
            voiceId
              .profiles()
              .filter((p) => p.kind === "saved")
              .map((p) => ({ id: p.id, name: p.name })),
          hello: (message) => windowsHello(message, input.platform),
          clipboard: {
            read: () => Electron.clipboard.readText(),
            write: (t) => Electron.clipboard.writeText(t),
            clear: () => Electron.clipboard.clear(),
          },
          saveFile: async (name, contents) => {
            const r = await Electron.dialog.showSaveDialog({
              defaultPath: NodePath.join(Electron.app.getPath("documents"), name),
            });
            if (r.canceled || r.filePath === undefined) return null;
            NodeFS.writeFileSync(r.filePath, contents, { mode: 0o600 });
            return r.filePath;
          },
          everydayCount: () => memoryTab.count(),
          refresh: () => home.refresh(),
        });
  const cachedPack = cachedFor(3_000, () => [
    ...packControls(NodePath.join(input.stateDir, PACK_FOLDER)),
    ...rosterControls(NodePath.join(input.stateDir, PACK_FOLDER)),
  ]);
  /** Files he edits by hand or through a row here: forget what was read, so the next draw is true. */
  const forgetFiles = () => {
    harnessItems.reset();
    cachedPack.reset();
  };
  /** The job cards as the window last read them; null until the Jobs or Approvals tab has been opened once. */
  let jobsCache: ReadonlyArray<BatonJob> | null = null;
  let jobsError: string | null = null;
  let jobsLoading = false;
  /** Opening the Jobs or Approvals tab asks for them, and they are kept fresh from then on. */
  let jobsWanted = false;
  const refreshJobs = async () => {
    if (jobsLoading) return;
    jobsLoading = true;
    try {
      const value = (await requestKept({ kind: "job", op: "list", args: {} })) as {
        jobs?: ReadonlyArray<BatonJob>;
      } | null;
      const next = value?.jobs ?? [];
      jobsError = null;
      if (JSON.stringify(next) !== JSON.stringify(jobsCache)) jobsCache = next;
    } catch (error) {
      jobsError = error instanceof Error ? error.message : String(error);
    } finally {
      jobsLoading = false;
      home.refresh();
    }
  };
  const wantJobs = () => {
    jobsWanted = true;
    void refreshJobs();
  };
  // Jobs, the watch and memory reach this machine's server directly; without that door, only while T3's window
  // is up, since asking through it would bring back a window he closed.
  const serverReachable = () =>
    input.direct !== undefined || (mainContents !== null && !mainContents.isDestroyed());
  setInterval(() => {
    if (jobsWanted && serverReachable()) void refreshJobs();
  }, JOBS_REFRESH_MS).unref();

  // Unprompted lines (D146): only once T3's window exists (nothing is opened for this), never in quiet hours.
  let announced: ReadonlySet<string> = new Set();
  let plansTold: ReadonlySet<string> = new Set();
  const watchFindings = async () =>
    (
      (await requestKept({ kind: "job", op: "watch", args: {} })) as {
        findings?: ReadonlyArray<WatchFinding>;
      } | null
    )?.findings ?? [];
  const toggleSnooze = () =>
    save({ snoozeUntil: Date.now() < settings.snoozeUntil ? 0 : Date.now() + HIDE_FOR_MS });
  const silenced = (at: Date) => isSilenced(settings, at);
  const checkAttention = async () => {
    // With the direct door the watch is read from this machine's server, so T3's window need not be up.
    if (!serverReachable()) return;
    const at = new Date();
    if (silenced(at)) return;
    const found = await watchFindings();
    if (settings.noticeMode !== "off") {
      const { fresh, next } = freshFindings(found, announced);
      announced = next;
      const line = noticeLine(fresh);
      if (line !== null) input.extras?.announce(line, settings.noticeMode === "spoken");
      const plans = (await requestKept({ kind: "job", op: "list", args: {} })) as {
        jobs?: ReadonlyArray<BatonJob>;
      } | null;
      const ready = planReadyLine(plans?.jobs ?? [], plansTold);
      plansTold = ready.next;
      if (ready.line !== null) input.extras?.announce(ready.line, settings.noticeMode === "spoken");
    }
  };
  setInterval(() => void checkAttention().catch(() => undefined), ATTENTION_MS).unref();

  // Initiative (D149): offers as cards. A Yes starts a read-only plan-first job or notes a commitment.
  let ciCache: { at: number; runs: ReadonlyArray<CiRun> } = { at: 0, runs: [] };
  const ciRuns = async (): Promise<ReadonlyArray<CiRun>> => {
    if (settings.ciRepos.length === 0) return [];
    if (Date.now() - ciCache.at > CI_REFRESH_MS) {
      ciCache = { at: Date.now(), runs: await readCiRuns(settings.ciRepos) };
    }
    return ciCache.runs;
  };
  const anomalies = createAnomalySource({ dir: input.stateDir, now: () => Date.now() });
  /** A read-only look in its own thread. Unattended, it also starts at once (a read-only job can do no harm). */
  const startLook = async (offer: Trigger, unattended: boolean): Promise<string> => {
    const yes = offer.yes;
    if (yes.kind !== "job") return "Nothing to start.";
    const project =
      yes.repo !== undefined
        ? yes.repo.split("/")[1]
        : input.sessions?.rows().find((r) => r.key === yes.sessionId)?.project;
    if (project === undefined || project === "") {
      commitments.add({
        text: `Look into: ${offer.title}`.slice(0, 300),
        source: "offer",
        ...(yes.sessionId === undefined ? {} : { ref: yes.sessionId }),
      });
      return "I could not tell which project that is, so I noted it to look into.";
    }
    const started = (await requestKept({
      kind: "job",
      op: "start",
      args: {
        title: `Look into: ${offer.title}`.slice(0, 120),
        goal: yes.goal,
        project,
        folders: [],
        tools: ["read"],
      },
    })) as { terms?: { workSessionId?: string } | null } | null;
    const id = started?.terms?.workSessionId;
    if (unattended && id !== undefined) {
      await requestKept({ kind: "job", op: "grant", args: { id, channel: "start" } });
      return "Started a read-only look; the findings will show on the Now page.";
    }
    return "Started a read-only look in its own thread. Nothing changes until you agree to a plan.";
  };
  const initiative = createInitiative({
    dir: input.stateDir,
    now: () => Date.now(),
    hour: () => new Date().getHours(),
    policy: () =>
      settings.initiativeMode === "off" || silenced(new Date()) || !serverReachable()
        ? null
        : {
            ...DEFAULT_POLICY,
            quietHours: settings.quietHours,
            maxPerHour: Math.max(1, Math.min(10, Math.floor(settings.initiativePerHour))),
            // Someone typing right now is the costly moment to interrupt.
            interruptionCost: Electron.powerMonitor.getSystemIdleTime() < 3 ? 15 : 0,
          },
    gather: async () => [
      ...triggersFromFindings(await watchFindings()),
      ...triggersFromCommitments(commitments.list(), Date.now()),
      ...triggersFromCi(await ciRuns(), Date.now()),
      ...anomalies.triggers(
        (jobsCache ?? []).map((j) => ({ id: j.workSessionId, title: j.title, group: j.group })),
        await ciRuns(),
      ),
    ],
    present: async (offer) => {
      if (settings.initiativeMode === "spoken") input.extras?.announce(offer.offer, true);
      const index = await (input.extras?.ask({
        title: "Tessaya",
        detail: offer.offer,
        buttons: ["Yes", "Later", "Never"],
        cancel: 1,
        armMs: 1_500,
        expiresMs: 5 * 60_000,
      }) ?? Promise.resolve(1));
      return index === 0 ? "yes" : index === 2 ? "never" : "later";
    },
    act: async (offer) => {
      const yes = offer.yes;
      if (yes.kind === "done") {
        commitments.close(yes.commitmentId, "done");
        return "Marked done.";
      }
      if (yes.kind === "commitment") {
        commitments.add({ text: yes.text, source: "offer" });
        return "I will keep track of it.";
      }
      return startLook(offer, false);
    },
    tell: (text) => input.extras?.announce(text, false),
  });
  setInterval(() => void initiative.tick().catch(() => undefined), INITIATIVE_MS).unref();

  // Crash recovery: a heartbeat file every half minute, and jobs a restart cut off are marked and offered a Continue.
  const recovery = createRecoveryFiles(input.logDir, input.stateDir);
  const previousBeat = recovery.readHeartbeat();
  let interruptedNow: ReadonlyArray<Interrupted> = recovery.readMarks();
  let recovered = false;
  const beatNow = (running: boolean): void => {
    const cards = (jobsCache ?? []).map((j) => ({
      id: j.workSessionId,
      title: j.title,
      group: j.group,
    }));
    if (jobsCache !== null) {
      let marks = recovery.readMarks();
      if (!recovered) {
        recovered = true;
        marks = mergeMarks(marks, findInterrupted(previousBeat, cards, new Date().toISOString()));
      }
      interruptedNow = stillInterrupted(marks, cards);
      recovery.writeMarks(interruptedNow);
    }
    recovery.writeHeartbeat({
      at: new Date().toISOString(),
      pid: process.pid,
      version: input.appVersion,
      running,
      state: hudView(state).label,
      // Before jobs have loaded, the last known list is carried over so a second crash loses nothing.
      jobsRunning:
        jobsCache === null
          ? (previousBeat?.jobsRunning ?? [])
          : cards.filter((c) => c.group === "running").map((c) => ({ id: c.id, title: c.title })),
      approvalsWaiting: buildApprovals({
        jobs: jobsCache ?? [],
        sessions: input.sessions?.rows() ?? [],
      }).length,
    });
  };
  setInterval(() => beatNow(true), 30_000).unref();
  setTimeout(() => beatNow(true), 10_000).unref();
  Electron.app.on("will-quit", () => beatNow(false));

  // Standing jobs (each off until he turns it on in Trust, the brief on as it was): counted, logged in
  // the Record under their owner, and never send, post or spend. Rules and schedules run on the server.
  /** His own standing jobs (KIRO-1): saved here only after his yes (the card) or as an off proposal (a device). */
  const userJobOp = (
    op: "user_job_save" | "user_job_update" | "user_job_delete",
    args: Readonly<Record<string, unknown>>,
    /** From the Trust page, where he sees it: the only way a proposal is switched on. */
    fromTrust = false,
  ): string => {
    const id = typeof args["id"] === "string" ? args["id"] : "";
    if (op === "user_job_save") {
      const draft = args["job"] as Omit<UserJob, "on" | "proposed" | "id" | "from">;
      const proposed = args["proposed"] === true;
      const newId = userJobStore.nextId();
      const added = userJobStore.add({
        ...draft,
        id: newId,
        on: !proposed,
        proposed,
        from: proposed ? "device" : "him",
      });
      if (!added.ok) return `Nothing was saved: ${added.why}`;
      if (!proposed)
        return `Saved as ${newId}, ${whenText(draft.trigger)}. He can switch it off or remove it on the Trust page.`;
      // Every proposal is on the Record, whoever made it.
      void input
        .direct?.("baton.record.append", {
          kind: "standing_job",
          actor: "a paired device or agent",
          subject: draft.title,
          outcome: "proposed",
          detail: `${whenText(draft.trigger)}: ${draft.instruction}`.slice(0, 2_000),
        })
        .catch(() => undefined);
      return `Proposed as ${newId}: it is off until he approves it on his Trust page. Say so; it does not run yet.`;
    }
    if (op === "user_job_delete")
      return userJobStore.remove(id) ? `Removed ${id}.` : `There is no job ${id} of his.`;
    const patch = {
      ...(typeof args["on"] === "boolean" ? { on: args["on"] } : {}),
      ...(typeof args["instruction"] === "string" && args["instruction"].trim() !== ""
        ? { instruction: args["instruction"].trim().slice(0, 1_000) }
        : {}),
    };
    const next = userJobStore.update(id, patch, { approve: fromTrust });
    if (next === null) return `There is no job ${id} of his.`;
    if ("refused" in next) return next.refused;
    return `${next.title} is ${next.on ? "on" : "off"}: ${next.instruction}`;
  };
  const standingStore = createStandingStore(input.stateDir, () => {
    // The old switch's last brief day (`y-m-d`, local), so an upgrade after six does not brief twice.
    const old = (settings as { briefDay?: unknown }).briefDay;
    const at = new Date();
    return {
      briefOn: settings.briefMode !== "off",
      briefGivenOn:
        old === `${at.getFullYear()}-${at.getMonth() + 1}-${at.getDate()}`
          ? at.toDateString()
          : null,
    };
  });
  const ownerOf = (job: StandingJobDef) => {
    const personas = readPack(NodePath.join(input.stateDir, PACK_FOLDER)).personas;
    return personas.find((p) => p.id === job.owner) ?? personas.find((p) => p.lead) ?? personas[0]!;
  };
  const leadName = () => ownerOf({ ...BUILT_INS[0]!, owner: "executive" }).name;
  /** His rules, read from this machine's server for the Trust page; none when it cannot be reached. */
  let rulesCache: ReadonlyArray<OrchestrationRuleWithFirings> = [];
  const refreshRules = async () => {
    const value = (await input
      .direct?.("fabric.orchestration.rule.list", { includeDisabled: true })
      .catch(() => null)) as { rules?: ReadonlyArray<OrchestrationRuleWithFirings> } | null;
    if (value?.rules !== undefined) rulesCache = value.rules;
  };
  let standingRunning = false;
  /** One pass at a time: the two-minute tick and "Run now" must not both run a job for the same thing. */
  const standingTick = async (): Promise<void> => {
    if (standingRunning) return;
    standingRunning = true;
    try {
      await standingPass();
    } finally {
      standingRunning = false;
    }
  };
  /** When each waiting session's wait began, kept while it waits: the wait's id stays the same from pass to pass. */
  const waitStarts = new Map<string, number>();
  let cappedNoted = "";
  /**
   * His own jobs that are due (KIRO-1), one at a time, each as an unattended turn judged by standingVerdict. The whole
   * pass has 15 minutes, so the built-ins after it are never starved; each run has the standing-run limit.
   */
  const userJobPass = async (signals: UserJobSignals): Promise<void> => {
    const runStanding = input.extras?.runStanding;
    if (runStanding === undefined) return;
    const { due, capped } = dueUserJobs({
      jobs: userJobStore.list(),
      runs: userJobStore.runs(),
      now: new Date(),
      startedAt: new Date(voiceStartedAt),
      signals,
    });
    const day = new Date().toDateString();
    if (capped.length > 0 && cappedNoted !== day) {
      cappedNoted = day;
      input.extras?.notice(
        "Some of your own standing jobs reached today's limit of runs; they start again tomorrow.",
      );
      input.onNote?.("user_job_capped", { capped });
    }
    const pass = new AbortController();
    const budget = setTimeout(() => pass.abort(), 15 * 60_000);
    try {
      for (const { job, key } of due) {
        if (pass.signal.aborted) break;
        const owner = ownerOf({ ...BUILT_INS[0]!, owner: job.owner });
        const result = await runStanding(
          {
            title: job.title,
            instruction: job.instruction,
            from: job.from,
            tools: job.tools,
            judge: (tool) => standingVerdict(tool, owner),
            persona: owner,
          },
          pass.signal,
          STANDING_RUN_TIMEOUT_MS,
        );
        const at = Date.now();
        userJobStore.saveRun({
          id: job.id,
          key,
          at,
          status: result.status,
          text: result.text.slice(0, 2_000),
          ...(result.model === undefined ? {} : { model: result.model }),
          ...(result.turns === undefined ? {} : { turns: result.turns }),
        });
        // The answer is on screen and in the Record; aloud only that it is done, so read data never speaks for it.
        if (result.status === "ok")
          input.extras?.announce(
            `${job.title}: ${result.text}`,
            !silenced(new Date(at)),
            `${job.title} is done; it's on screen.`,
          );
        input.onNote?.("user_job_run", { id: job.id, status: result.status });
        void input
          .direct?.("baton.record.append", {
            kind: "standing_job",
            actor: owner.name,
            subject: job.title,
            outcome:
              result.status === "ok" ? "ran" : result.status === "cancelled" ? "held" : "failed",
            detail: `${result.text.slice(0, 1_900)}${usedLine(result.model, result.turns)}`,
          })
          .catch(() => undefined);
        // He stopped it or took the turn: the rest of this pass waits for the next tick.
        if (result.status === "cancelled") break;
      }
    } finally {
      clearTimeout(budget);
    }
    if (due.length > 0) render();
  };
  const standingPass = async (): Promise<void> => {
    void refreshRules();
    const state = standingStore.load();
    const builtInsOn = Object.values(state.on).some(Boolean);
    const userJobsOn = userJobStore.list().some((j) => j.on && !j.proposed);
    if (!builtInsOn && !userJobsOn) return;
    // Jobs and the watch come from this machine's server, so T3's window need not be up (nor is it opened).
    if (!serverReachable()) return;
    const now = Date.now();
    const jobs =
      (
        (await requestKept({ kind: "job", op: "list", args: {} })) as {
          jobs?: ReadonlyArray<BatonJob>;
        } | null
      )?.jobs ?? [];
    const findings = await watchFindings();
    const ci = await ciRuns();
    const waiting = findings.filter((f) => f.kind === "unanswered");
    for (const id of waitStarts.keys())
      if (!waiting.some((f) => f.workSessionId === id)) waitStarts.delete(id);
    for (const f of waiting)
      if (!waitStarts.has(f.workSessionId))
        waitStarts.set(f.workSessionId, now - f.minutes * 60_000);
    await userJobPass({
      waiting: waiting.map((f) => ({
        id: f.workSessionId,
        since: waitStarts.get(f.workSessionId)!,
        minutes: f.minutes,
      })),
      failedBuilds: triggersFromCi(ci, now).map((t) => t.id),
      finishedJobs: jobs
        .filter(
          (j) =>
            j.group === "done" &&
            j.phase === "approved" &&
            now - Date.parse(j.lastActivityAt) < 2 * INITIATIVE_MS,
        )
        .map((j) => j.workSessionId),
    });
    if (!builtInsOn) return;
    const result = await runStandingJobs(
      {
        state,
        now,
        day: new Date(now).toDateString(),
        hour: new Date(now).getHours(),
        quiet: silenced(new Date(now)),
        refusal: (job) => {
          const owner = ownerOf(job);
          const verdict = standingVerdict(job.tool, owner);
          return verdict.verdict === "allow" ? null : verdict.why;
        },
        findings,
        ci,
        jobs,
      },
      {
        look: (offer, signal) =>
          signal.aborted ? Promise.reject(new Error("Ended.")) : startLook(offer, true),
        // The lead's standing job: kept on the Now page, and shown or said as the brief setting says.
        brief: async (signal) => {
          const since =
            standingStore
              .load()
              .runs.findLast((r) => r.id === "morning_brief" && r.outcome === "ran")?.at ??
            now - 24 * 3_600_000;
          const text = morningBrief({
            jobs,
            findings,
            // What the server's watch saw since the last brief that ran, with no desktop up too (D1).
            earlier: findingsFromRecord(await recordNotes("watch", 100, since)),
            since,
            now,
            guide: await guideNotes(),
            extra: briefExtra(),
          });
          if (settings.briefMode !== "off" && !signal.aborted)
            input.extras?.announce(text, settings.briefMode === "spoken");
          return text;
        },
        say: (text) => input.extras?.announce(text, true),
        learn: async (signal) => {
          const learn = input.extras?.learnNightly;
          if (signal.aborted) throw new Error("Ended.");
          if (learn === undefined || input.direct === undefined)
            throw new Error("Learning is not available here.");
          const value = (await input.direct("baton.record.list", {
            kind: "turn_trace",
            since: new Date(now - 86_400_000).toISOString(),
            limit: 500,
          })) as { entries?: ReadonlyArray<BatonRecordEntry> } | null;
          return learn(value?.entries ?? []);
        },
        note: async (id, text, signal) => {
          if (signal.aborted) return;
          await requestKept({
            kind: "job",
            op: "refine",
            args: { id, text, via: "text", note: true },
          });
        },
      },
    );
    standingStore.saveRun(result.state);
    for (const run of result.did) {
      input.onNote?.("playbook", { playbook: run.id, text: run.text });
      const job = BUILT_INS.find((j) => j.id === run.id)!;
      void input
        .direct?.("baton.record.append", {
          kind: "standing_job",
          actor: ownerOf(job).name,
          subject: job.title,
          outcome: run.outcome,
          detail: `${run.text}${usedLine(job.model, job.turns)}`,
        })
        .catch(() => undefined);
    }
    if (result.did.length > 0) void refreshNow().catch(() => undefined);
  };
  setInterval(() => void standingTick().catch(() => undefined), INITIATIVE_MS).unref();

  /** The tail of a log, cached until the file changes: Home redraws often, the log does not. */
  const tails = new Map<string, { stamp: string; text: string }>();
  const tailOf = (file: string): string => {
    try {
      const stat = NodeFS.statSync(file);
      const stamp = `${stat.mtimeMs}:${stat.size}`;
      const hit = tails.get(file);
      if (hit?.stamp === stamp) return hit.text;
      const fd = NodeFS.openSync(file, "r");
      const length = Math.min(stat.size, 96 * 1024);
      const buffer = Buffer.alloc(length);
      NodeFS.readSync(fd, buffer, 0, length, stat.size - length);
      NodeFS.closeSync(fd);
      const text = buffer.toString("utf8");
      tails.set(file, { stamp, text });
      return text;
    } catch {
      return "";
    }
  };
  const key = (accelerator: string): BindingInput => ({ type: "key", accelerator });
  const currentBindings = () =>
    effective(settings.bindings, {
      hold: key(settings.holdKey),
      toggle: key(settings.toggleKey),
    });

  const homeExtra = (): HomeExtra => {
    const turnLog = tailOf(NodePath.join(input.logDir, "voice-turns.ndjson"));
    const today = todayStats(turnLog, new Date());
    const activity = homeActivity(history?.list({ limit: 5 }) ?? [], parseLogEntries(turnLog, 5));
    const sessionRows = input.sessions?.rows() ?? [];
    const lifecycle = tailOf(NodePath.join(input.logDir, "baton-lifecycle.ndjson"))
      .split("\n")
      .flatMap((l) => {
        try {
          const e = JSON.parse(l) as {
            at?: string;
            event?: string;
            reason?: string;
            detail?: string;
          };
          const words: Record<string, string> = {
            "replaced-by-update": "Tessaya was replaced by an update",
            "previous-run-ended-badly":
              "The last run ended without a clean exit (a crash, a kill or a power loss)",
            "restarted-after-update": "Restarted after an update",
            exiting: `Going down: ${e.reason ?? "quit"}${e.detail ? ` ${e.detail}` : ""}`,
            "uncaught-exception": "An unexpected error stopped Tessaya",
            "render-process-gone": "A window closed unexpectedly",
            "child-process-gone": "A helper program stopped unexpectedly",
          };
          const text = e.event === undefined ? undefined : words[e.event];
          return e.at === undefined || text === undefined ? [] : [{ at: e.at, text }];
        } catch {
          return [];
        }
      })
      .toReversed()
      .slice(0, 5);
    return {
      setup: {
        mode: setupMode(tourMemory()),
        step: resumeStep(tourMemory(), SETUP_STEPS.length),
        steps: SETUP_STEPS,
        hold: settings.holdKey,
      },
      wakeWords: settings.wakeWords.filter((w) => w.enabled).map((w) => w.word),
      activity,
      stats: {
        turns: today.turns,
        dictations: today.dictations,
        sessions: sessionRows.length,
        needYou: sessionRows.filter((r) => r.urgent).length,
      },
      insights: insights(),
      vocabulary: (dictionary as ReadonlyArray<VocabEntry>).map((d) => ({
        phrase: d.phrase,
        replacement: d.replacement,
        source: d.source ?? "added",
        count: d.count ?? null,
        lastSeen: d.lastSeen ?? null,
        heard: d.heard ?? [],
      })),
      hotkeys: [
        ...currentBindings().flatMap((row) =>
          row.inputs.flatMap((one) =>
            one.type === "key"
              ? [
                  {
                    label: row.def.label,
                    keys: one.accelerator,
                    tab:
                      (
                        {
                          hold: "dictation",
                          toggle: "dictation",
                          dictation: "dictation",
                          ask: "screen",
                          clear: "screen",
                          stop: "screen",
                        } as Record<string, string>
                      )[row.def.id] ?? "voice",
                  },
                ]
              : [],
          ),
        ),
        { label: "Cancel a recording, a card or a drive", keys: "Escape", tab: "screen" },
      ],
      bindings: currentBindings().map((row) => ({
        action: row.def.id,
        label: row.def.label,
        hint: row.def.hint,
        inputs: row.inputs,
        isDefault: row.isDefault,
        conflictsWith: row.conflictsWith,
        conflicts: row.conflicts.map((c) => ({
          index: row.inputs.findIndex((i) => sameInput(i, c.input)),
          with: c.with,
        })),
      })),
      bindingsNote: bindingsNote ?? takenNote,
      mouseReady: mouseHookReady,
      mouseButtons: input.platform === "win32",
      usage: input.sessions?.usage() ?? [],
      lifecycle,
      paths: [
        { id: "state", label: "State folder", path: input.stateDir },
        { id: "logs", label: "Log folder", path: input.logDir },
        { id: "models", label: "Voice models", path: modelsDir },
        { id: "settings", label: "Voice settings file", path: settingsPath },
      ],
      about: {
        version: input.appVersion,
        source: releasesUrl(input.env).replace("https://", ""),
        licence: "MIT, with third-party notices",
        notices: "docs/baton/THIRD_PARTY_NOTICES.md",
      },
    };
  };

  // The Now page (D149): read every few minutes, not on every redraw, because it can call gh.
  let nowData: NowData = EMPTY_NOW;
  const probe = createProbes({});
  const readLastNightly = createNightlyCache(repoSlug(input.env));
  const readSyncExtra = createSyncExtraCache(
    repoSlug(input.env),
    input.env["BATON_REPO_DIR"],
    runGh,
  );
  /** Last read of the upstream sync; the rows below use it, and a failed read leaves it unknown. */
  const cloudNow = () => readCloudLogins(cloudLoginsFile(input.env));
  let syncNow: SyncState = { localBehind: null, status: null, pr: null };
  const refreshNow = async (): Promise<void> => {
    const at = Date.now();
    const jobs = jobsCache ?? [];
    const last = await readLastNightly();
    syncNow = { ...(await readSyncExtra()), status: last.sync };
    const { ranked, unreadable } = await collectNeeds({
      jobs,
      sessions: input.sessions?.rows() ?? [],
      findings: serverReachable() ? await watchFindings() : [],
      extra: [
        ...needsFromCommitments(commitments.list(), at),
        ...syncNeeds(syncNow, at),
        ...cloudLoginsNeeds(cloudNow(), at),
        ...cloudNeeds(cloud.view().requests),
      ],
      config: needsConfig(),
      external: externalNeeds,
      now: at,
    });
    const day = new Date(at).toDateString();
    const learned = (
      (serverReachable()
        ? await requestKept({
            kind: "memory",
            op: "list",
            args: { limit: 200, admin: true },
          }).catch(() => null)
        : null) as {
        items?: ReadonlyArray<{ text: string; createdAt: string; proposed: boolean }>;
      } | null
    )?.items
      ?.filter((m) => !m.proposed && new Date(m.createdAt).toDateString() === day)
      .slice(0, 5)
      .map((m) => m.text);
    // His own view of the team (walled projects included), for the Now page.
    const team = (
      serverReachable()
        ? ((await requestKept({ kind: "job", op: "team", args: { admin: true } }).catch(
            () => null,
          )) as BatonTeamBoardResult | null)
        : null
    )?.members;
    const probed = await probe(settings.claudeBinary);
    const { nightly } = last;
    const state = initiative.state();
    nowData = {
      loaded: true,
      ...(team === undefined ? {} : { team }),
      brief: standingStore.load().brief?.text ?? null,
      runs: [
        ...latestRuns(standingStore.load()).map((r) => {
          const def = BUILT_INS.find((j) => j.id === r.id);
          return {
            id: r.id,
            title: def?.title ?? r.id,
            at: r.at,
            status: statusOf(r),
            text: r.text,
            ...(def === undefined ? {} : { model: def.model, turns: def.turns }),
          };
        }),
        // His own jobs' latest runs beside the built-ins'.
        ...userJobStore.list().flatMap((j) => {
          const last = userJobStore
            .runs()
            .filter((r) => r.id === j.id)
            .at(-1);
          return last === undefined
            ? []
            : [
                {
                  id: j.id,
                  title: j.title,
                  at: last.at,
                  status: last.status,
                  text: last.text.slice(0, 300),
                  ...(last.model === undefined ? {} : { model: last.model }),
                  ...(last.turns === undefined ? {} : { turns: last.turns }),
                },
              ];
        }),
      ].toSorted((a, b) => b.at - a.at),
      interrupted: interruptedNow,
      needs: ranked,
      unreadable,
      commitments: commitments.list().filter((c) => c.status === "open"),
      doing: [
        ...jobs.filter((j) => j.group === "running").map((j) => `Running: ${j.title}`),
        ...buildApprovals({ jobs, sessions: input.sessions?.rows() ?? [] })
          .slice(0, 3)
          .map((a) => `Waiting for your answer: ${a.title}`),
      ],
      learned: learned ?? [],
      declined: state.declined.slice(-8).toReversed(),
      muted: state.never.map((topic) => ({ topic, title: state.titles[topic] ?? topic })),
      capabilities: [
        ...capabilities({
          network: probed.network,
          claude: probed.claude,
          speechModel: sidecar !== null && parakeetPath !== null,
          server: jobsCache !== null,
        }),
        nightlyRow(nightly, Date.now()),
        syncCapability(syncNow, Date.now()),
        cloudLoginsRow(cloudNow(), Date.now()),
      ],
      weaves:
        (
          (serverReachable()
            ? await requestKept({ kind: "weave", op: "list", args: { limit: 10 } }).catch(
                () => null,
              )
            : null) as { items?: ReadonlyArray<WeaveRecord> } | null
        )?.items ?? [],
    };
    home.refresh();
  };
  setInterval(() => void refreshNow().catch(() => undefined), NOW_REFRESH_MS).unref();
  setTimeout(() => void refreshNow().catch(() => undefined), QUIET_START_MS).unref();

  const cloudSettings = (): CloudSettings => ({ ...DEFAULT_CLOUD, ...settings.cloud });
  const saveCloud = (patch: Partial<CloudSettings>) => {
    save({ cloud: { ...settings.cloud, ...patch } });
    void cloud.refresh().catch(() => undefined);
  };
  const cloud = createCloud({
    settings: cloudSettings,
    weekly: async (driver) =>
      (
        (await input.direct?.("fabric.account.weekly", { driver }).catch(() => null)) as {
          readonly instances?: ReadonlyArray<BatonInstanceWeekly>;
        } | null
      )?.instances ?? [],
    exec: nodeExec,
    dir: NodePath.join(input.stateDir, "cloud"),
    hub: async (op, provider, args) => {
      const kind = ["describe", "detect", "status", "list", "usage", "diff"].includes(op)
        ? "read"
        : ["approve", "deny"].includes(op)
          ? "approve"
          : "act";
      try {
        const out = (await requestKept({
          kind: "cloud",
          op: kind,
          ...(cloudSettings().hubEnv === "" ? {} : { environmentId: cloudSettings().hubEnv }),
          args: { op, ...(provider === "" ? {} : { provider }), args },
        })) as { ok?: boolean; value?: unknown; error?: string } | null;
        return out?.ok === true
          ? { ok: true, value: out.value }
          : {
              ok: false,
              error: out?.error ?? "The computer that runs cloud tasks did not answer.",
            };
      } catch {
        return {
          ok: false,
          error: "There is no connection to the computer that runs cloud tasks.",
        };
      }
    },
    // The connected machines are the window's to list; asking a closed one would reopen it.
    environments: async () =>
      mainContents === null || mainContents.isDestroyed()
        ? []
        : (((await requestKept({ kind: "cloud", op: "environments", args: {} }).catch(
            () => [],
          )) as ReadonlyArray<{ id: string; label: string }> | null) ?? []),
    vaultKey: (name, why) =>
      useVaultKey(name, why, {
        unlocked: () => vaultState.vault.isUnlocked(),
        read: (n) =>
          vaultState.vault.isUnlocked() ? (vaultState.vault.valueOf(n)?.value ?? null) : null,
        hello: (message) => windowsHello(message, input.platform),
      }),
    ask: async (q) => {
      const box = {
        title: q.title,
        detail: q.detail,
        buttons: q.buttons,
        cancel: q.cancel,
        armMs: q.armMs,
        expiresMs: 120_000,
      };
      // The waiting-task question also goes to a paired phone; the spoken-approval dialog stays on this computer.
      if (q.everywhere === true && input.extras?.askMirrored !== undefined) {
        // A phone may answer it only if it was paired with the approval permission.
        return await input.extras.askMirrored(box, "cloud-approve");
      }
      return (await input.extras?.ask(box)) ?? q.cancel;
    },
    changed: () => pushHome(),
    now: () => Date.now(),
  });
  let cloudTimer: ReturnType<typeof setInterval> | null = null;
  let trustFilter: TrustFilter = "all";
  let backupPreview: (RestorePreview & { readonly file: string }) | null = null;
  let backupNote: string | null = null;
  const backupExport = async (): Promise<void> => {
    const stamp = new Date().toISOString().slice(0, 10);
    const picked = await Electron.dialog.showSaveDialog({
      defaultPath: NodePath.join(Electron.app.getPath("documents"), `tessaya-backup-${stamp}.zip`),
      filters: [{ name: "Zip", extensions: ["zip"] }],
    });
    if (picked.canceled || picked.filePath === undefined) return;
    // Server-side memory comes whole (ids, source, pins, history); without the window it is left out and says so.
    const windowUp = mainContents !== null && !mainContents.isDestroyed();
    const exported = windowUp
      ? ((await requestKept({
          kind: "memory",
          op: "list",
          args: { includeSuperseded: true, includeProposed: true, limit: 100_000 },
        }).catch(() => null)) as { items?: ReadonlyArray<MemoryItem> } | null)
      : null;
    const sealed = ((await input.privateMemory?.call("backup").catch(() => null)) ?? null) as {
      dump?: string;
    } | null;
    const plan = planBackup(input.stateDir, exported?.items ?? null, sealed?.dump ?? null);
    const count = writeBackup(picked.filePath, plan);
    backupNote = `Saved ${count} files to ${picked.filePath}.${
      exported === null
        ? " Server memory was not included (open the sessions window and export again)."
        : ""
    }${plan.skipped.length === 0 ? "" : ` Left out: ${plan.skipped.map((x) => `${x.name} (${x.why})`).join("; ")}.`}`;
  };
  const backupChoose = async (): Promise<void> => {
    const picked = await Electron.dialog.showOpenDialog({
      properties: ["openFile"],
      filters: [{ name: "Zip", extensions: ["zip"] }],
    });
    const file = picked.filePaths[0];
    if (picked.canceled || file === undefined) return;
    const preview = previewRestore(NodeFS.readFileSync(file), input.stateDir);
    if (preview instanceof Error) {
      backupPreview = null;
      backupNote = preview.message;
    } else {
      backupPreview = { ...preview, file };
      backupNote = null;
    }
  };
  const trustData = () => {
    const on = (id: string) =>
      input.extras?.controls().some((c) => c.id === id && c.kind === "toggle" && c.on) ?? false;
    return {
      screenAlways: on("s.capture"),
      chrome: on("s.chrome"),
      social: on("s.social"),
      act: on("s.act"),
      remote: on("s.hands"),
      vault: !vaultState.vault.exists()
        ? ("none" as const)
        : vaultState.vault.isUnlocked()
          ? ("unlocked" as const)
          : ("locked" as const),
      grants: (jobsCache ?? []).flatMap((j) =>
        j.terms.grants
          .filter((g) => g.revokedAt === null)
          .map((g) => ({
            jobId: j.workSessionId,
            title: j.title,
            channel: g.channel,
            since: g.grantedAt,
          })),
      ),
      standing: [
        ...BUILT_INS.map((j) => ({
          kind: "built_in" as const,
          id: j.id,
          title: j.title,
          what: j.what,
          owner: ownerOf(j).name,
          on: standingStore.load().on[j.id] === true,
          count: standingStore.load().counts[j.id] ?? 0,
          ...(j.trigger.kind === "time" ? { missed: missedRunOf(standingStore.load(), j.id) } : {}),
          ...(j.trigger.kind === "event"
            ? { quiet: standingStore.load().quiet?.[j.id] === true }
            : {}),
        })),
        // A rule and a schedule hand work out, which only the lead does: they are the lead's.
        ...rulesCache.map(({ rule }) => ({
          kind: "rule" as const,
          id: rule.id,
          title: rule.source === "" ? "A rule" : rule.source,
          what:
            rule.status === "exhausted" ? `It has run all ${rule.maxFirings} times it may.` : "",
          owner: leadName(),
          on: rule.status === "enabled",
          count: rule.firedCount,
        })),
        ...userJobStore.list().map((j) => ({
          kind: "user" as const,
          id: j.id,
          title: j.title,
          what: `${whenText(j.trigger)[0]!.toUpperCase()}${whenText(j.trigger).slice(1)}: ${j.instruction}`,
          owner: j.owner === "executive" ? leadName() : j.owner,
          on: j.on,
          count: userJobStore.runs().filter((r) => r.id === j.id).length,
          ...(() => {
            const last = userJobStore
              .runs()
              .filter((r) => r.id === j.id)
              .at(-1);
            return last === undefined ? {} : { lastRun: { status: last.status, at: last.at } };
          })(),
          instruction: j.instruction,
          proposed: j.proposed,
          from: j.from,
          ...(j.trigger.kind === "time" ? { missed: j.missed } : {}),
        })),
        ...(jobsCache ?? [])
          .filter((j) => j.terms.scheduleTaskId !== null)
          .map((j) => ({
            kind: "schedule" as const,
            id: j.workSessionId,
            title: `${j.title} (scheduled)`,
            what: "Runs again on its schedule and reports in its own thread.",
            owner: leadName(),
            on: null,
            count: j.usage?.turns ?? 0,
          })),
      ],
      entries: parseTrustLogs({
        turns: tailOf(NodePath.join(input.logDir, "voice-turns.ndjson")),
        social: tailOf(NodePath.join(input.stateDir, "social-actions.ndjson")),
        vault: tailOf(vaultState.auditFile),
      }),
      filter: trustFilter,
    };
  };

  /** Marks a step of building Home's state for the stall log; adds nothing. */
  const at = (name: string): [] => {
    markPhase(`home-state:${name}`);
    return [];
  };
  const homeState = (): HomeState => ({
    status: {
      label: hudView(state).label,
      tone: state === "muted" ? "off" : state === "sleeping" ? "idle" : "good",
      device: deviceName(),
      mark: markSvg(markOptions()),
      brandMark: brandMarkSvg(),
    },
    extra: homeExtra(),
    controls: [
      ...at("approvals"),
      ...approvalControls(
        buildApprovals({ jobs: jobsCache ?? [], sessions: input.sessions?.rows() ?? [] }),
        jobsCache !== null ? "ready" : jobsError !== null ? { error: jobsError } : "loading",
      ),
      ...nowControls(nowData, Date.now()),
      ...at("trust"),
      ...trustControls(trustData(), Date.now()),
      ...cloudPageControls(cloud.view(), cloudSettings()),
      ...approvalCardControls(cloud.view()),
      ...at("help"),
      ...helpControls({
        tools: (toolNames ??= buildBatonTools({} as ToolHost).map((t) => t.name)),
        bindings: currentBindings().map((r) => ({
          label: r.def.label,
          keys: r.inputs.map((x) => (x.type === "key" ? x.accelerator : x.button)).join(", "),
        })),
        checks: checks ?? [],
      }),
      ...backupControls(
        backupPreview === null
          ? null
          : { file: NodePath.basename(backupPreview.file), rows: backupPreview.rows },
        backupNote,
      ),
      setupHoldControl(settings.holdKey),
      ...at("writing"),
      ...snippetControls(snippets.list(), snippetNote),
      ...transformControls(transforms.read(), transforms.all(), transformNote),
      ...styleControls(styles.read(), settings.dictationCleanup),
      ...insightControls(deepInsights()),
      ...voiceProfileControls(profileValue),
      ...voiceIdControls(voiceId.view(loop !== null)),
      {
        id: "d.import",
        section: "Vocabulary files",
        label: "Import or export your vocabulary",
        hint: "A file of words, one per line or heard,written, or JSON: up to 3 MB and 1,000 words. A word already there is replaced. Export saves a CSV you can import again.",
        kind: "action",
        button: "Import a file",
        secondary: "Export",
      },
      ...scratchControls(scratch.notes(), scratchQuery, scratch.hotkeyOn()),
      ...at("presence"),
      ...presenceControls(settings),
      ...at("memory"),
      ...(privateTab?.controls() ?? []),
      ...(privateTab === null || privateTab.everyday() ? memoryTab.controls() : []),
      ...vaultTab.controls(),
      ...at("pack"),
      ...cachedPack(),
      ...at("harness"),
      ...harnessControls(harnessItems()),
      ...(jobsCache === null
        ? jobsError !== null
          ? [
              {
                id: "j.load",
                section: "Jobs",
                label: "Could not read your jobs",
                hint: jobsError,
                kind: "action" as const,
                button: "Try again",
              },
            ]
          : [
              {
                id: "j.loading",
                section: "Jobs",
                label: "Reading your jobs",
                kind: "check" as const,
                status: "ok" as const,
                detail: "Asking the sessions window; it opens if it is not already.",
              },
            ]
        : jobsCache.length === 0
          ? [
              {
                id: "j.empty",
                section: "Jobs",
                label: "No jobs yet",
                hint: "Ask Tessaya to take on some long work. It plans first and waits for your OK.",
                kind: "check" as const,
                status: "ok" as const,
                detail: "Nothing is running for you.",
              },
            ]
          : jobControls(jobsCache)),
      // Sessions are T3's thread list (P5): only the rows Ctrl+K opens a session from are still sent.
      ...sessionControls(input.sessions?.rows() ?? []),
      {
        id: "v.enabled",
        section: "Wake and listening",
        label: "Listen for my wake word",
        hint:
          binary === null
            ? "Not available in this build."
            : "Say the wake word and Tessaya starts listening.",
        kind: "toggle",
        on: settings.enabled,
        disabled: binary === null,
      },
      {
        id: "v.muted",
        section: "Wake and listening",
        label: "Mute",
        hint: `Shortcut ${VOICE_HOTKEYS[2]!.accelerator}`,
        kind: "toggle",
        on: loop?.isMuted() ?? false,
        disabled: loop === null,
      },
      ...at("screen"),
      ...(input.extras?.controls() ?? []),
      ...(input.updates?.controls() ?? []),
      {
        id: "v.mic",
        section: "Wake and listening",
        label: "Microphone",
        kind: "choice",
        value: settings.pinnedLabel ?? "",
        options: [
          { value: "", label: "Automatic" },
          ...realDevices(devices).map((d) => ({
            value: d.label,
            label: d.label || "Unnamed microphone",
          })),
        ],
        more: true,
      },
      // His order after it: tried when it is unplugged, and moved to at a press when it hears nothing and one of these does.
      ...Array.from({ length: Math.min(settings.micOrder.length + 1, 3) }, (_, i) => {
        const name = settings.micOrder[i]?.name ?? "";
        const shown = realDevices(devices).find((d) => sameMic(d.label, name));
        return {
          id: `v.micOrder:${i}`,
          section: "Wake and listening",
          label: i === 0 ? "If it hears nothing, use" : "Then",
          kind: "choice" as const,
          value: shown?.label ?? name,
          options: [
            { value: "", label: "Nothing" },
            ...(name !== "" && shown === undefined
              ? [{ value: name, label: `${name} (not plugged in)` }]
              : []),
            ...realDevices(devices).map((d) => ({
              value: d.label,
              label: d.label || "Unnamed microphone",
            })),
          ],
          more: true,
        };
      }),
      ...settings.wakeWords.map((wake) => ({
        id: `v.wake:${wake.word}`,
        section: "Wake and listening",
        label: `Wake word: ${wake.word}`,
        kind: "toggle" as const,
        on: wake.enabled,
      })),
      {
        id: "v.direct",
        section: "Wake and listening",
        label: "Send words to the focused session",
        hint: "What you say goes straight to the session you are working in.",
        kind: "toggle",
        on: state === "direct_session",
        disabled: loop === null,
      },
      {
        id: "v.cleanup",
        section: "Dictation",
        label: "Clean up with AI",
        hint: "Claude fixes misheard words, grammar and false starts, through your Claude plan. On this computer fixes punctuation and filler words only. Off types exactly what was heard.",
        kind: "choice",
        value: settings.dictationCleanup,
        options: [
          { value: "claude", label: "Claude (smarter, ~1–2 s)" },
          { value: "local", label: "On this computer (instant)" },
          { value: "off", label: "Off" },
        ],
      },
      {
        id: "v.dictation",
        section: "Dictation",
        label: "Dictate with",
        hint: `Hold ${settings.holdKey} to dictate into any app.`,
        kind: "choice",
        value: settings.dictation,
        options: [
          { value: "baton", label: "Tessaya" },
          { value: "wispr", label: "Wispr Flow" },
        ],
        disabled: binary === null,
      },
      ...(settings.dictation === "baton" && parakeetPath === null && binary !== null
        ? [
            {
              id: "v.download",
              section: "Dictation",
              label: "Speech model",
              hint: `Needed once, ${Math.round(speechModel().size / 1e6)} MB.`,
              kind: "action" as const,
              button: modelJob === null ? "Download" : "Downloading…",
              disabled: modelJob !== null,
            },
          ]
        : []),
      {
        id: "v.appMode",
        section: "Dictation",
        label: `Writing style in ${focusedApp.exe || "the last app you dictated into"}`,
        hint: "Chat, email or code: how your words are laid out.",
        kind: "choice",
        value: settings.appModes[focusedApp.exe.toLowerCase()] ?? "",
        options: [
          { value: "", label: "Automatic" },
          ...DICTATION_MODES.map((m) => ({ value: m, label: MODE_LABELS[m] })),
        ],
        disabled: focusedApp.exe.length === 0,
        more: true,
      },
      {
        id: "v.speechModel",
        section: "Dictation",
        label: "Speech model",
        ...(settings.speechModelPicked === "machine"
          ? { hint: "Picked for this computer, which is slow for the larger model." }
          : {}),
        kind: "choice",
        value: usePersonal()
          ? "personal"
          : settings.speechModel === "personal"
            ? "v3"
            : settings.speechModel,
        options: [
          ...(personalPath === null ? [] : [{ value: "personal", label: "Personal (yours)" }]),
          { value: "v3", label: "25 European languages, slower" },
          { value: "fast", label: "English, 3x quicker" },
        ],
        more: true,
      },
      ...(languageOffer === null
        ? []
        : [
            {
              id: "v.speechModelOffer",
              section: "Dictation",
              label: `Hear ${languageName(languageOffer)}`,
              hint: `This computer picked the fast English model because it is slow for the larger one. The 25-language model knows ${languageName(languageOffer)}, and is slower here.`,
              kind: "action" as const,
              button: `Switch and add ${languageName(languageOffer)}`,
            },
          ]),
      ...cloudRows(),
      {
        id: "v.language",
        section: "Dictation",
        label: "Languages you speak",
        hint: LANGUAGE_HINT,
        kind: "list",
        items: settings.languages.map(languageName),
        placeholder:
          settings.languages.length === 0
            ? "Detecting any language. Add one to keep to it"
            : "Add a language, such as French",
        addLabel: "Add",
      },
      {
        id: "v.recognizeOnServers",
        section: "Dictation",
        label: "Recognise on my servers",
        hint: "While you hold the key, your words are recognised on the first of your own servers that answers, over your private network, and this computer only steps in if none does. Audio is never kept on the servers.",
        kind: "toggle",
        on: settings.recognizeOnServers,
      },
      {
        id: "v.recognizer",
        section: "Dictation",
        label: "My recognition servers",
        hint: "Add one as its address and token, separated by a space (ws://host:port token). The token is encrypted on this computer and never shown again.",
        kind: "list",
        secret: true,
        items: settings.recognizers,
        placeholder: "ws://host:port token",
        addLabel: "Add",
      },
      {
        id: "v.doubleTap",
        section: "Dictation",
        label: "Double-tap to keep talking",
        hint: "Tap the dictation key twice, quickly, and Tessaya keeps listening after you let go. Press the key once more to finish. Holding it still works as before.",
        kind: "toggle",
        on: settings.doubleTap,
      },
      {
        id: "v.composerMic",
        section: "Dictation",
        label: "Microphone in the T3 composer",
        hint: "Tessaya voice runs the chat box's microphone through this dictation: its recognition, clean-up and your words. Press once to start, again to insert. T3 built-in uses T3's own voice input and its Voice settings.",
        kind: "choice",
        value: settings.composerMic,
        options: [
          { value: "tessaya", label: "Tessaya voice (recommended)" },
          { value: "t3", label: "T3 built-in" },
        ],
      },
      {
        id: "v.learnWords",
        section: "Dictation",
        label: "Learn words from my edits",
        hint: "When you fix a word Tessaya wrote, or keep using a name, it joins your vocabulary and says so. Discard takes it out for good.",
        kind: "toggle",
        on: settings.learnWords,
      },
      {
        id: "v.showWords",
        section: "Dictation",
        label: "Show words as you speak",
        hint: "Your words appear in the pill as Tessaya hears them, and after the paste it shows what the cleanup changed.",
        kind: "toggle",
        on: settings.showWords,
      },
      {
        id: "v.pillStyle",
        section: "Dictation",
        label: "Pill style",
        hint: "Where your words appear as you speak: in the pill, or in the text box itself when it says where its caret is (never in a password box).",
        kind: "choice",
        value: settings.pillStyle,
        options: [
          { value: "pill", label: "Pill" },
          { value: "field", label: "In the text box when possible" },
        ],
      },
      {
        id: "v.copyLast",
        section: "Dictation",
        label: "Last transcript",
        kind: "action",
        button: "Copy",
        disabled: (lastReply ?? lastDictation) === null,
        more: true,
      },
      {
        id: "v.keepVoice",
        section: "Voice recordings",
        label: "Keep my voice recordings",
        hint: "Saves the audio of your dictations and of what you say to Tessaya, on this computer only. It keeps your voice. Never records anything else, and never listens in the background.",
        kind: "toggle",
        on: settings.keepVoice,
      },
      {
        id: "v.keepDays",
        section: "Voice recordings",
        label: "Delete recordings after",
        hint: "Clips you corrected are kept longer, up to the size limit below.",
        kind: "choice",
        value: String(settings.keepDays),
        options: [
          { value: "7", label: "7 days" },
          { value: "30", label: "30 days" },
          { value: "90", label: "90 days" },
          { value: "365", label: "A year" },
        ],
        disabled: !settings.keepVoice,
      },
      {
        id: "v.keepCap",
        section: "Voice recordings",
        label: "Keep corrected clips up to",
        hint: "They teach Tessaya the most. The oldest go first when over.",
        kind: "choice",
        value: String(settings.keepCapGb),
        options: [
          { value: "1", label: "1 GB" },
          { value: "2", label: "2 GB" },
          { value: "5", label: "5 GB" },
          { value: "10", label: "10 GB" },
        ],
        disabled: !settings.keepVoice,
      },
      {
        id: "v.keepSpace",
        section: "Voice recordings",
        label: "Space used",
        hint: `${(spaceUsed(audioDir) / 1024 ** 2).toFixed(1)} MB of recordings. ${
          keepNote ?? "Saving pauses if the drive drops under 5 GB free."
        }`,
        kind: "action",
        button: "Delete all recordings",
        disabled: spaceUsed(audioDir) === 0,
      },
      {
        id: "v.appearance",
        section: "Appearance",
        label: "Appearance",
        hint: "Follows Windows by default. Light or Dark applies at once.",
        kind: "choice",
        value: settings.appearance,
        options: [
          { value: "system", label: "System" },
          { value: "light", label: "Light" },
          { value: "dark", label: "Dark" },
        ],
      },
      {
        id: "v.palette",
        section: "Appearance",
        label: "Palette",
        hint: "The logo's colours for this window, in light and dark. Woad is the default. The app window follows with the matching theme unless you picked another one there.",
        kind: "choice",
        value: settings.palette,
        options: [
          { value: "woad", label: "Woad" },
          { value: "damson", label: "Damson" },
          { value: "madder", label: "Madder" },
        ],
      },
      {
        id: "v.pillDesign",
        section: "Appearance",
        label: "Pill design",
        hint: "How the dictation pill, its cards and prompts look. They wear the theme and palette above, light or dark.",
        kind: "choice",
        value: settings.pillDesign,
        options: [
          { value: "tessaya", label: "Tessaya" },
          { value: "quiet", label: "Quiet" },
          { value: "lively", label: "Lively" },
        ],
      },
      {
        id: "v.pillWaveform",
        section: "Appearance",
        label: "Waveform",
        hint: "The pill's waveform. Match the design uses each design's own: Mound for Tessaya, Bars for Quiet, Beads for Lively.",
        kind: "choice",
        value: settings.pillWaveform,
        options: [
          { value: "match", label: "Match the design" },
          { value: "mound", label: "Mound" },
          { value: "bars", label: "Bars" },
          { value: "beads", label: "Beads" },
        ],
      },
      {
        id: "v.motion",
        section: "Appearance",
        label: "Motion",
        hint: "Full plays every animation. Reduced keeps the small ones. Off stops them. Full follows the system when it asks for less.",
        kind: "choice",
        value: settings.motion,
        options: [
          { value: "full", label: "Full" },
          { value: "reduced", label: "Reduced" },
          { value: "off", label: "Off" },
        ],
      },
      {
        id: "v.glass",
        section: "Appearance",
        label: "Glass effects",
        hint: "The see-through window material. On follows the system when transparency effects are off.",
        kind: "choice",
        value: settings.glass,
        options: [
          { value: "on", label: "On" },
          { value: "reduced", label: "Reduced" },
          { value: "off", label: "Off" },
        ],
      },

      {
        id: "v.audition",
        section: "Answers and voice",
        label: "Hear the voice",
        hint: "Plays one line in the voice chosen above. Play beside a voice plays that one. Tessaya's own voices only.",
        kind: "action",
        button: "Play",
      },
      {
        id: "v.cues",
        section: "On screen",
        label: "Sounds",
        hint: "Short cues when listening starts and ends, after a long wait, and on an error. Never over your voice.",
        kind: "choice",
        value: settings.cues,
        options: [
          { value: "off", label: "Off" },
          { value: "quiet", label: "Quiet" },
          { value: "normal", label: "Normal" },
        ],
      },
      {
        id: "v.listenAfterWake",
        section: "Wake and listening",
        label: "Listen after waking",
        hint: "How long Tessaya waits for you to START speaking after the wake word. Once you have started, it listens until you stop, however long that is.",
        kind: "choice",
        value: String(settings.wakeListenMs),
        options: LISTEN_AFTER_WAKE_MS.map((ms) => ({ value: String(ms), label: `${ms / 1000} s` })),
      },
      {
        id: "v.conversation",
        section: "Wake and listening",
        label: "Keep the conversation open",
        hint: "After a reply you can answer without the wake word for this long.",
        kind: "choice",
        value: String(settings.conversationOpenMs),
        options: CONVERSATION_MS.map((ms) => ({
          value: String(ms),
          label: ms < 60_000 ? `${ms / 1000} s` : `${ms / 60_000} min`,
        })),
      },
      {
        id: "v.waitMs",
        section: "Wake and listening",
        label: "How long I wait for you to finish",
        hint: "A pause this long ends your turn. Unfinished sentences get longer, and speech that resumes soon after joins the same turn.",
        kind: "choice",
        value: String(clampWait(settings.waitMs)),
        options: [800, 1200, 1500, 2000, 3000].map((ms) => ({
          value: String(ms),
          label: `${ms / 1000} s`,
        })),
      },
      {
        id: "v.headphones",
        section: "Wake and listening",
        label: "Headphones or speakers",
        hint: "With headphones the microphone cannot hear Tessaya, so it keeps listening while she speaks and you can cut in just by talking. With speakers it does not take talking over her as a cut-in unless you turn on the setting below, and the wake word, a stop phrase, Esc and the pill's stop button always work. On Windows, Automatic reads your playback device: headphones and headsets count as headphones, and anything else (a Bluetooth speaker too) as speakers.",
        kind: "choice",
        value: settings.outputDevice,
        options: [
          {
            value: "auto",
            label: output.kind() === null ? "Automatic" : `Automatic (${output.kind()} now)`,
          },
          { value: "headphones", label: "Headphones" },
          { value: "speakers", label: "Speakers" },
        ],
      },
      {
        id: "v.voiceBargeIn",
        section: "Wake and listening",
        label: "Cut in by talking over her (speakers, experimental)",
        hint: "Tessaya learns your room from her own voice and stops when you speak over her. In tests it still mistakes her own voice for yours about once in six minutes of continuous speech and misses some quiet interruptions, so it is off. The wake word, a stop phrase, Esc and the pill's stop button always work, and with headphones you can simply talk.",
        kind: "toggle",
        on: settings.voiceBargeIn,
      },
      {
        id: "v.quietSpeech",
        section: "Wake and listening",
        label: "Quiet speech",
        hint: "For whispering or a microphone far away: Tessaya lifts what it hears and accepts a fainter wake word. It also lifts room noise and lets in more false wakes, so leave it off otherwise.",
        kind: "toggle",
        on: settings.quietSpeech,
      },
      {
        id: "v.verifyWake",
        section: "Wake and listening",
        label: "Check the wake word before waking",
        hint: "Tessaya listens to what it just heard and wakes only if the name is in it. Fewer false wakes from TV and music; the pill appears a moment later.",
        kind: "toggle",
        on: settings.verifyWake,
      },
      {
        id: "v.holdKeyCues",
        section: "On screen",
        label: "Sounds for the dictation key",
        hint: "Play the start and end cue when you dictate with the hold key. Off by default.",
        kind: "toggle",
        on: settings.holdKeyCues,
        more: true,
      },
      {
        id: "v.frosted",
        section: "On screen",
        label: "Frosted glass",
        hint: "Windows 11 blurs what is behind the pill's words and the cards beside it. Off, or on Windows 10, they keep their tinted glass.",
        kind: "toggle",
        on: settings.frosted,
        more: true,
      },
      {
        id: "v.pillPlace",
        section: "On screen",
        label: "Pill position",
        hint: "Or drag it: it lines up on a grid and snaps to centre, top and bottom. Hold Alt or Shift to place it freely. Right-click it for the same places.",
        kind: "choice",
        value: pill.placed() ? pill.place() : settings.pillEdge === "top" ? "top" : "taskbar",
        options: [
          ...PLACES.map((p) => ({ value: p.id, label: p.label })),
          { value: "taskbar", label: "Above the taskbar" },
        ],
      },
      {
        id: "v.hideFromCapture",
        section: "Screenshots and sharing",
        label: "Hide Tessaya from screenshots and screen sharing",
        hint: "Off by default, so your screenshot tool, recordings and screen sharing show Tessaya's cards and pill. Turn it on to keep them out. Tessaya's own look at your screen never includes them either way.",
        kind: "toggle",
        on: settings.hideFromCapture,
      },
      {
        id: "v.pillMove",
        section: "On screen",
        label: "Move the pill",
        hint: "Unlocks the pill so you can drag it. Click the check mark above it, press Esc, or click anywhere else when it is where you want it. Move pill in the tray menu does the same.",
        kind: "action",
        button: pill.moving() ? "Lock" : "Move",
        value: pill.moving() ? "lock" : "move",
      },
      {
        id: "v.pillRest",
        section: "On screen",
        label: "Show a small bar when Tessaya isn't listening",
        hint: "Off, nothing shows until Tessaya is doing something. Use Move pill in the tray menu to move it, double-click to put it back.",
        kind: "toggle",
        on: settings.pillAtRest,
      },
      {
        id: "v.notice",
        section: "Notices",
        label: "Tell me when something needs me",
        hint: "A failed, stalled or waiting session, once. It says it aloud only if you choose that, and never in quiet hours. Starts once T3's window has opened.",
        kind: "choice",
        value: settings.noticeMode,
        options: [
          { value: "off", label: "Off" },
          { value: "written", label: "A card" },
          { value: "spoken", label: "A card and one spoken line" },
        ],
      },
      {
        id: "v.dnd",
        section: "Notices",
        label: "Do not disturb",
        hint: "Nothing unprompted is said or offered, and no reminder is spoken, until you turn this off.",
        kind: "toggle",
        on: settings.doNotDisturb,
      },
      {
        id: "v.snooze",
        section: "Notices",
        label: "Snooze for an hour",
        hint: "Also in the pill's right-click menu.",
        kind: "action",
        button: Date.now() < settings.snoozeUntil ? "End the snooze" : "Snooze",
      },
      {
        id: "v.quiet",
        section: "Notices",
        label: "Quiet hours",
        kind: "choice",
        value: settings.quietHours,
        options: [
          { value: "none", label: "None" },
          { value: "22-8", label: "10 pm to 8 am" },
          { value: "23-7", label: "11 pm to 7 am" },
          { value: "0-9", label: "Midnight to 9 am" },
        ],
      },
      {
        id: "v.brief",
        section: "Notices",
        label: "Morning brief",
        hint: "What finished, failed or waits, once a day from 8 am. Ask for it any time with 'what happened overnight'.",
        kind: "choice",
        value: settings.briefMode,
        options: [
          { value: "off", label: "Off" },
          { value: "written", label: "A card" },
          { value: "spoken", label: "Spoken" },
        ],
      },
      {
        id: "v.pillHide",
        section: "On screen",
        label: "Hide the resting bar for an hour",
        hint: "It comes back by itself, or press Show again. Only the resting bar hides; the pill still shows while Tessaya listens or speaks.",
        kind: "action",
        button: Date.now() < settings.pillHiddenUntil ? "Show again" : "Hide for an hour",
      },
      {
        id: "v.pillFull",
        section: "On screen",
        label: "Step aside for full-screen apps and games",
        hint: "The resting bar is not drawn over a window that fills the screen.",
        kind: "toggle",
        on: settings.hideInFullscreen,
      },
      {
        id: "v.duck",
        section: "Dictation",
        label: "Quiet other sounds while I dictate",
        hint: "Lowers or mutes the system volume while you speak and puts it back exactly after. If Tessaya crashes in between, the next start restores it. Windows only.",
        kind: "choice",
        value: settings.duckWhileDictating,
        options: [
          { value: "off", label: "Off" },
          { value: "lower", label: "Lower the volume" },
          { value: "mute", label: "Mute" },
        ],
      },
      ...(input.platform === "win32"
        ? [
            {
              id: "v.gpu",
              section: "Dictation",
              label: "Use graphics card for recognition",
              hint: "Auto uses a graphics card with room for the speech model, warmed up in the background, and falls back to the processor on any problem. On uses any card that can run it. Off keeps recognition on the processor.",
              kind: "choice" as const,
              value: settings.gpuRecognition,
              options: [
                { value: "auto", label: "Auto" },
                { value: "on", label: "On" },
                { value: "off", label: "Off" },
              ],
            },
          ]
        : []),
      {
        id: "v.silence",
        section: "Wake and listening",
        label: "Warn me when the microphone hears nothing",
        hint: "A card and a pill message if the open microphone is dead quiet for this long; once until it hears something again.",
        kind: "choice",
        value: String(settings.micSilenceSeconds),
        options: [
          { value: "0", label: "Off" },
          { value: "30", label: "After 30 seconds" },
          { value: "90", label: "After 90 seconds" },
          { value: "300", label: "After 5 minutes" },
        ],
      },
      ...RESET_SCOPES.map((scope): HomeControl => ({
        id: `rs.${scope}`,
        section: "Erase my data",
        label: RESET_LABEL[scope].label,
        hint: RESET_LABEL[scope].hint,
        kind: "list",
        items: [],
        placeholder: resetPrompt,
        addLabel: "Erase",
      })),
      {
        id: "v.login",
        section: "Start",
        label: "Start Tessaya when I sign in",
        kind: "toggle",
        on: loginItem.on(),
      },
      {
        id: "v.startHome",
        section: "Start",
        label: "Open the Tessaya window when the app starts",
        kind: "toggle",
        on: settings.openTessayaOnStart,
      },
      {
        id: "v.startSessions",
        section: "Start",
        label: "Open the sessions window when the app starts",
        hint: "With both off, Tessaya starts in the background: the tray, the hotkey and the voice still work.",
        kind: "toggle",
        on: settings.openSessionsOnStart,
      },
      {
        id: "v.diag",
        section: "Checks",
        label: "Something is wrong and you want to report it",
        hint: "Makes one text file of versions, why Tessaya last stopped, and timings, with no dictated or spoken words, tokens, email addresses or user names. It is not sent anywhere: read it, then attach it yourself.",
        kind: "action",
        button: "Make a diagnostics file",
      },
      {
        id: "v.check",
        section: "Checks",
        label: "Is everything working?",
        hint: "Looks at the microphone, models, sign-ins, permission and disk.",
        kind: "action",
        button: "Run checks",
      },
      {
        id: "v.micTest",
        section: "Checks",
        label: "Microphone level",
        hint: "Listens for four seconds while you speak. Only when you press it.",
        kind: "action",
        button: levelTest === null ? "Test microphone" : "Listening…",
        disabled: loop === null || levelTest !== null,
      },
      ...(checks ?? []).map((c) => ({
        id: `v.result:${c.id}`,
        section: "Checks",
        label: c.title,
        kind: "check" as const,
        status: c.status,
        detail: c.detail,
        ...(c.fix === undefined ? {} : { fix: c.fix }),
      })),
      {
        id: "v.file",
        section: "Files",
        label: "Voice settings file",
        hint: "For anything not listed here.",
        kind: "action",
        button: "Open",
        more: true,
      },
    ],
  });

  // Idle, sleep and screen-lock all end here: the window must show locked at once.
  vaultState.onLock(() => vaultTab.onLock());

  /** Picks the T3 window's matching theme when it should follow (see `linkedT3Theme`); its own storage event repaints it live. */
  const linkT3Theme = async (palette: Palette): Promise<void> => {
    const t3 = Electron.BrowserWindow.getAllWindows().filter(
      (w) =>
        !w.isDestroyed() && !isCompanionWindow(w) && !w.webContents.getURL().startsWith("data:"),
    );
    // shortcut: with no T3 window open nothing is linked; the next palette change links it.
    const first = t3[0];
    if (first === undefined) return;
    try {
      const now = (await first.webContents.executeJavaScript(
        `({ theme: localStorage.getItem(${JSON.stringify(T3_THEME_KEY)}), halves: localStorage.getItem(${JSON.stringify(T3_THEME_HALVES_KEY)}) })`,
      )) as { theme: string | null; halves: string | null };
      const next = linkedT3Theme(palette, now, settings.t3ThemeLinked);
      if (next === null) return;
      const set = `localStorage.setItem(${JSON.stringify(T3_THEME_KEY)}, ${JSON.stringify(next)})`;
      const tell = `window.dispatchEvent(new StorageEvent("storage", { key: ${JSON.stringify(T3_THEME_KEY)}, newValue: ${JSON.stringify(next)} }))`;
      await first.webContents.executeJavaScript(set);
      for (const w of t3) await w.webContents.executeJavaScript(tell);
      if (!settings.t3ThemeLinked) save({ t3ThemeLinked: true });
    } catch {
      // A T3 window that is loading or gone keeps its theme; the palette here is already applied.
    }
  };

  /** One confirmation that says what goes with it, then the profile is deleted at once. */
  const forgetVoice = async (id: string, what: string) => {
    const answer = await (input.extras?.ask({
      title: `Delete ${what}?`,
      detail:
        id === "owner"
          ? "Tessaya will not know your voice until you enrol again."
          : "Tessaya will not know their voice any more, and what she remembers for them is deleted too.",
      buttons: ["Delete", "Cancel"],
      cancel: 1,
      expiresMs: 60_000,
    }) ?? Promise.resolve(1));
    if (answer === 0) voiceId.remove(id);
  };
  const applyHome = (id: string, value: string | boolean | null) => {
    const on = value === true;
    if (privateTab?.act(id, value)) return;
    if (memoryTab.act(id, value)) return;
    if (vaultTab.act(id, value)) return;
    if (id === "q.wake") loop?.activate("wake");
    else if (id === "q.ask" || id === "q.clear") {
      const entry = input.extras
        ?.menuItems()
        .find((i) => i.label === (id === "q.ask" ? "Ask Tessaya…" : "Clear the screen"));
      (entry?.click as (() => void) | undefined)?.();
    } else if (id === "q.stop") stopAll(false);
    else if (id === "q.quit") Electron.app.quit();
    else if (id.startsWith("q.open:")) {
      const target = homeExtra().paths.find((p) => `q.open:${p.id}` === id);
      if (target !== undefined) void Electron.shell.openPath(target.path);
    } else if (id === "d.import") {
      void Electron.dialog
        .showOpenDialog({
          properties: ["openFile"],
          filters: [{ name: "Words", extensions: ["csv", "txt", "json"] }],
        })
        .then((picked) => {
          const file = picked.filePaths[0];
          if (picked.canceled || file === undefined) return;
          if (NodeFS.statSync(file).size > IMPORT_MAX_BYTES) {
            input.extras?.notice("That file is over 3 MB.");
            return;
          }
          const done = importDictionary(NodeFS.readFileSync(file, "utf8"));
          if (done.refused !== undefined) return void input.extras?.notice(done.refused);
          for (const r of done.rows) dictionary = addEntry(dictionary, r);
          saveDictionary(input.stateDir, dictionary);
          input.extras?.notice(
            `Imported ${done.rows.length} words${done.skipped > 0 ? `; ${done.skipped} lines were skipped` : ""}.`,
          );
          render();
        })
        .catch(() => undefined);
    } else if (id === "d.import:later") {
      void Electron.dialog
        .showSaveDialog({
          defaultPath: "vocabulary.csv",
          filters: [{ name: "CSV", extensions: ["csv"] }],
        })
        .then((picked) => {
          if (picked.canceled || picked.filePath === undefined) return;
          NodeFS.writeFileSync(
            picked.filePath,
            exportDictionaryCsv(
              (dictionary as ReadonlyArray<VocabEntry>).map((d) => ({
                phrase: d.phrase,
                replacement: d.replacement ?? null,
              })),
            ),
          );
          input.extras?.notice("Vocabulary exported.");
        })
        .catch(() => undefined);
    } else if (id === "d.add" && typeof value === "string") {
      try {
        const entry = JSON.parse(value) as { phrase?: unknown; replacement?: unknown };
        if (typeof entry.phrase === "string") {
          dictionary = addEntry(dictionary, {
            phrase: entry.phrase,
            replacement: typeof entry.replacement === "string" ? entry.replacement : null,
          });
          saveDictionary(input.stateDir, dictionary);
        }
      } catch {
        // A malformed add from the page is ignored; the list stays as it was.
      }
    } else if (id === "d.edit" && typeof value === "string") {
      try {
        const e = JSON.parse(value) as { from?: unknown; phrase?: unknown; replacement?: unknown };
        if (typeof e.from === "string" && typeof e.phrase === "string") {
          dictionary = editEntry(dictionary, e.from, {
            phrase: e.phrase,
            replacement: typeof e.replacement === "string" ? e.replacement : null,
          });
          saveDictionary(input.stateDir, dictionary);
        }
      } catch {
        // A malformed edit is ignored; the list stays as it was.
      }
    } else if (id.startsWith("b.")) {
      const [verb, action] = [id.slice(2, id.indexOf(":")), id.slice(id.indexOf(":") + 1)];
      let next: ReadonlyArray<Binding> | null = null;
      const row = currentBindings().find((r) => r.def.id === action);
      bindingsNote = null;
      if (verb === "add" && typeof value === "string" && row !== undefined) {
        try {
          const parsed = parseBindings([{ action, inputs: [JSON.parse(value)] }])[0]?.inputs[0];
          if (parsed === undefined) bindingsNote = "That input could not be read.";
          else {
            const change = addInput(settings.bindings, action, row.inputs, parsed);
            if ("error" in change) bindingsNote = change.error;
            else next = change.saved;
          }
        } catch {
          next = null;
        }
      } else if (verb === "remove" && typeof value === "number" && row !== undefined) {
        next = removeInput(settings.bindings, action, row.inputs, value);
      } else if (verb === "clear") next = withBinding(settings.bindings, action, []);
      else if (verb === "reset") next = withBinding(settings.bindings, action, "reset");
      else if (verb === "resetAll") next = [];
      if (next === null) home.refresh();
      if (next !== null) {
        save({ bindings: next });
        applyBindings();
      }
    } else if (id === "d.forget") {
      rememberNever(dictionary.filter((e) => e.source === "learned").map((e) => e.phrase));
      dictionary = forgetLearned(dictionary);
      saveDictionary(input.stateDir, dictionary);
    } else if (id === "d.unhear" && typeof value === "string") {
      try {
        const e = JSON.parse(value) as { phrase?: unknown; form?: unknown };
        if (typeof e.phrase === "string" && typeof e.form === "string") {
          // A form he took off is not taught again by a correction.
          rememberNever([e.form]);
          dictionary = removeHeard(dictionary, e.phrase, e.form);
          saveDictionary(input.stateDir, dictionary);
        }
      } catch {
        // A malformed change is ignored; the list stays as it was.
      }
    } else if (id === "d.remove" && typeof value === "string") {
      // Deleting a word he did not add himself means he does not want it: it never comes back.
      if (dictionary.some((e) => e.phrase === value && e.source !== "added"))
        rememberNever([value]);
      dictionary = removeEntry(dictionary, value);
      saveDictionary(input.stateDir, dictionary);
    } else if (pluginOfControl(id) !== null) {
      const result = setPluginEnabled(claudeDir(), pluginOfControl(id)!, on);
      forgetFiles();
      if (result === "refused")
        note = "Could not change that plugin; its settings file was left alone.";
      home.refresh();
    } else if (id.startsWith("v.persona:") && typeof value === "string") {
      const picked = value === "default" ? null : value;
      setPersonaVoice(NodePath.join(input.stateDir, PACK_FOLDER), id.slice(10), picked);
      cachedPack.reset();
      home.refresh();
      if (picked !== null) input.audition?.(picked);
    } else if (id === "p.folder") {
      NodeFS.mkdirSync(NodePath.join(input.stateDir, PACK_FOLDER), { recursive: true });
      void Electron.shell.openPath(NodePath.join(input.stateDir, PACK_FOLDER));
    } else if (packEdit(id) !== null) {
      const act = packEdit(id)!;
      const dir = NodePath.join(input.stateDir, PACK_FOLDER);
      if (act.save) {
        const why = savePackText(dir, act.id, typeof value === "string" ? value : "");
        input.extras?.notice(why ?? "Saved. It applies to the next job.");
      } else useDefault(dir, act.id);
      cachedPack.reset();
      home.refresh();
    } else if (packAction(id) !== null) {
      const act = packAction(id)!;
      const dir = NodePath.join(input.stateDir, PACK_FOLDER);
      if (act.reset) {
        useDefault(dir, act.id);
        forgetFiles();
        home.refresh();
      } else {
        const file = fileToEdit(dir, act.id);
        forgetFiles();
        if (file !== null) void Electron.shell.openPath(file);
        home.refresh();
      }
    } else if (id === "m.folder") {
      NodeFS.mkdirSync(notes.dir, { recursive: true });
      void Electron.shell.openPath(notes.dir);
    } else if (noteAction(id) !== null) {
      const act = noteAction(id)!;
      if (act.remove) {
        notes.remove(act.id);
        forgetFiles();
        home.refresh();
      } else {
        const file = notes.list().find((n) => n.id === act.id)?.file;
        if (file !== undefined) void Electron.shell.openPath(file);
      }
    } else if (id === "a.load") wantJobs();
    else if (id.startsWith("a:")) {
      const act = approvalAction(id);
      if (act === null) return;
      if (act.kind === "plan") {
        // Approve is the same agree the voice path makes; Deny stops the worker, which has done nothing yet.
        void requestKept({ kind: "job", op: act.deny ? "stop" : "agree", args: { id: act.ref } })
          .then(refreshJobs)
          .catch(() => undefined);
      } else void input.sessions?.act(`n:${act.ref}`, null);
    } else if (id.startsWith("pr.")) {
      const patch = presencePatch(id, value, settings);
      if (patch !== null) save(patch);
    } else if (id.startsWith("sn.")) {
      const act = snippetAction(id, value);
      if (act?.kind === "put") {
        snippetNote = snippets.put(act.snippet) ? "" : "The list is full (500).";
      } else if (act?.kind === "bad") {
        snippetNote = "That is not a snippet. Write it as cue = the text it expands to.";
      } else if (act?.kind === "remove") snippets.remove(act.cue);
      else if (act?.kind === "import") {
        void Electron.dialog
          .showOpenDialog({
            properties: ["openFile"],
            filters: [{ name: "Snippets", extensions: ["json", "csv", "txt"] }],
          })
          .then((picked) => {
            const file = picked.filePaths[0];
            if (picked.canceled || file === undefined) return;
            const done = snippets.importText(NodeFS.readFileSync(file, "utf8"));
            snippetNote = `Imported ${done.added}${done.skipped > 0 ? `; ${done.skipped} lines were not snippets` : ""}.`;
            render();
          })
          .catch(() => undefined);
      } else if (act?.kind === "export") {
        void Electron.dialog
          .showSaveDialog({
            defaultPath: "snippets.json",
            filters: [{ name: "Snippets", extensions: ["json"] }],
          })
          .then((picked) => {
            if (picked.canceled || picked.filePath === undefined) return;
            NodeFS.writeFileSync(picked.filePath, exportSnippets(snippets.list()));
            snippetNote = "Exported.";
            render();
          })
          .catch(() => undefined);
      }
    } else if (/^sc[.:]/.test(id)) {
      const act = scratchAction(id, value);
      if (act?.kind === "add") {
        try {
          scratch.add(act.text);
        } catch {
          // Empty or too long: nothing is added.
        }
      } else if (act?.kind === "search") scratchQuery = act.query.trim();
      else if (act?.kind === "hotkey") {
        scratch.setHotkey(act.on);
        setNoteHotkey(act.on);
      } else if (act?.kind === "copy") {
        const note = scratch.notes().find((n) => n.id === act.id);
        if (note !== undefined) void Electron.clipboard.writeText(note.text);
      } else if (act?.kind === "delete") scratch.remove(act.id);
    } else if (id === "tf.pick" || id === "tf.file") {
      const run = (file: string) => {
        if (sidecar === null || parakeetPath === null) {
          input.extras?.notice("The speech model is not ready on this computer yet.");
          return;
        }
        input.extras?.notice(`Transcribing ${baseName(file)}...`);
        void transcribeFile(file, {
          readFile: (p) => NodeFS.promises.readFile(p),
          toWav: ffmpegToWav,
          transcribe: (pcm) =>
            makeSidecarStt(sidecar!, undefined, undefined, recognise).transcribe(pcm),
          progress: (done, total) => {
            if (total > 1)
              input.extras?.notice(
                `Transcribing ${baseName(file)}: ${done} of ${total} minutes...`,
              );
          },
        }).then((out) => {
          if (!out.ok) return void input.extras?.notice(out.why);
          try {
            scratch.add(`${transcriptTitle(file)}\n\n${out.text}`);
          } catch {
            // Too long for a note: the clipboard still has it.
          }
          void Electron.clipboard.writeText(out.text);
          input.extras?.notice(
            `${transcriptTitle(file)} is in your Scratchpad and on the clipboard.`,
          );
          render();
        });
      };
      if (id === "tf.file" && typeof value === "string") run(value);
      else {
        void Electron.dialog
          .showOpenDialog({
            properties: ["openFile"],
            filters: [{ name: "Audio", extensions: ACCEPTED_EXTENSIONS.map((e) => e.slice(1)) }],
          })
          .then((picked) => {
            const file = picked.filePaths[0];
            if (!picked.canceled && file !== undefined) run(file);
          })
          .catch(() => undefined);
      }
    } else if (id.startsWith("st.")) {
      const act = styleAction(id, value);
      if (act?.kind === "style") styles.set(act.category, act.style);
      else if (act?.kind === "level") {
        save({ dictationCleanupChosen: true, dictationCleanup: cleanupSettingOf(act.level) });
        syncCleanupSession();
      } else if (act?.kind === "guide") void runStyleGuide();
    } else if (id.startsWith("tr.")) {
      const act = transformAction(id, value);
      transformNote = "";
      if (act?.kind === "command") transforms.setCommand(act.on);
      else if (act?.kind === "enabled") {
        transforms.setEnabled(act.on);
        input.extras?.setTransformHotkeys?.(act.on);
      } else if (act?.kind === "auto") transforms.setAutoApply(act.id);
      else if (act?.kind === "put") {
        transformNote = transforms.put(act.transform) ? "" : "You can have 20 of your own.";
      } else if (act?.kind === "bad") {
        transformNote = "That is not a transform. Write it as Name = what to do with the text.";
      } else if (act?.kind === "remove") {
        transformNote = transforms.remove(act.id)
          ? ""
          : "A built-in cannot be removed; replace it with your own of the same name.";
      } else if (act?.kind === "reset") transforms.reset();
    } else if (id.startsWith("bk.")) {
      if (id === "bk.export")
        void backupExport()
          .catch((e) => void (backupNote = String(e)))
          .finally(pushHome);
      else if (id === "bk.restore")
        void backupChoose()
          .catch((e) => void (backupNote = String(e)))
          .finally(pushHome);
      else if (id === "bk.apply" && backupPreview !== null) {
        const n = applyRestore(backupPreview, input.stateDir);
        const kept = backupPreview.entries.find((e) => e.name === SERVER_MEMORY_NAME);
        const push = kept === undefined ? null : memoryRestore(kept.data, new Date().toISOString());
        if (push !== null) {
          void requestKept({ kind: "memory", op: "syncPush", args: push })
            .then((r) => {
              backupNote = `${backupNote ?? ""} Memory: ${(r as { applied?: number } | null)?.applied ?? 0} item(s) back.`;
            })
            .catch(() => {
              backupNote = `${backupNote ?? ""} Memory was not restored: open the sessions window and restore again.`;
            })
            .finally(pushHome);
        }
        const sealedBack = backupPreview.entries.find((e) => e.name === PRIVATE_MEMORY_NAME);
        if (sealedBack !== undefined && input.privateMemory !== undefined) {
          void input.privateMemory
            .call("restore", { dump: sealedBack.data.toString("utf8") })
            .then((r) => {
              const out = r as { stores: number; items: number };
              backupNote = `${backupNote ?? ""} Private memories: ${out.stores} store(s), ${out.items} item(s) back; each opens with its recovery code.`;
            })
            .catch((e: unknown) => {
              backupNote = `${backupNote ?? ""} Private memories were not restored: ${e instanceof Error ? e.message : "the server did not answer"}.`;
            })
            .finally(pushHome);
        }
        // Or the copies in memory are saved over what was just restored.
        settings = readSettings(settingsPath);
        dictionary = readDictionary(input.stateDir, dictionary);
        backupNote = `Restored ${n} file(s). Restart Tessaya to use all of them; yours were kept as .bak.`;
        backupPreview = null;
        forgetFiles();
      } else if (id === "bk.apply:later") backupPreview = null;
    } else if (/^cl\.(p|a|ok|deny)\./.test(id)) {
      void cloud.click(id).catch(() => undefined);
    } else if (id === "cl.refresh") void cloud.refresh().catch(() => undefined);
    else if (id === "cl.test") void cloud.test().catch(() => undefined);
    else if (id === "cl.set.on") saveCloud({ on });
    else if (id === "cl.set.ask") saveCloud({ askPopup: on });
    else if (id === "cl.set.hubEnv" && typeof value === "string") saveCloud({ hubEnv: value });
    else if (id === "cl.set.transport" && (value === "local" || value === "hub" || value === "ssh"))
      saveCloud({ transport: value });
    else if (id === "cl.set.cap")
      saveCloud({ capPoints: Math.max(1, Math.min(10, Number(value) || 2)) });
    else if (
      /^cl\.set\.(codexEnv|sshHost|sshUser|machineKey|approverKey|machineKeyVault|approverKeyVault)(:save|:reset)$/.test(
        id,
      )
    ) {
      const field = /^cl\.set\.(\w+):/.exec(id)![1] as
        | "codexEnv"
        | "sshHost"
        | "sshUser"
        | "machineKey"
        | "approverKey"
        | "machineKeyVault"
        | "approverKeyVault";
      saveCloud({
        [field]:
          id.endsWith(":save") && typeof value === "string" ? value.trim().slice(0, 300) : "",
      });
    } else if (id === "v.dnd") save({ doNotDisturb: on });
    else if (id === "v.snooze") toggleSnooze();
    else if (id === "q.setupDone") {
      save({ setupDone: true, setupOffered: true });
      NodeFS.rmSync(setupMarker, { force: true });
    } else if (id === "q.setupOffered") save({ setupOffered: true });
    else if (id === "q.setupStep" && typeof value === "string") {
      const step = Number(value);
      if (Number.isInteger(step) && step >= 0 && step < SETUP_STEPS.length)
        save({ setupStep: step });
    } else if (id === "setup.cloud.github") {
      void Electron.shell.openExternal("https://github.com/apps/claude");
    } else if (id.startsWith("cl.signin.")) {
      const command =
        cloud.view().detections[id.slice("cl.signin.".length) as ProviderId]?.signInCommand ?? "";
      const plan = terminalPlan(input.platform, command);
      if (plan !== null) {
        try {
          NodeChildProcess.spawn(plan.file, [...plan.args], {
            detached: true,
            stdio: "ignore",
            windowsHide: false,
          }).unref();
        } catch {
          input.extras?.notice(`Open a terminal and run: ${command}`);
        }
      }
    } else if (id === "setup.hold") {
      if (typeof value === "string" && HOLD_KEY_CHOICES.includes(value)) {
        const checked = checkInput({ type: "key", accelerator: value });
        if (checked.ok) {
          save({
            bindings: withBinding(settings.bindings, "hold", [{ type: "key", accelerator: value }]),
          });
          applyBindings();
        }
      }
    } else if (id === "trust.standing-run") {
      void standingTick().catch(() => undefined);
    } else if (id.startsWith("trust.")) {
      const act = trustAction(id, value);
      if (act?.kind === "filter") trustFilter = act.filter;
      else if (act?.kind === "standing") {
        if (BUILT_INS.some((j) => j.id === act.id))
          standingStore.setOn(act.id as BuiltInId, act.on);
      } else if (act?.kind === "userJob")
        userJobOp("user_job_update", { id: act.id, on: act.on }, true);
      else if (act?.kind === "userJobText")
        userJobOp("user_job_update", { id: act.id, instruction: act.text }, true);
      else if (act?.kind === "userJobDelete") userJobOp("user_job_delete", { id: act.id }, true);
      else if (act?.kind === "userJobWhy") {
        const job = userJobStore.get(act.id);
        const run = userJobStore
          .runs()
          .filter((r) => r.id === act.id)
          .at(-1);
        if (job !== undefined && run !== undefined)
          input.extras?.askAbout?.(askWhyPrompt(job.title, run.status, run.at, run.text));
      } else if (act?.kind === "missed") {
        const job = BUILT_INS.find((j) => j.id === act.id);
        if (job?.trigger.kind === "time") standingStore.setMissed(job.id, act.missed);
        else if (act.id.startsWith("user:")) userJobStore.update(act.id, { missed: act.missed });
      } else if (act?.kind === "quiet") {
        const job = BUILT_INS.find((j) => j.id === act.id);
        if (job?.trigger.kind === "event") standingStore.setQuiet(job.id, act.on);
      } else if (act?.kind === "rule") {
        void input
          .direct?.(`fabric.orchestration.rule.${act.on ? "enable" : "disable"}`, { id: act.id })
          .then(refreshRules)
          .catch(() => undefined);
      } else if (act?.kind === "unschedule") {
        void requestKept({
          kind: "job",
          op: "schedule",
          args: { id: act.jobId, everyMinutes: null },
        })
          .then(() => refreshJobs())
          .catch(() => undefined);
      } else if (act?.kind === "revoke") {
        if (act.what === "vault") vaultState.vault.lock();
        else {
          const toggle = {
            screen: "s.capture",
            chrome: "s.chrome",
            social: "s.social",
            act: "s.act",
            remote: "s.hands",
          }[act.what];
          input.extras?.applySetting(toggle, false);
        }
      } else if (act?.kind === "grant") {
        void requestKept({
          kind: "job",
          op: "revoke",
          args: { id: act.jobId, channel: act.channel },
        })
          .then(refreshJobs)
          .catch(() => undefined);
      }
    } else if (id === "now.refresh") void refreshNow().catch(() => undefined);
    else if (id.startsWith("now.")) {
      const act = nowAction(id);
      if (act?.kind === "commitment") {
        try {
          commitments.close(act.id, act.drop ? "dropped" : "done");
        } catch {
          // Already closed elsewhere; the refresh shows the truth.
        }
      } else if (act?.kind === "allow") initiative.allow(act.topic);
      else if (act?.kind === "why" && act.job.startsWith("user:")) {
        const job = userJobStore.get(act.job);
        const run = userJobStore.runs().find((r) => r.id === act.job && r.at === act.at);
        if (job !== undefined && run !== undefined)
          input.extras?.askAbout?.(askWhyPrompt(job.title, run.status, run.at, run.text));
      } else if (act?.kind === "why") {
        const run = standingStore.load().runs.find((r) => r.id === act.job && r.at === act.at);
        const job = BUILT_INS.find((j) => j.id === run?.id);
        if (run !== undefined && job !== undefined)
          input.extras?.askAbout?.(askWhyPrompt(job.title, statusOf(run), run.at, run.text));
      } else if (act?.kind === "continue") {
        interruptedNow = interruptedNow.filter((m) => m.id !== act.id);
        recovery.writeMarks(interruptedNow);
        void requestKept({
          kind: "job",
          op: "refine",
          args: { id: act.id, text: CONTINUE_TEXT, via: "text" },
        })
          .then(refreshJobs)
          .catch(() => undefined);
      }
      void refreshNow().catch(() => undefined);
    } else if (id === "j.load") wantJobs();
    else if (/^j[as]?:/.test(id)) {
      const act = jobAction(jobsCache ?? [], id);
      const job = (op: BatonJobBridgeRequest["op"], args: Record<string, unknown>) =>
        void requestKept({ kind: "job", op, args })
          .then(refreshJobs)
          .catch(() => undefined);
      if (act === null) return;
      if (act.kind === "draft") {
        void draftSkill(act.id)
          .then((line) => input.extras?.notice(line))
          .catch(() => undefined);
      } else if (act.kind === "retry") {
        void retryJob(act.id, "the last attempt failed")
          .then((line) => input.extras?.notice(line))
          .then(refreshJobs)
          .catch(() => undefined);
      } else if (act.kind === "stop") job("stop", { id: act.id });
      else if (act.kind === "schedule") {
        job("schedule", { id: act.id, everyMinutes: act.scheduled ? null : DAILY_MINUTES });
      } else if (act.kind === "answer") {
        if (typeof value === "string" && value.trim() !== "") {
          job("refine", { id: act.id, text: value, via: "text" });
        }
      } else if (act.approve) job("agree", { id: act.id });
      else input.openMainWindow();
    } else if (input.catalog?.apply(id, value) === true) {
      // The catalog redraws itself through its own onChange.
    } else if (id.startsWith("n:")) {
      void input.sessions?.act(id, typeof value === "string" ? value : null);
    } else if (id.startsWith("u.")) input.updates?.apply(id);
    else if (id.startsWith("s.")) {
      input.extras?.applySetting(id, value);
      // Picking a voice plays a short sample of it, so choosing is not guessing.
      if (id === "s.voice" && typeof value === "string" && value !== "system")
        input.audition?.(value);
    } else if (id === "v.enabled") {
      save({ enabled: on });
      void (on ? start().catch(failed) : stop());
    } else if (id === "v.muted") {
      if ((loop?.isMuted() ?? false) !== on) toggleMute();
    } else if (id === "v.direct") {
      if ((state === "direct_session") !== on) loop?.activate("toggle_direct_session");
    } else if (id === "v.mic") {
      pickMic(typeof value === "string" && value !== "" ? value : null);
    } else if (id.startsWith("v.micOrder:")) {
      const at = Number(id.slice("v.micOrder:".length));
      save({
        micOrder: setMicAt(
          settings.micOrder,
          at,
          typeof value === "string" && value !== "" ? value : null,
        ),
      });
      void restart();
    } else if (id.startsWith("v.wake:")) {
      const word = id.slice("v.wake:".length);
      save({
        wakeWords: settings.wakeWords.map((w) => (w.word === word ? { ...w, enabled: on } : w)),
      });
      void relisten();
    } else if (id === "v.dictation" && (value === "baton" || value === "wispr"))
      setDictation(value);
    else if (id === "v.download") requestDictation();
    else if (id === "v.cleanup" && (value === "claude" || value === "local" || value === "off")) {
      save({ dictationCleanupChosen: true, dictationCleanup: value });
      syncCleanupSession();
    } else if ((id === "v.language:add" || id === "v.language:rm") && typeof value === "string") {
      // His personal model is a v3 fine-tune: the same languages.
      const code = languageCode(
        id.endsWith(":add") && settings.speechModel === "fast" ? "fast" : "v3",
        value,
      );
      const v3Code = code === undefined ? languageCode("v3", value) : undefined;
      if (settings.speechModelPicked === "machine" && v3Code !== undefined) {
        languageOffer = v3Code;
        return render();
      }
      if (code === undefined) {
        note = `${value.trim()} is not a language this speech model knows.`;
        return render();
      }
      save({
        languages: id.endsWith(":add")
          ? [...new Set([...settings.languages, code])]
          : settings.languages.filter((c) => c !== code),
      });
      configureDictation();
    } else if (id === "v.recognition" && (value === "local" || value === "cloud")) {
      save({ recognition: value });
      configureDictation();
      if (value === "cloud") loadCloudModels(settings.cloudProvider, true);
    } else if (id === "v.cloudProvider" && typeof value === "string") {
      const provider = CLOUD_STT_PROVIDERS.find((p) => p === value);
      if (provider === undefined) return;
      save({ cloudProvider: provider, cloudModel: null });
      cloudTestResult = null;
      configureDictation();
      loadCloudModels(provider, true);
    } else if (id === "v.cloudModel" && typeof value === "string" && value !== "") {
      save({ cloudModel: value });
      cloudTestResult = null;
    } else if (id === "v.cloudKey:add" && typeof value === "string") {
      try {
        cloudKeys.set(settings.cloudProvider, value);
        note = null;
      } catch (error) {
        note = error instanceof Error ? error.message : String(error);
      }
      cloudTestResult = null;
      configureDictation();
      loadCloudModels(settings.cloudProvider, true);
      render();
    } else if (id === "v.cloudKey:rm") {
      cloudKeys.clear(settings.cloudProvider);
      delete cloudModels[settings.cloudProvider];
      configureDictation();
      render();
    } else if (id === "v.cloudTest") void testCloud();
    else if (
      id === "v.speechModel" &&
      (value === "v3" || value === "fast" || (value === "personal" && personalPath !== null))
    )
      setSpeechModel(value);
    else if (id === "v.speechModelOffer" && languageOffer !== null) {
      save({ languages: [...new Set([...settings.languages, languageOffer])] });
      languageOffer = null;
      setSpeechModel("v3");
    } else if (id === "v.appMode" && typeof value === "string" && focusedApp.exe.length > 0) {
      const exe = focusedApp.exe.toLowerCase();
      const { [exe]: _old, ...others } = settings.appModes;
      save({
        appModes: value === "" ? others : { ...others, [exe]: value as DictationMode },
      });
    } else if (id === "v.copyLast") {
      const last = lastReply ?? lastDictation;
      if (last !== null) void Electron.clipboard.writeText(last);
    } else if (id === "v.keepVoice") {
      save({ keepVoice: on });
      // The helper writes key dictations' recordings only while he keeps audio.
      configureDictation();
    } else if (id === "v.keepDays" && typeof value === "string") {
      save({ keepDays: Math.max(1, Number(value) || 30) });
      retention();
    } else if (id === "v.keepCap" && typeof value === "string") {
      save({ keepCapGb: Math.max(1, Number(value) || 2) });
      retention();
    } else if (id === "v.keepSpace") {
      for (const turn of history?.list({ limit: 1_000_000 }) ?? []) {
        if (turn.audio === null) continue;
        for (const path of clipPaths(turn.audio)) NodeFS.rmSync(path, { force: true });
        history?.update(turn.id, { audio: null });
      }
      render();
    } else if (id === "v.pillPlace" && value === "taskbar") {
      save({ pillEdge: "bottom" });
      pill.reposition();
      pill.putBack();
    } else if (
      id === "v.pillPlace" &&
      typeof value === "string" &&
      PLACES.some((p) => p.id === value)
    ) {
      save({ pillEdge: value === "top" ? "top" : "bottom" });
      pill.moveTo(value as PlaceId);
    } else if (id === "v.pillHide") {
      save({
        pillHiddenUntil: Date.now() < settings.pillHiddenUntil ? 0 : Date.now() + HIDE_FOR_MS,
      });
      if (!restWanted()) pill.setRest(false);
      else if (settings.pillAtRest) pill.setRest(true);
      barShown = restWanted();
    } else if (id === "v.pillFull") save({ hideInFullscreen: on });
    else if (id === "v.duck" && (value === "off" || value === "lower" || value === "mute")) {
      save({ duckWhileDictating: value });
    } else if (id === "v.silence" && typeof value === "string") {
      save({
        micSilenceSeconds: [0, 30, 90, 300].includes(Number(value))
          ? Number(value)
          : DEFAULT_SILENCE_SECONDS,
      });
      silence.reset();
    } else if (id.startsWith("rs.") && id.endsWith(":add")) {
      const scope = id.slice(3, -4) as ResetScope;
      if (!RESET_SCOPES.includes(scope)) return;
      if (typeof value !== "string" || !confirmed(value)) {
        input.extras?.notice(`Nothing was erased. ${resetPrompt}.`);
        return;
      }
      void eraseData(scope).then((line) => {
        input.extras?.notice(line);
        render();
      });
    } else if (id === "v.pillMove") pill.setMoving(wantsMoving(value));
    else if (id === "v.appearance") save({ appearance: parseAppearance(value) });
    else if (id === "v.palette") {
      save({ palette: parsePalette(value) });
      void linkT3Theme(settings.palette);
    } else if (id === "v.pillDesign") save({ pillDesign: parsePillDesign(value) });
    else if (id === "v.pillWaveform") save({ pillWaveform: parsePillWave(value) });
    else if (id === "v.motion") save({ motion: parseMotion(value) });
    else if (id === "v.glass") save({ glass: parseGlass(value) });
    else if (id === "v.hideFromCapture") {
      save({ hideFromCapture: on });
      setHideFromCapture(on);
    } else if (id === "v.learnWords") save({ learnWords: on });
    else if (id === "v.showWords") {
      save({ showWords: on });
      configureDictation();
    } else if (id === "v.pillStyle" && (value === "pill" || value === "field"))
      save({ pillStyle: value });
    else if (id === "v.gpu" && (value === "auto" || value === "on" || value === "off")) {
      save({ gpuRecognition: value });
      configureDictation();
    } else if (id === "v.recognizeOnServers") {
      save({ recognizeOnServers: on });
      configureDictation();
    } else if (id === "v.recognizer:add" && typeof value === "string") {
      const [url = "", token = ""] = value.trim().split(/\s+/);
      if (!recognizerUrlAllowed(url) || token === "")
        note =
          "Give a ws:// address on your tailnet (its own address or MagicDNS name) and the token: ws://host:port token";
      else {
        try {
          recognizerKeys.set(url, token);
          save({ recognizers: [...settings.recognizers.filter((u) => u !== url), url] });
          note = null;
        } catch (error) {
          note = error instanceof Error ? error.message : String(error);
        }
      }
      configureDictation();
      render();
    } else if (id === "v.recognizer:rm" && typeof value === "string") {
      recognizerKeys.clear(value);
      save({ recognizers: settings.recognizers.filter((u) => u !== value) });
      configureDictation();
      render();
    } else if (id === "v.composerMic") {
      save({ composerMic: value === "t3" ? "t3" : "tessaya" });
    } else if (id === "v.doubleTap") {
      save({ doubleTap: on });
      configureDictation();
    } else if (id === "v.audition") input.audition?.(typeof value === "string" ? value : null);
    else if (id === "v.cues") save({ cues: parseCueLevel(value) });
    else if (id === "v.holdKeyCues") save({ holdKeyCues: on });
    else if (id === "v.frosted") save({ frosted: on });
    else if (id === "v.verifyWake") save({ verifyWake: on });
    else if (
      id === "v.headphones" &&
      (value === "auto" || value === "headphones" || value === "speakers")
    )
      save({ outputDevice: value });
    else if (VOICE_ID_SWITCHES[id] !== undefined) {
      save({ voiceId: { ...settings.voiceId, [VOICE_ID_SWITCHES[id]]: on } });
      voiceId.sync();
    } else if (id === "vid.enrol") voiceId.read({ kind: "owner" });
    else if (id === "vid.enrol:later") void forgetVoice("owner", "your voice profile");
    else if (id === "vid.people:add" && typeof value === "string" && value.trim() !== "")
      voiceId.read({ kind: "saved", name: value.trim().slice(0, 40) });
    else if (id === "vid.people:rm" && typeof value === "string") {
      const person = voiceId.profiles().find((p) => p.kind === "saved" && p.name === value);
      if (person !== undefined) void forgetVoice(person.id, `${person.name}'s voice`);
    } else if (id === "v.voiceBargeIn") {
      save({ voiceBargeIn: on });
      void relisten();
    } else if (id === "v.quietSpeech") {
      save({ quietSpeech: on });
      void relisten();
    } else if (id === "v.waitMs") save({ waitMs: clampWait(Number(value)) });
    else if (id === "v.listenAfterWake" && LISTEN_AFTER_WAKE_MS.includes(Number(value))) {
      save({ wakeListenMs: Number(value) });
    } else if (id === "v.conversation" && CONVERSATION_MS.includes(Number(value))) {
      save({ conversationOpenMs: Number(value) });
    } else if (
      id === "v.notice" &&
      (value === "off" || value === "written" || value === "spoken")
    ) {
      save({ noticeMode: value });
    } else if (id === "v.brief" && (value === "off" || value === "written" || value === "spoken")) {
      save({ briefMode: value });
      // The brief is the lead's standing job: this setting switches it too.
      standingStore.setOn("morning_brief", value !== "off");
    } else if (
      id === "v.quiet" &&
      typeof value === "string" &&
      /^(none|\d{1,2}-\d{1,2})$/.test(value)
    ) {
      save({ quietHours: value });
    } else if (id === "v.pillRest") {
      save({ pillAtRest: on });
      pill.setRest(on);
    } else if (id === "v.login") {
      save({ openAtLogin: on });
      loginItem.set(on);
    } else if (id === "v.startHome") save({ openTessayaOnStart: on });
    else if (id === "v.startSessions") save({ openSessionsOnStart: on });
    else if (id === "k.addskill:add" && typeof value === "string") {
      void addSkillFrom(value);
    } else if (/^k\.conn\.(calendar|mail|chat):add$/.test(id) && typeof value === "string") {
      void addConnector(id.split(".")[2]!.split(":")[0] as ConnectorKind, value);
    } else if (id === "v.diag") {
      try {
        const file = makeDiagnosticsFile({
          stateDir: input.stateDir,
          logDir: input.logDir,
          version: Electron.app.getVersion(),
          settingsFile: settingsPath,
        });
        Electron.shell.showItemInFolder(file);
        input.extras?.notice(
          "The diagnostics file is made and shown in its folder. Nothing was sent.",
        );
      } catch {
        input.extras?.notice("The diagnostics file could not be made.");
      }
    } else if (id === "v.check") void runAllChecks();
    else if (id === "v.micTest") testMic();
    else if (id === "v.file") {
      save({});
      void Electron.shell.openPath(settingsPath);
    }
    render();
  };

  const home = createBatonHome({
    stateDir: input.stateDir,
    state: homeState,
    apply: applyHome,
    // The Sessions tab is T3's own thread list, filtered to live sessions (P5).
    openSessions: (liveOnly) => {
      input.openMainWindow();
      if (liveOnly) void showLiveWhenReady(input.sessions);
    },
    onTab: (tab) => {
      if (tab === "jobs" || tab === "approvals") wantJobs();
      if (tab === "memory") {
        void memoryTab.load();
        void privateTab?.load();
      } else privateTab?.close();
      if (tab === "approvals") void cloud.refresh().catch(() => undefined);
      // The Cloud page refreshes every minute while it is open, and not otherwise.
      if (cloudTimer !== null) {
        clearInterval(cloudTimer);
        cloudTimer = null;
      }
      if (tab === "cloud") {
        void cloud.refresh().catch(() => undefined);
        cloudTimer = setInterval(() => void cloud.refresh().catch(() => undefined), 60_000);
        cloudTimer.unref();
      }
    },
    appearance: () => settings.appearance,
    look: () => ({ motion: settings.motion, glass: settings.glass, palette: settings.palette }),
    quietLaunch: () => Electron.app.getLoginItemSettings().wasOpenedAtLogin === true,
    level: () => micNow,
  });
  // First run after an update: the list was just resolved and rewritten, so the window is told once more.
  setTimeout(pushHome, 3_000).unref();

  let speakingNow = false;

  // Building a native menu is a synchronous call into the OS: only when what it shows changed, not per render.
  let menuShown = "";
  const rebuildMenu = () => {
    home.refresh();
    const template: Electron.MenuItemConstructorOptions[] = [
      { label: `Tessaya: ${hudView(state).label}`, enabled: false },
      ...(note ? [{ label: note, enabled: false }] : []),
      { type: "separator" },
      {
        label: "Always listening",
        type: "checkbox",
        enabled: binary !== null,
        checked: settings.enabled,
        click: (item) => {
          save({ enabled: item.checked });
          void (item.checked ? start().catch(failed) : stop());
        },
      },
      {
        label: "Mute",
        type: "checkbox",
        accelerator: VOICE_HOTKEYS[2]!.accelerator,
        checked: loop?.isMuted() ?? false,
        enabled: loop !== null,
        click: () => toggleMute(),
      },
      { label: "Wake now", enabled: loop !== null, click: () => loop?.activate("wake") },
      {
        label: "Microphone",
        submenu: [
          {
            label: "Automatic (system default)",
            type: "checkbox",
            checked: settings.pinnedLabel === null,
            click: () => pickMic(null),
          },
          { type: "separator" },
          ...realDevices(devices).map((d) => ({
            label: d.label || "Unnamed microphone",
            type: "checkbox" as const,
            checked: d.label === choiceSummary(choice).mic,
            click: () => pickMic(d.label),
          })),
        ],
      },
      {
        // The same dictation as the keys, buttons and words: it starts, or ends and pastes, whichever is running.
        label: dictatingByVoice || keyRecording() ? "Stop dictation" : "Start dictation",
        enabled: settings.dictation === "baton" && binary !== null,
        click: () => void moveDictation("toggle"),
      },
      {
        label: "Copy last transcript or reply",
        enabled: (lastReply ?? lastDictation) !== null,
        click: () => {
          const last = lastReply ?? lastDictation;
          if (last !== null) Electron.clipboard.writeText(last);
        },
      },
      {
        label: "Move pill",
        type: "checkbox",
        checked: pill.moving(),
        click: (item) => pill.setMoving(item.checked),
      },
      { type: "separator" },
      ...(input.extras?.menuItems() ?? []),
      ...(input.extras ? [{ type: "separator" as const }] : []),
      ...(input.updates?.ready() === true
        ? [{ label: "● Update ready: Install and restart", click: input.updates.install }]
        : []),
      { label: "Open Tessaya", click: () => home.open() },
      { label: "Quit", click: () => Electron.app.quit() },
    ];
    const shown = JSON.stringify(template);
    if (shown === menuShown) return;
    menuShown = shown;
    tray.setContextMenu(Electron.Menu.buildFromTemplate(template));
  };

  const failed = (error: unknown) => {
    step("error", { message: error instanceof Error ? error.message : String(error) });
    note = error instanceof Error ? error.message : "The microphone could not be opened.";
    void stop();
  };

  const setDictation = (dictation: VoiceSettings["dictation"]) => {
    save({ dictation });
    syncCleanupSession();
    configureDictation();
    render();
    if (dictation === "baton") requestDictation();
  };

  const setSpeechModel = (speechModel: VoiceSettings["speechModel"]) => {
    save({
      speechModel,
      speechModelPicked: "you",
      ...(speechModel === "fast" ? { languages: ["en"] } : {}),
    });
    if (parakeetPath !== null || settings.enabled) requestDictation();
    else render();
  };

  const restart = async () => {
    const source = audio ?? (sidecar === null ? null : { listDevices: listSidecarDevices });
    if (source === null) return render();
    devices = await source.listDevices();
    reselect();
    note = choice.kind === "default" && settings.pinnedLabel !== null ? choice.reason : null;
    configureDictation();
    speakerIdentity.reset();
    await loop?.switchDevice(choiceDeviceId(choice));
    render();
  };

  /** Wake words are fixed when the core is built, so a change rebuilds it. */
  const relisten = () =>
    lifecycle(async () => {
      if (loop !== null) await stopNow();
      await startOrClean().catch(failed);
    });

  const toggleMute = () => {
    loop?.activate("toggle_mute");
    pill.on({ type: "muted", on: loop?.isMuted() ?? false });
  };
  let registered: string[] = [];
  const handlers: Readonly<Record<string, () => void>> = (bindingHandlers = {
    wake: () => loop?.activate("wake"),
    direct: () => loop?.activate("toggle_direct_session"),
    mute: () => toggleMute(),
    dictation: () => void moveDictation("toggle"),
    stop: () => stopAll(false),
    clear: () => {
      const clear = input.extras?.menuItems().find((i) => i.label === "Clear the screen");
      (clear?.click as (() => void) | undefined)?.();
    },
    pasteLast: () => {
      const last = lastInserted.last();
      const side = sidecar;
      if (last === null || last === "" || side === null) return;
      // Into the window in front, with the dictation paste's checks: never into a password box.
      void pasteInOrder(async () => {
        const now = await side.foreground().catch(() => null);
        const why =
          now?.window === undefined
            ? "gone"
            : await side.pasteChecked(last, now.window, now.title).catch(() => "refused" as const);
        if (why !== "ok")
          keepText(why === "secret" ? "That box is for a password" : "Not pasted", last);
      });
    },
    ask: () => {
      const ask = input.extras?.menuItems().find((i) => i.label === "Ask Tessaya…");
      (ask?.click as (() => void) | undefined)?.();
    },
  });
  /** Puts every key he has set in place, and takes the old ones away. Mouse buttons go to the hook. */
  const applyBindings = () => {
    for (const accelerator of registered) Electron.globalShortcut.unregister(accelerator);
    registered = [];
    const taken: string[] = [];
    // The mouse side: the hook in the dictation sidecar reads this file; an empty list is no hook.
    try {
      NodeFS.mkdirSync(NodePath.join(input.stateDir, "voice"), { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(input.stateDir, "voice", "input-bindings.json"),
        JSON.stringify(mouseHookConfig(currentBindings())),
      );
    } catch {}
    for (const row of currentBindings()) {
      const keys = row.inputs.flatMap((i) =>
        i.type === "key" ? [toElectronAccelerator(i.accelerator)] : [],
      );
      if (row.def.id === "ask") input.extras?.setAskHotkey(keys[0] ?? null);
      if (row.def.id === "hold" || row.def.id === "toggle") continue;
      const handler = row.def.id === "ask" ? handlers["ask"] : handlers[row.def.id];
      for (const accelerator of row.def.id === "ask" ? keys.slice(1) : keys) {
        // A chord another app already owns is skipped, not fatal; the tray still works, and the page says so.
        if (handler === undefined) continue;
        if (Electron.globalShortcut.register(accelerator, handler)) registered.push(accelerator);
        else taken.push(accelerator);
      }
    }
    takenNote =
      taken.length === 0
        ? null
        : `${taken.join(", ")} ${taken.length === 1 ? "is" : "are"} held by Windows or another app, so ${taken.length === 1 ? "it does" : "they do"} nothing here. Choose another key, or remap that button to F13 in its own software.`;
    const first = (action: string) => keysOf(action)[0];
    const holdKey = first("hold") ?? settings.holdKey;
    const toggleKey = first("toggle") ?? settings.toggleKey;
    if (holdKey !== settings.holdKey || toggleKey !== settings.toggleKey)
      save({ holdKey, toggleKey });
    configureDictation();
    // Unbinding the last dictation key ends the Claude session it kept warm.
    syncCleanupSession();
  };
  applyBindings();
  // An agent's change to his dictation settings, through this machine's server, applied as his own click would be.
  const direct = input.direct;
  if (direct !== undefined) {
    const remote = createRemoteSettings({
      // The server holds a sync open up to 25 s while nothing waits: the wait covers it.
      sync: (body) => direct(BATON_DESKTOP_SETTINGS_WS_METHODS.sync, body, 30_000),
      current: () => settings,
      apply: applyHome,
    });
    const remoteLoop = () =>
      void remote
        .tick()
        .then(
          () => REMOTE_SETTINGS_GAP_MS,
          () => REMOTE_SETTINGS_RETRY_MS,
        )
        .then((ms) => setTimeout(remoteLoop, ms).unref());
    setTimeout(remoteLoop, REMOTE_SETTINGS_RETRY_MS).unref();
  }
  Electron.app.on("will-quit", () => {
    for (const accelerator of registered) Electron.globalShortcut.unregister(accelerator);
    void audio?.stop();
    rewriter.dispose();
    encoder.dispose();
    toast.dispose();
    history?.close();
    sidecar?.dispose();
  });

  // Hand edits to the settings file take effect without a restart.
  NodeFS.watchFile(settingsPath, { interval: 2_000 }, () => {
    const before = JSON.stringify(settings);
    settings = readSettings(settingsPath);
    const after = JSON.stringify(settings);
    pushHome();
    if (before === after) return;
    configureDictation();
    applyBindings();
    void relisten();
  });
  // The silence check runs on the clock too: a stalled stream delivers no frames to judge.
  const watchSilence = () => {
    if (loop === null || loop.isMuted()) return silence.reset();
    if (silence.check(Date.now()) !== "warn") return;
    const message = `I can't hear your microphone (${deviceName()}). Right-click the tray to pick another.`;
    pill.on({ type: "trouble", message });
    input.extras?.notice(message);
  };
  setInterval(() => {
    onDeviceChange();
    watchSilence();
  }, MIC_POLL_MS).unref();

  render();
  // First run after install opens both windows; after that the Start switches decide (launchWindows.ts).
  const shownPath = NodePath.join(input.stateDir, "baton-home.shown");
  const firstRun = !NodeFS.existsSync(shownPath);
  if (firstRun) {
    NodeFS.writeFileSync(shownPath, new Date().toISOString());
    NodeFS.writeFileSync(setupMarker, "");
  }
  const launch = launchWindows({
    openTessaya: settings.openTessayaOnStart,
    openSessions: settings.openSessionsOnStart,
    firstRun,
  });
  holdMainAtLaunch(!launch.sessions);
  if (launch.tessaya) setTimeout(() => home.open(), 2_000).unref();
  void verifyPersonalModel(personalModelsDir(NodeOS.homedir())).then((found) => {
    // Never the folder's contents: only whether it verified, and why not.
    if (found.ok) personalPath = found.path;
    else if (found.why !== "none") input.onNote?.("personal_model", { refused: found.why });
    if (usePersonal() && parakeetPath !== null && parakeetPath !== personalPath) requestDictation();
    else render();
  });
  // Keys and the sidecar only once the model is here: nothing global before he asks for it.
  const atLaunch = dictationAtLaunch({
    available: binary !== null,
    dictation: settings.dictation,
    modelPresent: modelPresent(modelsDir, speechModel()),
    wakeOn: settings.enabled,
  });
  if (atLaunch === "now") requestDictation();
  else if (atLaunch === "settled") {
    // Asked again when it fires: he may have switched engine, or pressed the key and loaded it already, meanwhile.
    setTimeout(() => {
      const now = dictationAtLaunch({
        available: binary !== null,
        dictation: settings.dictation,
        modelPresent: modelPresent(modelsDir, speechModel()),
        wakeOn: settings.enabled,
      });
      if (now !== "never" && parakeetPath === null) requestDictation();
    }, DICTATION_SETTLE_MS).unref();
  }
  void start().catch(failed);
  return {
    refresh: render,
    openHome: () => home.open(),
    busy: () => speakingNow || !["sleeping", "listening", "muted"].includes(state),
    onSpeaking: (active) => {
      // Her reply starts: whether he can talk over it depends on what she is playing through now.
      if (active && !speakingNow) setImmediate(() => void output.refresh());
      speakingNow = active;
      recogniserPriority.speaking(active);
      core?.setSpeaking(active);
      pill.on({ type: "speaking", active });
    },
    onSpoken: (text) => core?.noteSpoken(text),
    respellings: () => settings.pronounce,
    onPlaying: (text) => core?.playing(text),
    onTurnEnd: () => pill.on({ type: "finished" }),
    cue: (name) => pill.cue(name),
    onActivity: (label, caption) =>
      pill.on({ type: "activity", label, ...(caption === undefined ? {} : { caption }) }),
    onSpeechLevel: pill.speechLevel,
    onReference: (pcm, rate, soundsAtMs) => core?.reference(resampleTo16k(pcm, rate), soundsAtMs),
    onDismissed: () => pill.on({ type: "dismissed" }),
    onNote: (message) => {
      note = message;
      render();
    },
  };
};
