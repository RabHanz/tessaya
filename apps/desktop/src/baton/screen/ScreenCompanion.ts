// @effect-diagnostics globalDate:off globalTimers:off nodeBuiltinImport:off
/**
 * The assistant (D84, D100): answers, look, teach and drive, by voice or from the ask box. The one
 * brain decides which; every capture still needs his yes (once, an hour, this lesson, or always)
 * and every drive plan its own Run it. How each mode runs is in docs/baton/SCREEN.md.
 */
import { createModelAsk } from "../writing/modelAsk.ts";
import { appOf, tracedTurns } from "@t3tools/baton-shared/skillLearning";
import { replayTurn } from "../agent/replay.ts";
import { createStandingStore } from "../presence/standingJobs.ts";
import {
  decideSkill,
  learnedAction,
  learnedControls,
  keepRecentTurn,
  learnFromTurn,
  learnNightly as learnNightlyFrom,
  pruneRecentTurns,
  readSkills,
  readStates,
  skillsDirOf,
  skillsForTurn,
  type LastTurn,
} from "../pack/learnedSkills.ts";
import { createTextEdit } from "../writing/textEdit.ts";
import { createTransformStore } from "../writing/transformStore.ts";
import { changedFrom, writeJsonFile } from "../writing/jsonStore.ts";
import { PACK_FOLDER, readPack } from "../pack/packRows.ts";
import { DEFAULT_ROUTING, parseRouting } from "@t3tools/baton-shared/costRouting";
import {
  standingTurnText,
  userJobCard,
  userJobFromArgs,
  whenText,
} from "@t3tools/baton-shared/userJobs";
import { standingGate } from "../agent/standingGate.ts";
import { runOnceItsTurn } from "../agent/standingRun.ts";
import {
  chooseTurnBrain,
  createTierMemories,
  manualLabel,
  modelCommand,
  tierBrains,
  type ManualBrain,
} from "@t3tools/baton-shared/turnTier";
import type { CutIn } from "@t3tools/baton-shared/endOfTurn";
import { HOTKEY_PREFIX, hotkeyFor } from "../writing/transformRows.ts";
import { redactFocusLabel } from "@t3tools/baton-shared/awareness";
import { detectSecret } from "@t3tools/baton-shared/memory";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  ASSISTANT_PROMPT_INTRO,
  clockLine,
  OPERATOR_PROMPT,
  guardDecision,
  instantDecision,
  makeSentenceStream,
  type BrainDecision,
} from "@t3tools/baton-shared/brain";
import {
  LOOK_PROMPT,
  TEACH_PROMPT,
  needsCaptureApproval,
  rememberOutside,
  parseReply,
  pointable,
  screensDifference,
  teachShouldLook,
  isPasteKeys,
  isShellWindow,
  keysRefusal,
  missingDisplaysNote,
  screenLabel,
  shotFor,
  teachTurn,
  toDesktop,
  type CaptureApproval,
  type ScreenMode,
  type ScreenShot,
} from "@t3tools/baton-shared/screenCompanion";
import {
  describeToolCall,
  gatePrompt,
  spokenOutcome,
  announceTool,
  type ToolCall,
} from "@t3tools/baton-shared/operator";
import { decideTrust } from "@t3tools/baton-shared/trust";
import * as Electron from "electron";

import {
  holdAfterSpeechMs,
  pageText,
  queueSpeech,
  readingMs,
} from "@t3tools/baton-shared/companionPacing";

import {
  SessionClosed,
  startVisionSession,
  type VisionContent,
  type VisionSession,
} from "./claudeVision.ts";
import { startCodexOperator } from "./codexOperator.ts";
import { createCompanionWindows, type AnswerOutput } from "./companionWindows.ts";
import { brainRows, canChoose, type BrainStatus } from "./brainChoice.ts";
import { detectBrains } from "./brainDetect.ts";
import { textIsFromConversation, type ConversationRoute } from "@t3tools/baton-shared/conversation";
import { BATON_TOOL_PREFIX } from "@t3tools/baton-shared/operator";
import { createMouseConsent, pointerMoved } from "../agent/pointerGuard.ts";
import {
  createAgentGate,
  createCutInMark,
  createTaint,
  stopsOnCutIn,
  type Gate,
} from "../agent/agentGate.ts";
import { createOutsideSlot } from "../agent/outsideSlot.ts";
import { createTurnLock, INTERRUPTED, labelPrompt } from "./turnLock.ts";
import type { DesktopStateInput } from "../phone/desktopState.ts";
import { createTurnLedger, stoppedBy, traceCalls } from "../agent/turnLedger.ts";
import { buildRemoteHandsTools, type RemoteHandsDeps } from "../agent/remoteHandsTools.ts";
import type { HandsResult } from "@t3tools/baton-shared/remoteHands";
import {
  sessionWithOwnMcp,
  startBatonMcp,
  type BatonMcp,
  type BatonTool,
} from "../agent/batonMcp.ts";
import {
  buildBatonTools,
  clickTargetsField,
  focusIsOn,
  treeText,
  typeByValue,
  type FocusState,
  type ToolHost,
} from "../agent/batonTools.ts";
import { withFailureGuard } from "../agent/failureGuard.ts";
import { createAssistantAgent, type AssistantAgent } from "../agent/agentSession.ts";
import {
  answerConversationSearch,
  conversationsIn,
  createConversationLog,
  type PersonaConversations,
} from "../conversation/conversationLog.ts";
import {
  accessibilityLooksOff,
  chooseBrowserRoute,
  realRelaunchPorts,
  relaunchChromeWithAccessibility,
} from "./browserRoute.ts";
import { checkChromeWithin, realProbe, type ChromeCheck } from "./chromeCheck.ts";
import { createDesktopMemory } from "../memory/memoryClient.ts";
import { windowsHello } from "../vault/hello.ts";
import { pendingSecret } from "../vault/pendingSecret.ts";
import { redactForHistory } from "../vault/redact.ts";
import { createVaultHost, type VaultHost } from "../vault/vaultHost.ts";
import { vaultFor } from "../vault/vaultInstance.ts";
import { createMemorySync } from "../memory/memorySync.ts";
import { errorCode, plainError, stepLine } from "@t3tools/baton-shared/stepLine";
import { createNotesStore, notesBlock } from "../memory/memoryNotes.ts";
import {
  assistantFrame,
  DEFAULT_OS_PACK,
  leadsProject,
  modelOf,
  personaFor,
  type Brain,
  type Persona,
  type ProjectRef,
} from "@t3tools/baton-shared/osPack";
import { accountLabel, maskEmail, pickEnv } from "./assistantAccount.ts";
import { createAssistantAccounts } from "./assistantAccounts.ts";
import { createInputDriver } from "./inputDriver.ts";
import type { SidecarInput } from "../voice/dictationSidecar.ts";
import type { HomeControl } from "../home/batonHome.ts";
import { POCKET_VOICES, type PocketVoice } from "../voice/pocketVoice.ts";
import { actLabel, actTarget, type Act } from "./actCursor.ts";
import { markPhase } from "../lifecycle/mainStall.ts";
import { createPointerOverlay, type OverlayCard } from "./pointerOverlay.ts";
import type { EscapeRank } from "./escapeKey.ts";
import {
  bmpImage,
  captureArea,
  captureScreens,
  screenFingerprint,
  shotOf,
  type CapturedScreen,
} from "./screenCapture.ts";

/** Names a step of building the screen's controls for the stall log; adds nothing. */
const stepMark = (name: string): [] => {
  markPhase(name);
  return [];
};

// F5 to F8 are voice and dictation, and Airdeck has F9 to F12.
export const ASK_HOTKEY = "Control+Alt+Shift+B";

interface ScreenSettings {
  readonly captureApproval: CaptureApproval;
  /** His `claude` binary; on PATH by default. */
  readonly claudeBinary: string;
  /** Looking, teaching and the older operator. The one assistant runs on each persona's own model, from its pack file. */
  readonly model: string;
  /** Written only shows everything and plays nothing. */
  readonly output: AnswerOutput;
  /** "system" is the OS voice, for a machine that should fetch nothing. */
  readonly voice: PocketVoice | "system";
  /** How loud Baton speaks, 0.1 to 1, applied in the player. */
  readonly volume: number;
  /** Low-risk work runs with no Run it box and no spoken yes. Off until he turns it on. */
  readonly actWithoutAsking: boolean;
  /** A remote session the Director gave baton:hands may drive this computer (REMOTE_HANDS.md). Off until he turns it on. */
  readonly remoteHands: boolean;
  /** He is away: a remote call that would ask him is refused instead, since nobody can answer. */
  readonly remoteHandsAway: boolean;
  /** Her own cursor glides to where she acts, with a word or two; his pointer never moves. On until he turns it off. */
  readonly actCursor: boolean;
  /** Who does the work behind Baton. Both answer to the same gate. */
  readonly operator: "claude" | "codex";
  readonly codexBinary: string;
  /** Let the assistant drive his own Chrome through Claude in Chrome (D3). Off until tried on his machine. */
  readonly browserChrome: boolean;
  /** He (or the first-run check) has decided; until then a connected Chrome turns it on once. */
  readonly browserChromeSet: boolean;
  /** Social sites are ones it may act on in Chrome, with every action asked. On; a switch turns it off. */
  readonly socialOn: boolean;
  /** He has picked what Baton works through, so the first-run card is done. */
  readonly brainChosen: boolean;
  /** The config directory of the Claude login the assistant uses; null follows his `claude`. */
  readonly assistantAccount: string | null;
  /** His own choice of model and effort for chat turns; "auto" leaves it to the turn rules. Holds until he resets it. */
  readonly assistantModel: "auto" | "haiku" | "sonnet" | "opus";
  readonly assistantEffort: "auto" | "low" | "medium" | "high";
}

const UNKNOWN_BRAINS: BrainStatus = { claude: { state: "missing" }, codex: { state: "missing" } };

const DEFAULTS: ScreenSettings = {
  captureApproval: "ask",
  claudeBinary: "claude",
  model: "claude-opus-5-5",
  output: "spoken",
  voice: "anna",
  volume: 1,
  actWithoutAsking: false,
  remoteHands: false,
  remoteHandsAway: false,
  actCursor: true,
  operator: "claude",
  codexBinary: "codex",
  browserChrome: false,
  browserChromeSet: false,
  socialOn: true,
  brainChosen: false,
  assistantAccount: null,
  assistantModel: "auto",
  assistantEffort: "auto",
};

/** Defaults that older releases wrote into every settings file; he never chose them, so they give way. */
const FROZEN_MODELS = new Set(["opus", "claude-opus-5-5"]);

const settingsFrom = (saved: Partial<ScreenSettings> & { speak?: boolean }): ScreenSettings => ({
  ...DEFAULTS,
  // The old checkbox, for a settings file written before Written only.
  ...(saved.speak === false ? { output: "written" as const } : {}),
  ...saved,
  ...(saved.model !== undefined && FROZEN_MODELS.has(saved.model) ? { model: DEFAULTS.model } : {}),
});

const LOOK_MEMORY_MS = 15 * 60_000;
/** Real work takes a while, and a question to him sits inside the turn. */
const OPERATOR_TURN_MS = 30 * 60_000;
/** He said stop or the box must open: neither waits for a sidecar that is restarting. */
const FOCUS_WAIT_MS = 400;
const KEYBOARD_WAIT_MS = 1_500;
const REMOTE_QUIET_MS = 4_000;
const TEACH_MAX_STEPS = 30;
const TEACH_IDLE_MS = 10 * 60_000;
/**
 * Share of a 320 px thumbnail that must change for a step to count as done. Measured under Xvfb:
 * a typed name 0.05 %, a line of result text 0.15 %, the text caret blinking 0.006 %.
 */
const CHANGED = 0.00025;
/** ...and the most two polls may differ for the screen to count as settled. */
const SETTLED = 0.0001;
/** Grey-level change that counts at thumbnail scale, where a line of text is a faint smudge. */
const PIXEL = 8;

/** One of his standing jobs to run (KIRO-1); `judge` is standingVerdict for its owner. */
export interface StandingRunJob {
  readonly title: string;
  readonly instruction: string;
  /** A device wrote the words and he never rewrote them: they are quoted as data, never run as his. */
  readonly from: "him" | "device";
  readonly tools: ReadonlyArray<string>;
  readonly judge: (tool: string) => { readonly verdict: string; readonly why?: string };
}

/** What Baton can do beyond talking, supplied by the voice side. */
/** The window he is using. */
export interface AssistantFocus {
  /** "notepad.exe: notes.txt", for the model. */
  readonly label: string;
  /** Its middle in desktop coordinates, which picks the display. */
  readonly centre: { readonly x: number; readonly y: number } | null;
  /** The window itself, so a drive sees the keyboard move. */
  readonly window?: number;
}

export interface AssistantActions {
  /** Which window has the keyboard right now. */
  readonly focus?: () => Promise<AssistantFocus | null>;
  /** The window he was in when he said the name, before anything of Tessaya's showed. */
  readonly wakeFocus?: () => Promise<AssistantFocus | null>;
  /** The real element for a label near a point, from the accessibility tree. */
  readonly locate?: (
    label: string,
    near: { readonly x: number; readonly y: number },
    /** The whole window with the keyboard, not only what is near the point (the assistant's click by name). */
    anywhere?: boolean,
    /** Also act on it through its UI Automation pattern, so neither his pointer nor the focus moves. */
    invoke?: boolean,
    /** A line number of the numbered tree `tree` in place of the label; throws when the window changed since. */
    ref?: { readonly line: number; readonly tree: number },
  ) => Promise<{
    readonly x: number;
    readonly y: number;
    readonly name: string;
    /** How it was acted on with no pointer; "pending" while a dialog it opened is up. */
    readonly invoked?: string;
    /** After a press: its own value and states. */
    readonly state?: string;
    /** What is on top of it, when a click would land there instead. */
    readonly coveredBy?: string;
    /** The control's size in desktop points, when the tree gave it. */
    readonly width?: number;
    readonly height?: number;
  } | null>;
  /** The sidecar's window-targeted hands, for remote sessions; null while the sidecar is not running. */
  readonly hands?: () =>
    | (RemoteHandsDeps["sidecar"] & {
        readonly focusWindow: (window: number) => Promise<{ readonly error?: string }>;
        readonly focusWindowTitled: (
          title: string,
        ) => Promise<{ readonly title?: string; readonly error?: string }>;
        readonly input: (input: SidecarInput) => Promise<void>;
        /** False when that window no longer has the keyboard, and nothing was pasted. */
        readonly pasteInto: (text: string, target: number) => Promise<boolean>;
        /** Into whatever window has the keyboard, kept out of clipboard history. */
        readonly paste: (text: string) => Promise<void>;
      })
    | null;
  /** The sidecar's running count of desktop changes; null where there is none. */
  readonly uiChanges?: () => Promise<number | null>;
  /** What the window with the keyboard offers, by kind and name; null when the tree cannot be read. */
  readonly uiTree?: (
    find?: string,
    numbered?: boolean,
  ) => Promise<{
    readonly window: string;
    readonly controls: ReadonlyArray<string>;
    readonly shown?: number;
    readonly tree?: number;
  } | null>;
  /** Where the keyboard is, read cheaply after an action; null when it cannot be read. */
  readonly focusState?: () => Promise<FocusState | null>;
  /** The top-level window under a desktop point, for a drive's click. */
  readonly windowAt?: (point: { readonly x: number; readonly y: number }) => Promise<{
    readonly window: number;
    readonly label: string;
  } | null>;
  /** The folder open in a window, when it is an Explorer window. */
  readonly folder?: (window: number) => Promise<string | null>;
  /** A yes or no by voice, beside any box. Null when nothing is listening. */
  readonly confirm?: (prompt: string) => {
    readonly answer: Promise<"yes" | "no" | "expired">;
    readonly cancel: () => void;
  } | null;
  /** Unused since the old router was deleted; still supplied by DesktopBatonVoice until that file drops them. */
  readonly act?: (command: string, restated?: boolean) => Promise<string>;
  readonly grammarPlaces?: (said: string) => Promise<boolean>;
  /** His live sessions, one per line, with the id each is named by. */
  readonly sessionsList?: () => string;
  /** The project of a focused session ("<id> (<evidence>)"), for memory scoping; null when unknown. */
  readonly projectOf?: (session: string) => string | null;
  /** The focused session's project and the computer it is on. */
  readonly projectRefOf?: (session: string) => ProjectRef | null;
  /** Every project his sessions are in, with the computer each is on, so a title shared by two is told apart. */
  readonly projects?: () => ReadonlyArray<ProjectRef>;
  /** The projects a job may work in, by its id; null when the jobs could not be read. */
  readonly jobProjects?: (id: string) => Promise<ReadonlyArray<ProjectRef> | null>;
  /** The awareness state as a line for the assistant (D149); empty when every switch is off. */
  readonly presence?: () => Promise<string>;
  /** The job operations (D145), answered in a sentence for the assistant. */
  readonly jobs?: (
    op:
      | "list"
      | "start"
      | "agree"
      | "refine"
      | "grant"
      | "revoke"
      | "watch"
      | "stop"
      | "schedule"
      | "brief"
      | "approvals"
      | "needs"
      | "commit_add"
      | "commit_done"
      | "commit_list"
      | "notices_stop"
      | "notices_resume"
      | "cloud_dispatch"
      | "cloud_status"
      | "cloud_list"
      | "cloud_cancel"
      | "cloud_usage"
      | "cloud_approve"
      | "trust_show"
      | "activity_today"
      | "record"
      | "permission_off"
      | "weave_send"
      | "weave_list"
      | "text_transform"
      | "text_undo"
      | "text_command"
      | "note_add"
      | "note_search"
      | "retry"
      | "skill_draft"
      | "handoff"
      | "split"
      | "rule_preview"
      | "rule_run"
      | "user_job_create"
      | "user_job_propose"
      | "user_job_update"
      | "user_job_delete"
      | "user_job_save",
    args: Readonly<Record<string, unknown>>,
  ) => Promise<string>;
  /** One session's state in a sentence, by id or name; null when none matches. */
  readonly sessionShow?: (idOrName: string) => string | null;
  /** Type a message into a session's pane, by id or name, word for word; null when none matches. */
  readonly sessionSend?: (idOrName: string, text: string) => Promise<string> | null;
  /** Every session's state and what is being left alone, from state. */
  readonly fleetStatus?: () => Promise<string>;
  /** Start or stop dictation into the focused field. */
  readonly dictation?: (on: boolean) => Promise<string>;
  /** The server's memory (D150), through the window; rejects with a reason in plain words. */
  readonly memory?: (op: string, args: Record<string, unknown>) => Promise<unknown>;
}

/** One turn's timings in ms, for the report. Words are never written here. */
export interface TurnTimings {
  readonly route: string;
  readonly source: string;
  readonly decideMs: number;
  readonly firstSentenceMs: number | null;
  readonly totalMs: number;
}

export interface ScreenCompanion {
  /** Runs one remote hands call behind the same gate and mouse guard as the assistant's own tools. */
  readonly remoteHands: {
    readonly enabled: () => boolean;
    readonly run: (call: {
      readonly tool: string;
      readonly args: Readonly<Record<string, unknown>>;
    }) => Promise<HandsResult>;
  };
  /** Decide what was said and carry it out; a refusal comes back for the caller to say. */
  /** One run of his own standing job, as an unattended device-kind turn; his turns stop it. */
  readonly runStanding: (
    job: StandingRunJob,
    signal: AbortSignal,
    timeoutMs: number,
  ) => Promise<{
    readonly status: "ok" | "error" | "timeout" | "cancelled";
    readonly text: string;
    readonly model?: string;
    readonly turns?: number;
  }>;
  readonly said: (
    text: string,
    input: {
      readonly direct: boolean;
      readonly typed?: boolean;
      /** The work session he has focused, as the voice side resolved it. */
      readonly session?: string | null;
      /** The wake word that opened this turn; it picks who answers. */
      readonly wake?: string | null;
      /** A device's or agent's words, not his: always the assistant, whose gate asks. */
      readonly outside?: boolean;
      /** He cut her off: what she had said by then. */
      readonly cutIn?: CutIn | null;
    },
  ) => Promise<{ readonly kind: "handled" } | { readonly kind: "refused"; readonly reply: string }>;
  readonly setActions: (actions: AssistantActions) => void;
  /** Memory sync between servers (D150): off by default; the Memory tab switches it and runs it now. */
  readonly memorySync: ReturnType<typeof createMemorySync>;
  /** A lesson or a drive is running. */
  readonly active: () => boolean;
  /** Silences what is queued and what an answer has yet to say. */
  readonly hush: () => void;
  /** He talked over her: hush, and a turn that is answering does nothing more (`stopsOnCutIn`). */
  readonly cutIn: () => void;
  /** Registers or drops the transform shortcuts (Transforms is opt-in). */
  readonly setTransformHotkeys: (on: boolean) => void;
  /** The tray's Clear the screen, also what a spoken stop does. */
  readonly dismiss: () => void;
  /** He has woken Baton: starts the sessions a turn will need, for the persona his wake word names. No quota. */
  readonly warm: (wake?: string | null) => void;
  /** Only the assistant's sessions, with no first-run checks: for the warm-up at launch. */
  readonly warmAssistant: () => void;
  /** A turn or dictation began from this wake word: its persona answers from here, in its own voice. */
  readonly addressed: (wake: string | null) => void;
  readonly openAskBox: () => void;
  /** A question about something that is not his words (a run's log): an ordinary turn, the text marked as not his. */
  readonly askAbout: (text: string) => void;
  /** The phone's words, run as a typed ask; the short reply and the card text come back instead of only being shown. */
  readonly askFromPhone: (
    text: string,
    source: "phone" | "device",
  ) => Promise<{ readonly spoken: string; readonly card: string }>;
  /** Mirrors the questions it asks him to his phone; null stops. The first answer, here or there, counts. */
  readonly setPhoneMirror: (mirror: PhoneMirror | null) => void;
  readonly stateForServer: () => Omit<DesktopStateInput, "voice" | "appVersion" | "environments">;
  /** A reply from outside the assistant, shown in full when answers are written only. */
  readonly notice: (text: string) => void;
  /** An unprompted line: a card, and aloud when asked and spoken answers are on. */
  /** Shown in full; when spoken, `spoken` is said instead of the whole text (a job's answer is only announced). */
  readonly announce: (text: string, speak: boolean, spoken?: string) => void;
  /** Spoken answers are off. */
  readonly writtenOnly: () => boolean;
  readonly voice: () => PocketVoice | "system";
  readonly volume: () => number;
  readonly stop: () => void;
  /** Dismissed by Esc, a click or "never mind": everything comes down and goes quiet, with nothing said and no turn logged. */
  readonly dismissQuietly: () => void;
  /** The one look for a yes or no, for the voice side's confirmations too. */
  readonly ask: ReturnType<typeof createCompanionWindows>["ask"];
  /** The same question, also put to a paired phone: the first answer counts. */
  readonly askMirrored: (
    box: Parameters<ReturnType<typeof createCompanionWindows>["ask"]>[0],
    needs?: "cloud-approve",
  ) => Promise<number>;
  readonly menuItems: () => ReadonlyArray<Electron.MenuItemConstructorOptions>;
  readonly controls: () => ReadonlyArray<HomeControl>;
  readonly needsBrainChoice: () => boolean;
  /** Move the Ask Baton key, or switch it off with null. */
  readonly setAskHotkey: (accelerator: string | null) => void;
  /** Asks again whether Claude Code and Codex are installed and signed in. */
  readonly signIn: () => Promise<BrainStatus>;
  readonly applySetting: (id: string, value: string | boolean | null) => void;
  readonly dispose: () => void;
  /** The lead's nightly learning pass over the turns these Record rows trace; a sentence of what it did. */
  readonly learnNightly: (
    rows: ReadonlyArray<{ readonly kind: string; readonly detail: string }>,
  ) => Promise<string>;
}

type Run =
  | { readonly mode: "look"; readonly vision: VisionSession; lastAt: number }
  | {
      readonly mode: "teach";
      readonly vision: VisionSession;
      readonly goal: string;
      step: number;
      lastSpoken: string;
      watcher: ReturnType<typeof setInterval> | null;
      idle: ReturnType<typeof setTimeout> | null;
      busy: boolean;
    };

const LOOK_REPLY = "[LOOK]";

/** A question on its way to the phone: resolves with the button index if the phone answers first. */
export type PhoneMirror = (question: {
  readonly title: string;
  readonly detail: string;
  readonly buttons: ReadonlyArray<string>;
  readonly yes: number;
  readonly cancel: number;
  readonly needs?: "cloud-approve";
}) => { readonly answer: Promise<number>; readonly close: () => void } | null;
const PHONE_SETTLE_STEPS = 40;

const DEVICE_INTERRUPTED =
  "Interrupted: the Director started talking to Tessaya, and he comes first. Ask again.";
const DEVICE_BUSY =
  "Tessaya is in the middle of something with the Director (a lesson, a drive or a look). Ask again later.";

const lateCatalog = (get: () => ToolHost["catalog"]): NonNullable<ToolHost["catalog"]> => {
  const NOT_READY = "The session list is not ready yet.";
  return {
    find: async (q) => (await get()?.find(q)) ?? NOT_READY,
    resume: async (id) => (await get()?.resume(id)) ?? NOT_READY,
    start: async (cwd, machine) => (await get()?.start(cwd, machine)) ?? NOT_READY,
  };
};

export const startScreenCompanion = (input: {
  readonly stateDir: string;
  /** What the app can do for a remote session besides drive windows: version, logs, processes, update, pages. */
  readonly remoteOps?: RemoteHandsDeps["ops"];
  /** The sessions catalog, which starts after this does: asked for at each use. */
  readonly catalog?: () => ToolHost["catalog"];
  /** Bring Tessaya's window forward, on a tab when it can (the vault asks to be unlocked there). */
  readonly onOpenTab?: (tab: string) => void;
  readonly platform: string;
  readonly env: NodeJS.ProcessEnv;
  /** This machine's own server, whether or not T3's window is up. */
  readonly direct?: (method: string, body: unknown) => Promise<unknown>;
  /** Baton's one voice, injected so this module never loads the voice models. */
  readonly speak: (text: string) => Promise<void>;
  /** A turn finished with nothing further coming, for the cue after a wake word. */
  readonly onTurnEnd?: () => void;
  readonly onTimings?: (timings: TurnTimings) => void;
  /** Every action taken or refused, for the turn log. */
  readonly onAction?: (entry: Readonly<Record<string, unknown>>) => void;
  /** Every reply and every refusal reason, for the turn log: what Baton said and why it would not. */
  readonly onNote?: (kind: string, fields: Readonly<Record<string, unknown>>) => void;
  /** A conversation per persona, shared with the voice side. Made here when none is given. */
  readonly conversations?: PersonaConversations;
  /** What each turn was given and did, for the lab's trace table. */
  readonly onTrace?: (entry: Readonly<Record<string, unknown>>) => void;
  /** Lets the voice tray show the companion's own entries. */
  readonly onChange?: () => void;
  /** Stop speech at once: he has moved on. */
  readonly stopSpeech?: () => void;
  readonly holdEscape: (onPress: () => void, rank?: EscapeRank) => () => void;
  /** Sends an Esc of Tessaya's own past the held key, so it reaches the app instead of stopping the work. */
  readonly ownEscape?: <T>(send: () => Promise<T>) => Promise<T>;
  /** Tells the pill what is going on; null when it stops. */
  readonly onActivity?: (label: string | null, caption?: string) => void;
  /** A short sound for a lesson or drive: start, a step done, waiting, error, finished. */
  readonly onCue?: (name: "start" | "stepDone" | "waiting" | "error" | "finished") => void;
  /** The answer's words were cancelled by him: the pill goes too. */
  readonly onDismissed?: () => void;
}): ScreenCompanion => {
  const settingsPath = NodePath.join(input.stateDir, "baton-screen.json");
  const read = (): ScreenSettings => {
    try {
      return settingsFrom(JSON.parse(NodeFS.readFileSync(settingsPath, "utf8")));
    } catch {
      return DEFAULTS;
    }
  };
  let settings = read();
  const save = (next: Partial<ScreenSettings>) => {
    settings = { ...settings, ...next };
    writeJsonFile(settingsPath, changedFrom(settings, DEFAULTS));
    input.onChange?.();
  };

  let brains: BrainStatus | null = null;
  const checkBrains = async () => {
    brains = await detectBrains({
      env: input.env,
      platform: input.platform,
      claudeBinary: settings.claudeBinary,
      codexBinary: settings.codexBinary,
    });
    input.onChange?.();
  };
  void checkBrains();
  const accounts = createAssistantAccounts({
    env: input.env,
    platform: input.platform,
    claudeBinary: () => settings.claudeBinary,
    onChange: () => input.onChange?.(),
  });
  void accounts.refresh();
  let toldAbout: string | null = null;
  /** The environment for his `claude` children: the chosen login, or his own with a plain note. */
  const claudeEnv = (): NodeJS.ProcessEnv => {
    const picked = pickEnv(settings.assistantAccount, accounts.cached(), input.env);
    if (picked.notice !== null && picked.notice !== toldAbout) {
      toldAbout = picked.notice;
      linger("Tessaya", picked.notice);
    }
    return picked.env;
  };

  const overlay = createPointerOverlay(input.platform, (id) => cardAction(id));
  const speech = queueSpeech(input.speak);
  /** Bumped when he silences it, so what an answer is still streaming stays unsaid. */
  let hushes = 0;
  /** Cut-ins over her voice, against the assistant turn they cut (its turns run one at a time). */
  const cutIns = createCutInMark();
  const hush = () => {
    hushes += 1;
    input.stopSpeech?.();
  };
  /** When the current speech began, for how much reading it has already covered. */
  let spokenFrom: number | null = null;
  /** While the phone's ask runs, what the assistant says and shows is kept for the phone as well. */
  let phoneCapture: { readonly spoken: string[]; card: string | null } | null = null;
  // A device's turn never overlaps his (turnLock.ts), so while one holds the lock every prompt is labelled as its.
  const turnLock = createTurnLock();
  let recentErrors: ReadonlyArray<{ readonly code: string; readonly at: string }> = [];
  let phoneTurn = false;
  /** Whether the running turn's words are a device's, and every such sentence, so none counts as his. */
  const outsideSaid = new Set<string>();
  let phoneMirror: PhoneMirror | null = null;
  /** False when nothing goes to the voice (written answers, nothing to say). */
  const say = (text: string, onStart?: () => void): boolean => {
    if (phoneCapture !== null && text.trim().length > 0) phoneCapture.spoken.push(text.trim());
    if (settings.output === "written" || text.trim().length === 0) return false;
    spokenFrom ??= Date.now();
    speech.add(text, onStart);
    return true;
  };
  let driver: ReturnType<typeof createInputDriver> | null = null;
  let run: Run | null = null;
  let allowedUntil = 0;
  /** Bumped by anything new on screen; a hold that finds it moved quietly gives up. */
  let showing = 0;

  let actions: AssistantActions | null = null;
  /** Every route's turns, on disk, in full (D142), in the file of the persona speaking (P2). */
  const conversations = input.conversations ?? conversationsIn(input.stateDir);
  const conversation = conversations.current;
  // P5 adds the private flag to a persona's file; until then every persona's conversation may be shared.
  const isPrivate = (_persona: string): boolean => false;
  const nameOf = (id: string) =>
    readPack(NodePath.join(input.stateDir, PACK_FOLDER)).personas.find((p) => p.id === id)?.name;
  // The Chrome check never runs on the render path and never blocks or throws: it runs off to the side, gives up
  // after a few seconds, and the window shows the last answer.
  let chromeSeen: { readonly at: number; readonly check: ChromeCheck } = {
    at: 0,
    check: { state: "not-connected", message: "Checking Chrome..." },
  };
  let chromeChecking = false;
  const refreshChrome = async (): Promise<ChromeCheck> => {
    if (chromeChecking) return chromeSeen.check;
    chromeChecking = true;
    try {
      chromeSeen = {
        at: Date.now(),
        check: await checkChromeWithin(realProbe(input.platform), 4_000),
      };
    } finally {
      chromeChecking = false;
    }
    return chromeSeen.check;
  };
  /** The last answer, and a fresh look started in the background when it is old. */
  const chromeStatus = (): ChromeCheck => {
    if (Date.now() - chromeSeen.at > 10_000) void refreshChrome();
    return chromeSeen.check;
  };
  const notes = createNotesStore(NodePath.join(input.stateDir, "memory"));
  // The server's store answers when the window does (`actions` arrives late); his notes folder otherwise.
  // The vault host needs the confirm path, built further down; the offer waits for it.
  let vaultHost: VaultHost | null = null;
  const memory = createDesktopMemory({
    onSecret: (text, what) => vaultHost?.offer(text, what) ?? null,
    call: (op, args) =>
      actions?.memory === undefined
        ? Promise.reject(new Error("Memory is not reachable yet."))
        : actions.memory(op, args),
    notes,
    // His slot only: a device's turn has its own memory client with no persona (outsideSlot.ts).
    agent: () => face.id,
  });
  let stopMemorySync: (() => void) | null = null;
  const memorySync = createMemorySync({
    file: NodePath.join(input.stateDir, "baton-memory.json"),
    peersFile: NodePath.join(input.stateDir, "memory-sync-peers.json"),
    // Linux's basic_text backend is a fixed key, not encryption: no credential is kept there.
    protection: () =>
      Electron.safeStorage.isEncryptionAvailable() &&
      (input.platform !== "linux" ||
        Electron.safeStorage.getSelectedStorageBackend() !== "basic_text")
        ? {
            protect: (plain) => Electron.safeStorage.encryptString(plain).toString("base64"),
            unprotect: (wrapped) =>
              Electron.safeStorage.decryptString(Buffer.from(wrapped, "base64")),
          }
        : null,
    call: (op, args) =>
      actions?.memory === undefined
        ? Promise.reject(new Error("Memory is not reachable yet."))
        : actions.memory(op, args),
  });
  /** A reply is kept in full and logged in full, whatever route made it. */
  const converse = (
    route: ConversationRoute,
    said: string,
    reply: string,
    extra: { readonly note?: string; readonly target?: string } = {},
  ) => {
    const label = extra.target ?? (titlesAllowed() ? focus?.label : undefined);
    conversation.add({
      route,
      said,
      reply,
      ...(extra.note === undefined ? {} : { note: extra.note }),
      ...(label === undefined ? {} : { target: { label } }),
    });
    input.onNote?.("reply", {
      route,
      said,
      reply,
      ...(extra.note === undefined ? {} : { note: extra.note }),
    });
  };
  /** A refusal says why, aloud and on the pill, and is logged with its reason: never a silent no. */
  const refuse = (kind: string, reason: string, said: string, where = "Tessaya") => {
    say(reason);
    linger(where, reason);
    input.onActivity?.(null);
    conversation.add({ route: "refusal", said, reply: reason, note: kind });
    input.onNote?.("refusal", { kind, reason, said });
  };

  /** A started answer session, so the first answer skips the process's own start. */
  let spareLook: VisionSession | null = null;
  const dropSpare = () => {
    spareLook?.dispose();
    spareLook = null;
  };

  const visionFor = (mode: ScreenMode): VisionSession =>
    startVisionSession({
      claudeBinary: settings.claudeBinary,
      model: settings.model,
      systemPrompt: mode === "look" ? `${ASSISTANT_PROMPT_INTRO}\n\n${LOOK_PROMPT}` : TEACH_PROMPT,
      workDir: NodePath.join(input.stateDir, "screen"),
      env: claudeEnv(),
      platform: input.platform,
    });

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  const wipe = async () => {
    showing += 1;
    spokenFrom = null;
    await overlay.clear();
  };
  /** Takes down whatever is up, and the voice with it. Esc stays his: this is the tray's. */
  const dismiss = () => {
    hush();
    input.onDismissed?.();
    // Stop means the work too, not only the talking about it.
    dropOperator();
    if (run !== null && run.mode !== "look") {
      say("Stopped.");
      end();
    }
    void wipe();
  };

  const FINISHED_CARD_MS = 12_000;
  /** The end of a lesson or a drive: a green-edged card, and a bubble at the pointer saying what changed. */
  const finishedCard = async (
    kicker: string,
    text: string,
    bubble: string | null,
    more: ReadonlyArray<{ id: string; label: string }> = [],
  ) => {
    const mine = ++showing;
    input.onCue?.("finished");
    await overlay.card({
      kicker,
      text,
      state: "done",
      actions: [
        { id: "another", label: "Show another", primary: true },
        ...more,
        { id: "close", label: "Close" },
      ],
    });
    if (bubble !== null) void overlay.bubble(bubble.slice(0, 140));
    setTimeout(() => mine === showing && void wipe(), FINISHED_CARD_MS).unref();
  };
  const STEP_ACTIONS = [
    { id: "again", label: "Say it again" },
    { id: "skip", label: "Skip" },
    { id: "stop", label: "Stop" },
  ] as const;
  /** A step he can see no target for: asking the screen again comes first. */
  const LOOK_ACTIONS = [
    { id: "look", label: "Look again", primary: true },
    { id: "skip", label: "Skip" },
    { id: "stop", label: "Stop" },
  ] as const;
  const LOOK_AGAIN = "he asked you to look again: the pointer found nothing.";
  /** A button on a step card: the same as saying it. */
  const cardAction = (id: string) => {
    // A click on the card itself stops the talking and takes it down: a way out that needs no voice.
    if (id === "stop") {
      dismiss();
      return;
    }
    if (id === "look" && run?.mode === "teach") {
      run.step -= 1;
      void teachStep(LOOK_AGAIN).catch(fail);
      return;
    }
    if (id === "another") {
      void wipe();
      windows.openAsk();
      return;
    }
    if (id === "again") {
      if (run?.mode === "teach") say(run.lastSpoken);
    } else if (id === "skip") {
      if (run?.mode === "teach") void teachStep("he skipped this step.").catch(fail);
    } else if (id === "stop") stop();
    else if (id === "close") void wipe();
  };

  /** A card that stays until something replaces it: a step, a plan, a thought. */
  const show = async (
    kicker: string,
    text: string,
    hint = "",
    extra: Partial<OverlayCard> = {},
  ) => {
    showing += 1;
    await overlay.card({ kicker, text, hint, ...extra });
  };

  /**
   * Shows text until it has been read, then leaves. Every page gets its reading time, the last
   * waits for the voice, and then the readable hold runs on a line he can see (D111). Started
   * without waiting: the turn is over, only the words remain.
   */
  const linger = (kicker: string, text: string, hint = ""): void => {
    if (phoneCapture !== null && text.trim().length > 0) phoneCapture.card = text.trim();
    const mine = ++showing;
    const pages = pageText(text);
    const current = () => mine === showing;
    void (async () => {
      for (const [i, page] of pages.entries()) {
        const label = pages.length > 1 ? `${i + 1} of ${pages.length}` : undefined;
        await overlay.card({ kicker, text: page, hint, ...(label ? { page: label } : {}) });
        if (i === pages.length - 1) break;
        const ms = readingMs(page);
        await overlay.timer(ms);
        await sleep(ms);
        if (!current()) return;
      }
      await retreatAfterSpeech(pages.at(-1)!, current);
    })().catch(() => undefined);
  };
  /** Once the voice is done, the last page stays until it has been read, then the card leaves. */
  const retreatAfterSpeech = async (lastPage: string, current: () => boolean) => {
    await speech.finished();
    if (!current()) return;
    const spokenMs = spokenFrom === null ? 0 : Date.now() - spokenFrom;
    const hold = holdAfterSpeechMs(lastPage, spokenMs);
    await overlay.timer(hold);
    await sleep(hold);
    if (!current()) return;
    showing += 1;
    spokenFrom = null;
    await overlay.retreat();
  };

  /** A title can hold an email subject or a bank's name: it goes where a screenshot may. */
  const titlesAllowed = (): boolean =>
    !needsCaptureApproval({
      policy: settings.captureApproval,
      allowedUntil,
      sessionApproved: false,
      now: Date.now(),
    });

  /** This turn came by voice, so its questions can be answered by voice too. */
  let voiceTurn = false;
  /** Who is answering: picked from the roster at each sentence, and the voice follows it. */
  let face: Persona = personaFor(readPack(NodePath.join(input.stateDir, PACK_FOLDER)).personas, {
    wake: null,
    text: "",
  });
  /** The last assistant turn, kept on this machine for "Learn from that". */
  let lastTurn: (LastTurn & { readonly brain: Brain }) | null = null;
  /** What the learning loop is doing, shown on its button while it runs. */
  let learning: string | null = null;
  const skillsDir = () => skillsDirOf(NodePath.join(input.stateDir, PACK_FOLDER));
  const nightlyOn = () =>
    createStandingStore(input.stateDir, () => ({ briefOn: false, briefGivenOn: null })).load().on
      .nightly_learning === true;
  try {
    pruneRecentTurns(skillsDir(), Date.now());
  } catch {
    // Nothing kept yet.
  }
  /** The model and effort the answering persona's file names. */
  let faceModel: Brain = modelOf(DEFAULT_OS_PACK, "executive");
  const leadBrain = () =>
    modelOf(readPack(NodePath.join(input.stateDir, PACK_FOLDER)), "executive");
  /** Each persona's last chat turn tier, so a bare "go ahead" is carried out on the model that turn used (P1). */
  const tierMemories = createTierMemories();
  const manual = (): ManualBrain => ({
    model: settings.assistantModel === "auto" ? null : settings.assistantModel,
    effort: settings.assistantEffort === "auto" ? null : settings.assistantEffort,
  });
  let disposed = false;
  /** The tiers of the persona he is talking to (the one his wake word names), and only that persona's (P1). */
  /** The persona whose tiers were warmed last, so a sentence that names another ("ask Alfred…") warms that one. */
  let warmedFor: string | null = null;
  const warmTiers = (persona: Persona = face, wake = false) => {
    warmedFor = persona.id;
    agentOf().warm(
      tierBrains(
        modelOf(readPack(NodePath.join(input.stateDir, PACK_FOLDER)), persona.id),
        manual(),
        tierMemories.of(persona.id).previous() ?? "default",
      ),
      persona.id,
      wake,
    );
  };
  /** Voice, tray, settings and the assistant_model tool all land here; the next turn uses it, and its session is warmed now. */
  const chooseModel = (choice: ManualBrain): string => {
    save({ assistantModel: choice.model ?? "auto", assistantEffort: choice.effort ?? "auto" });
    input.onNote?.("model_choice", { model: choice.model, effort: choice.effort });
    warmTiers();
    return manualLabel(choice);
  };
  const MODELS = ["haiku", "sonnet", "opus"] as const;
  const EFFORTS = ["low", "medium", "high"] as const;
  /** The assistant_model tool's way in: names checked here, since they come from the model. */
  const setModelByName = (model: string | null, effort: string | null): string => {
    const now = manual();
    if (model === null && effort === null) return `Model: ${manualLabel(now)}.`;
    if (turnLock.deviceRunning())
      throw new Error("Only he can change his model, not a paired device or an agent.");
    const m = MODELS.find((x) => x === model);
    const e = EFFORTS.find((x) => x === effort);
    if (model !== null && model !== "auto" && m === undefined)
      throw new Error(`No model is named ${model}.`);
    if (effort !== null && effort !== "auto" && e === undefined)
      throw new Error(`No effort is named ${effort}.`);
    return `Model: ${chooseModel({
      model: model === null ? now.model : (m ?? null),
      effort: effort === null ? now.effort : (e ?? null),
    })}.`;
  };
  let leadName = face.name;
  /** The focused session's project this turn: a persona that leads it hands out its work. */
  let turnProject: ProjectRef | null = null;
  let woke: string | null = null;
  /** Quick and System are his choice for the whole machine; otherwise each persona speaks in its own voice. */
  const voiceNow = (): PocketVoice | "system" =>
    settings.voice === "quick" || settings.voice === "system"
      ? settings.voice
      : (POCKET_VOICES as ReadonlyArray<string>).includes(face.voice)
        ? (face.voice as PocketVoice)
        : settings.voice;
  /**
   * The box, and on a voice turn the same question aloud, so no step needs his hands. Whichever he
   * answers first counts; a question that runs out leaves the box up.
   */
  const askLocal = async (
    box: Parameters<ReturnType<typeof createCompanionWindows>["ask"]>[0],
    spoken: string,
    yes = 0,
    /** A question that runs out is a no, and the box comes down. */
    noOnExpiry = false,
  ): Promise<number> => {
    const aloud = voiceTurn ? (actions?.confirm?.(spoken) ?? null) : null;
    // The companion asks mid-task: taking focus would move his keys and the window being worked on (CU-2).
    const boxed = windows.ask({ inactive: true, ...box });
    if (aloud === null) return boxed;
    const first = await Promise.race([
      boxed.then((index) => ({ index })),
      aloud.answer.then((said) => ({ said })),
    ]);
    if ("index" in first) {
      aloud.cancel();
      return first.index;
    }
    const outcome = spokenOutcome(first.said, { yes, cancel: box.cancel, noOnExpiry });
    if (outcome === null) return boxed;
    windows.closePrompt();
    await boxed;
    return outcome;
  };

  /** The same question, also offered to his phone when it is connected; the first answer counts and the other box comes down. */
  const askHandsFree = async (
    box: Parameters<ReturnType<typeof createCompanionWindows>["ask"]>[0],
    spoken: string,
    yes = 0,
    noOnExpiry = false,
    needs?: "cloud-approve",
  ): Promise<number> => {
    try {
      return await askOnce(box, spoken, yes, noOnExpiry, needs);
    } finally {
      // He answers her question over her voice: that is his answer, not a cut-in that stops the turn.
      cutIns.begin();
    }
  };
  const askOnce = async (
    box: Parameters<ReturnType<typeof createCompanionWindows>["ask"]>[0],
    spoken: string,
    yes: number,
    noOnExpiry: boolean,
    needs?: "cloud-approve",
  ): Promise<number> => {
    // Every confirm, the gate's and the screen's, mouse, Chrome and plan alike, comes through here.
    // A device's question that nobody answers is a no, on every path.
    const expiresAsNo = noOnExpiry || turnLock.deviceRunning();
    const { box: shown, spoken: question } = labelPrompt(box, spoken, {
      device: turnLock.deviceRunning(),
      phone: phoneTurn,
    });
    const mirrored =
      box.buttons.length < 2
        ? null
        : (phoneMirror?.({
            title: box.title,
            detail: shown.detail,
            buttons: box.buttons,
            yes,
            cancel: box.cancel,
            ...(needs === undefined ? {} : { needs }),
          }) ?? null);
    const local = askLocal(shown, question, yes, expiresAsNo);
    if (mirrored === null) return local;
    const first = await Promise.race([
      local.then((index) => ({ index })),
      mirrored.answer.then((phone) => ({ phone })),
    ]);
    mirrored.close();
    if ("index" in first) return first.index;
    windows.closePrompt(true);
    await local;
    return first.phone;
  };

  /** His yes for a capture, or false. `forWhat` names the lesson or drive the yes covers. */
  const approveCapture = async (question: string, forWhat: string | null): Promise<boolean> => {
    // His standing yes (always, or for an hour) is his; a device's turn is always asked.
    if (
      !turnLock.deviceRunning() &&
      !needsCaptureApproval({
        policy: settings.captureApproval,
        allowedUntil,
        sessionApproved: false,
        now: Date.now(),
      })
    )
      return true;
    // A paired device's turn may get one look, never an hour or always.
    const lasting = !turnLock.deviceRunning();
    const response = await askHandsFree(
      {
        title: "Let Tessaya see your screen?",
        detail: `To answer: “${question}”\n\n${forWhat === null ? "One screenshot of each display goes to Claude on your subscription." : `Screenshots are taken during this ${forWhat}, after each step, until it ends.`} Nothing is stored after the answer.`,
        buttons: lasting
          ? [
              forWhat === null ? "Allow" : `Allow for this ${forWhat}`,
              "Allow for an hour",
              "Always allow",
              "Not now",
            ]
          : [forWhat === null ? "Allow" : `Allow for this ${forWhat}`, "Not now"],
        cancel: lasting ? 3 : 1,
        scoped: true,
      },
      "Can I see your screen? Yes or no.",
    );
    if (!lasting) {
      await new Promise((r) => setTimeout(r, 300));
      return response === 0;
    }
    if (response === 1) allowedUntil = Date.now() + 60 * 60_000;
    if (response === 2) save({ captureApproval: "always" });
    // The box must be off the screen before the screenshot is taken.
    await new Promise((r) => setTimeout(r, 300));
    return response !== 3;
  };

  /** The window he meant, taken when he spoke or pressed the key, before Baton took focus. */
  let focus: AssistantFocus | null = null;
  const capture = (): Promise<ReadonlyArray<CapturedScreen>> =>
    overlay.hiddenFor(() => captureScreens(focus?.centre ?? null));
  const fingerprint = () => overlay.hiddenFor(screenFingerprint);
  /** The window the last screenshot pictured, when it pictured one window; a click must land on it. */
  let shotWindow: number | null = null;
  let shotLabel: string | null = null;
  /** Tessaya's own windows (the panel, the pill): never the window he is using. */
  const ownWindow = (handle: number): boolean =>
    Electron.BrowserWindow.getAllWindows().some((w) => {
      const raw = w.getNativeWindowHandle();
      return raw.length >= 8
        ? Number(raw.readBigUInt64LE()) === handle
        : raw.readUInt32LE() === handle;
    });
  /** Images handed to the assistant so far; its session is recycled after a hands task that piled them up. */
  let imagesSent = 0;
  /** The window he is using, drawn by itself at full size (no other windows, no other displays); null off Windows. */
  const windowShot = async (): Promise<CapturedScreen | null> => {
    const hands = actions?.hands?.() ?? null;
    // The window on top now, not the one he spoke over: a dialog or another app may have come forward since.
    const now = await focusSoon();
    const handle = now?.window;
    if (hands === null || handle === undefined || ownWindow(handle)) return null;
    const dir = NodePath.join(input.stateDir, "screen");
    const out = NodePath.join(dir, `window-${Date.now()}.bmp`);
    try {
      NodeFS.mkdirSync(dir, { recursive: true });
      const done = await hands.captureWindow({ handle, out });
      const { width, height, left, top } = done;
      if (width === undefined || height === undefined || left === undefined || top === undefined)
        return null;
      const bounds = Electron.screen.screenToDipRect(null, { x: left, y: top, width, height });
      shotWindow = handle;
      shotLabel = now?.label ?? null;
      return shotOf(bmpImage(NodeFS.readFileSync(out), width, height), bounds);
    } catch {
      return null;
    } finally {
      NodeFS.rmSync(out, { force: true });
    }
  };

  const content = (
    captured: ReadonlyArray<CapturedScreen>,
    text: string,
  ): ReadonlyArray<VisionContent> => [
    ...captured.flatMap(({ shot, jpeg }): VisionContent[] => [
      {
        type: "text",
        text: `${screenLabel(shot, captured.length)}, image ${shot.width}x${shot.height}`,
      },
      { type: "image", mediaType: "image/jpeg", data: jpeg },
    ]),
    { type: "text", text },
  ];

  const pointAt = async (
    point: ReturnType<typeof parseReply>["point"],
    shots: ReadonlyArray<ScreenShot>,
  ): Promise<void> => {
    if (!pointable(point)) return;
    const shot = shotFor(shots, point.screen);
    if (shot === null) return;
    const guess = toDesktop(point, shot);
    // The accessibility tree has the real rectangle; the model's pixels only say where to look.
    const found = point.label === null ? null : await actions?.locate?.(point.label, guess);
    input.onTrace?.({ pointedAt: found ?? guess, snapped: found != null });
    const here = await overlay.point(found ?? guess, found?.name ?? point.label);
    if (!here) input.onActivity?.("Pointing", "on your other screen");
  };

  const fail = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    // Codes only, for diagnostics: the message itself never leaves this machine.
    recentErrors = [
      { code: errorCode(message), at: new Date().toISOString() },
      ...recentErrors,
    ].slice(0, 20);
    // He stopped it, and that ended the conversation under the question in flight.
    if (error instanceof SessionClosed) return;
    if (run === null && message.startsWith("Claude stopped")) return;
    // The raw text goes to the log; what is said and shown is in plain words.
    input.onNote?.("error", { message });
    const plain = plainError(message);
    say(plain);
    linger("Tessaya", plain);
    input.onActivity?.(null);
    end();
  };

  const end = () => {
    windows.closePrompt();
    dropOperator();
    const current = run;
    run = null;
    if (current === null) return;
    if (current.mode === "teach") {
      if (current.watcher !== null) clearInterval(current.watcher);
      if (current.idle !== null) clearTimeout(current.idle);
    }
    current.vision.dispose();
    input.onChange?.();
  };

  let agent: AssistantAgent | null = null;
  let operator: { session: VisionSession; lastAt: number; home: string } | null = null;
  /** The turn has run a tool, so what comes next may be following its output. */
  let tainted = false;
  /** A call is announced before its own request reaches the gate: only the next one is tainted. */
  let toolsThisTurn = 0;
  const dropOperator = () => {
    operator?.session.dispose();
    operator = null;
    // Stopping Baton stops the assistant's turn too; the next one starts a fresh session from the file.
    agent?.dispose();
    agent = null;
    // A question the stopped turn was waiting on goes with it: no later sentence may answer it.
    windows.closePrompt(true);
  };

  const toolGate = async (call: ToolCall) => {
    const judged = decideTrust({
      call,
      context: { actWithoutAsking: settings.actWithoutAsking, tainted },
      agent: face,
    });
    const action = describeToolCall(call);
    const record = (outcome: string) =>
      input.onAction?.({
        by: settings.operator,
        persona: face.name,
        tool: call.tool,
        action,
        outcome,
        ...(judged.verdict === "allow" ? {} : { why: judged.why }),
      });
    if (judged.verdict === "deny") {
      record("refused");
      return { allow: false as const, reason: `${judged.why} Tell him why and stop.` };
    }
    if (judged.verdict === "allow") {
      record("allowed");
      return { allow: true as const };
    }
    const prompt = gatePrompt(judged, action, { agent: face.name });
    const response = await askHandsFree(
      {
        title: prompt.title,
        detail: prompt.detail,
        buttons: ["Go ahead", "Not now"],
        cancel: 1,
        scoped: true,
      },
      prompt.spoken,
      0,
      prompt.noOnExpiry,
    );
    record(response === 0 ? "he said yes" : "he said no");
    return response === 0
      ? { allow: true as const }
      : { allow: false as const, reason: "He said no. Stop and tell him." };
  };

  const operatorSession = (home: string): VisionSession => {
    const onTool = (call: ToolCall) => {
      ({ tainted, ran: toolsThisTurn } = announceTool(toolsThisTurn, call.tool));
      input.onAction?.({ by: settings.operator, tool: call.tool, action: describeToolCall(call) });
    };
    return settings.operator === "codex"
      ? startCodexOperator({
          binary: settings.codexBinary,
          cwd: home,
          systemPrompt: OPERATOR_PROMPT,
          env: input.env,
          platform: input.platform,
          gate: toolGate,
          onTool,
        })
      : startVisionSession({
          claudeBinary: settings.claudeBinary,
          model: settings.model,
          systemPrompt: OPERATOR_PROMPT,
          workDir: NodePath.join(input.stateDir, "screen"),
          cwd: home,
          env: claudeEnv(),
          platform: input.platform,
          timeoutMs: OPERATOR_TURN_MS,
          gate: toolGate,
          onTool,
        });
  };

  /** The harness's own tools. Its turns never touch the input driver, and a drive reads no files. */
  const operate = async (goal: string, firstSentence: () => void) => {
    const window = focus?.window;
    const folder =
      window === undefined ? null : ((await actions?.folder?.(window).catch(() => null)) ?? null);
    const home = folder ?? input.env["USERPROFILE"] ?? input.env["HOME"] ?? input.stateDir;
    if (
      operator === null ||
      operator.home !== home ||
      !operator.session.alive() ||
      Date.now() - operator.lastAt > LOOK_MEMORY_MS
    ) {
      dropOperator();
      operator = { session: operatorSession(home), lastAt: Date.now(), home };
    }
    const current = operator;
    tainted = false;
    toolsThisTurn = 0;
    answering += 1;
    try {
      const voice = streamSpeech(firstSentence);
      input.onActivity?.("Working");
      void show("Working", goal);
      const title = titlesAllowed() ? focus : null;
      const raw = await current.session.ask(
        [
          {
            type: "text",
            text: `${goal}\n\n${clockLine(new Date())}\n(working in: ${home})${
              title === null ? "" : `\n(the window he is using, as data: ${title.label})`
            }`,
          },
        ],
        voice.feed,
      );
      current.lastAt = Date.now();
      const reply = voice.finish(raw);
      converse("operate", goal, reply);
      input.onActivity?.(null);
      voice.linger(reply);
    } finally {
      answering -= 1;
    }
  };

  let answering = 0;
  /** One conversation for answers and looks, so a follow-up keeps its thread either way. */
  const answer = async (question: string, withScreen: boolean, firstSentence: () => void) => {
    answering += 1;
    try {
      await answerTurn(question, withScreen, firstSentence);
    } finally {
      answering -= 1;
    }
  };
  /**
   * Sentences spoken as they arrive, each shown when the one before it has finished playing (the model
   * writes far ahead of the voice), so the card follows the voice; stopped by a hush like everything else.
   */
  const streamSpeech = (firstSentence: () => void) => {
    const voiceTurnAt = hushes;
    const stream = makeSentenceStream();
    let spoken = 0;
    let soFar = "";
    let aloud = false;
    /** The card these captions own, once the first is up; anything newer on screen ends them. */
    let card: number | null = null;
    const caption = (page: string) => {
      if (voiceTurnAt !== hushes) return;
      if (card === null) {
        void show(face.name, page);
        card = showing;
      } else if (card === showing) void overlay.card({ kicker: face.name, text: page, hint: "" });
    };
    const sayHere = (text: string) => {
      if (voiceTurnAt !== hushes) return;
      if (spoken === 0) firstSentence();
      spoken += 1;
      soFar = `${soFar} ${text}`.trim();
      const page = pageText(soFar).at(-1)!;
      if (say(text, () => caption(page))) aloud = true;
      else caption(page);
    };
    return {
      feed: (delta: string) => {
        for (const sentence of stream.feed(delta)) sayHere(sentence);
      },
      /** The end of the turn. `whole` is spoken if nothing streamed. */
      finish: (whole: string): string => {
        const rest = stream.flush();
        if (rest.length > 0) sayHere(rest);
        else if (spoken === 0) sayHere(whole);
        return whole;
      },
      /** Leaves the answer up until it has been heard and read. Written only, it turns pages at reading pace. */
      linger: (whole: string) => {
        if (!aloud) return linger(face.name, whole);
        if (phoneCapture !== null && whole.trim().length > 0) phoneCapture.card = whole.trim();
        // Every caption is up by the time the voice is done (queueSpeech starts each before `finished`),
        // so a one-sentence reply has its card here too.
        void speech
          .finished()
          .then(() => {
            const mine = card;
            if (mine === null) return;
            return retreatAfterSpeech(pageText(soFar).at(-1)!, () => mine === showing);
          })
          .catch(() => undefined);
      },
    };
  };

  const answerTurn = async (question: string, withScreen: boolean, firstSentence: () => void) => {
    if (run?.mode !== "look" || Date.now() - run.lastAt > LOOK_MEMORY_MS) {
      end();
      const spare = spareLook?.alive() === true ? spareLook : null;
      spareLook = null;
      run = { mode: "look", vision: spare ?? visionFor("look"), lastAt: Date.now() };
    }
    const current = run;
    const voice = streamSpeech(firstSentence);
    const ask = async (
      screen: boolean,
    ): Promise<{ raw: string; shots: ReadonlyArray<ScreenShot> }> => {
      if (screen && !(await approveCapture(question, null))) {
        return { raw: "", shots: [] };
      }
      input.onActivity?.(screen ? "Looking" : "Thinking");
      void show(screen ? "Looking" : "Thinking", question);
      const captured = screen ? await capture() : [];
      const title = screen || titlesAllowed() ? focus : null;
      const window = title === null ? "" : `\n\n(the window he is using: ${title.label})`;
      const raw = await current.vision.ask(
        content(captured, `${question}${window}\n\n${clockLine(new Date())}`),
        voice.feed,
      );
      return { raw, shots: captured.map((c) => c.shot) };
    };
    let turn = await ask(withScreen);
    // The model found it needs to see the screen after all.
    if (!withScreen && turn.raw.trim() === LOOK_REPLY) turn = await ask(true);
    current.lastAt = Date.now();
    if (turn.raw.length === 0) {
      say("All right, I won't look.");
      input.onActivity?.(null);
      return void (await wipe());
    }
    const reply = parseReply(turn.raw);
    input.onTrace?.({
      images: turn.shots.map((s) => [s.screen, s.width, s.height, s.cursorHere]),
      point: reply.point,
      reply: reply.spoken,
    });
    converse(turn.shots.length > 0 ? "look" : "answer", question, reply.spoken);
    // A retry after [LOOK] streamed nothing, so the whole answer is spoken here.
    voice.finish(reply.spoken);
    input.onActivity?.(null);
    await pointAt(reply.point, turn.shots);
    voice.linger(reply.spoken);
  };

  const teachStep = async (note?: string) => {
    if (run?.mode !== "teach" || run.busy) return;
    const lesson = run;
    lesson.busy = true;
    if (lesson.watcher !== null) clearInterval(lesson.watcher);
    lesson.watcher = null;
    try {
      if (lesson.step >= TEACH_MAX_STEPS) {
        const message = "That's a long lesson. Let's stop here. Ask again to pick it up.";
        say(message);
        linger("Lesson", message);
        return end();
      }
      lesson.step += 1;
      // The step on screen stays readable while the next one is worked out.
      if (lesson.step === 1) {
        input.onCue?.("start");
        void show("Lesson", "Looking at your screen");
      } else if (note !== undefined && note !== LOOK_AGAIN) input.onCue?.("stepDone");
      input.onActivity?.("Checking", `Step ${lesson.step}`);
      const captured = await capture();
      // What this step was judged against: any change from here on is his doing.
      const baseline = await fingerprint();
      const shots = captured.map((c) => c.shot);
      const reply = parseReply(
        await lesson.vision.ask(
          content(
            captured,
            teachTurn({ goal: lesson.goal, step: lesson.step, ...(note ? { note } : {}) }),
          ),
        ),
      );
      input.onActivity?.(null);
      if (run !== lesson) return;
      // The words said and the words on the card are the same short sentence; the model's longer text stays in the log.
      const line = stepLine(reply.spoken) || reply.spoken;
      lesson.lastSpoken = line;
      input.onTrace?.({
        teachStep: lesson.step,
        note: note ?? null,
        reply: reply.spoken,
        at: Date.now(),
      });
      if (reply.done) {
        say(line);
        await finishedCard(
          `Finished · ${lesson.step} ${lesson.step === 1 ? "step" : "steps"}`,
          "That is all of it.",
          line,
        );
        return end();
      }
      say(line);
      const found = pointable(reply.point);
      await pointAt(reply.point, shots);
      await show(
        `Step ${lesson.step} · waiting for you`,
        line,
        found
          ? "Do it and I'll notice, or say next."
          : "I couldn't point at it on your screen. Look again, or do it your way and I'll notice.",
        { state: found ? "waiting" : "error", actions: found ? STEP_ACTIONS : LOOK_ACTIONS },
      );
      input.onCue?.("waiting");
      watch(lesson, baseline, line);
    } finally {
      lesson.busy = false;
    }
  };

  /** Waits for the screen to change and settle, then checks it and gives the next step. */
  const watch = (
    lesson: Extract<Run, { mode: "teach" }>,
    baseline: ReadonlyArray<Uint8Array>,
    step: string,
  ) => {
    if (lesson.idle !== null) clearTimeout(lesson.idle);
    lesson.idle = setTimeout(() => {
      if (run === lesson) {
        const message = "I'll stop the lesson here. Ask again whenever you want to carry on.";
        say(message);
        linger("Lesson", message);
        end();
      }
    }, TEACH_IDLE_MS);
    let previous: ReadonlyArray<Uint8Array> | null = null;
    let moved = false;
    let still = 0;
    let polling = false;
    // Until his step moves the screen, a picture is taken only after the desktop reports a change (CU-10).
    let quiet: { seen: number | null; quiet: number } = { seen: null, quiet: 0 };
    // A step is never replaced under him: it has been said and could have been read first.
    let armed = false;
    void Promise.all([speech.finished(), sleep(readingMs(step))]).then(() => (armed = true));
    lesson.watcher = setInterval(() => {
      if (polling || !armed || run !== lesson || lesson.busy) return;
      polling = true;
      void (async () => {
        if (!moved) {
          const count = (await actions?.uiChanges?.().catch(() => null)) ?? null;
          const next = teachShouldLook(quiet, count);
          quiet = next;
          if (!next.look) return;
        }
        const now = await fingerprint();
        // shortcut: a video playing on either display reads as change and never settles, so that
        // lesson waits for "next"; judge only the step's own display if he hits it.
        if (!moved && screensDifference(baseline, now, PIXEL) > CHANGED) moved = true;
        else if (moved && previous !== null) {
          // Two quiet polls (~2 s), so a pause between typed words is not "done".
          still = screensDifference(previous, now, PIXEL) < SETTLED ? still + 1 : 0;
          if (still >= 2) void teachStep("the screen just changed.").catch(fail);
        }
        previous = now;
      })()
        .catch(() => undefined)
        .finally(() => (polling = false));
    }, 900);
  };

  const teach = async (goal: string) => {
    if (!(await approveCapture(goal, "lesson"))) {
      return refuse(
        "capture_declined",
        "All right, I won't look at your screen, so I can't teach that.",
        goal,
      );
    }
    end();
    run = {
      mode: "teach",
      vision: visionFor("teach"),
      goal,
      step: 0,
      lastSpoken: "",
      watcher: null,
      idle: null,
      busy: false,
    };
    input.onChange?.();
    await teachStep();
  };

  const runningMode = (): string | null => (run !== null && run.mode !== "look" ? run.mode : null);

  const perform = (decision: BrainDecision, started: number, decidedAt: number) => {
    let firstAt: number | null = null;
    const finished = () => {
      input.onTimings?.({
        route: decision.route,
        source: decision.source,
        decideMs: decidedAt - started,
        firstSentenceMs: firstAt === null ? null : firstAt - started,
        totalMs: Date.now() - started,
      });
      input.onTurnEnd?.();
    };
    const go = (): Promise<void> => {
      switch (decision.route) {
        case "answer":
          return answer(decision.text, false, () => (firstAt ??= Date.now()));
        case "look":
          return answer(decision.text, true, () => (firstAt ??= Date.now()));
        case "teach":
          return teach(decision.text);
        // "Do it for me": the operator works it with its own tools and gate, as the one assistant does with its hands.
        case "drive":
          return operate(decision.text, () => (firstAt ??= Date.now()));
        case "operate":
          return operate(decision.text, () => (firstAt ??= Date.now()));
        case "clarify":
          firstAt = Date.now();
          converse("clarify", "", decision.text);
          say(decision.text);
          linger("Tessaya", decision.text);
          return Promise.resolve();
        case "control":
          if (decision.control === "next") {
            return run?.mode === "teach" ? teachStep("he says he did it.") : Promise.resolve();
          }
          if (decision.control === "repeat") {
            if (run?.mode === "teach") say(run.lastSpoken);
            return Promise.resolve();
          }
          // Nothing running: a silent no-op, so a stray "stop" costs nothing.
          const wasBusy = runningMode() !== null || answering > 0;
          hush();
          void wipe();
          if (wasBusy) say("Stopped.");
          end();
          return Promise.resolve();
        case "refused":
        case "act":
          return Promise.resolve();
      }
    };
    void go().catch(fail).finally(finished);
  };

  /** Null stops a drive, so it waits longer than a sentence does. */
  const keyboardWindow = async () => {
    const seen = await Promise.race([
      actions?.focus?.().catch(() => null) ?? Promise.resolve(null),
      sleep(KEYBOARD_WAIT_MS).then(() => null),
    ]);
    return seen?.window === undefined ? null : { window: seen.window, label: seen.label };
  };

  const focusSoon = (): Promise<AssistantFocus | null> =>
    Promise.race([
      actions?.focus?.().catch(() => null) ?? Promise.resolve(null),
      sleep(FOCUS_WAIT_MS).then(() => null),
    ]);

  /** The window with the keyboard, for the gate. One that cannot be told apart from a command line is treated as one. */
  const gateWindow = async () => {
    const seen = await focusSoon();
    return seen === null
      ? { label: "unknown", shell: true }
      : {
          label: seen.label,
          shell: isShellWindow(seen.label),
          ...(seen.window === undefined ? {} : { window: seen.window }),
        };
  };

  /** One assistant (D143): one warm session, Baton's tools, the same gate on every call. */
  /** Each warm session's own tool server (one per model), closed with that session. */
  const agentMcps = new Set<BatonMcp>();
  // Each device turn's own tool server, closed when its turn ends; any still open close with the companion.
  const outsideServers = new Set<BatonMcp>();
  // A device turn's conversation file goes with its turn; any left by a crash go now.
  try {
    for (const name of NodeFS.readdirSync(NodePath.join(input.stateDir, "screen")))
      if (/^outside-turn.*\.ndjson$/.test(name))
        NodeFS.rmSync(NodePath.join(input.stateDir, "screen", name), { force: true });
  } catch {
    // No screen folder yet: nothing was left.
  }
  let lastShots: ReadonlyArray<ScreenShot> = [];
  const agentTaint = createTaint();
  /** The plan he approved this turn (plan_show): its steps run without a box each, and pastes keep its clipboard. */
  let planGrant: {
    readonly title: string;
    readonly steps: ReadonlyArray<string>;
    readonly clipboard: string;
  } | null = null;
  type KeysAllowed = {
    window?: number;
    label: string;
    readonly shell: boolean;
    readonly clipboard?: string;
  };
  /** Where keys were last allowed (the gate's window, moved along by her own clicks); checked again as they are sent. */
  let keysAllowed: KeysAllowed | null = null;
  /** The same for a remote session's last call, judged by its own gate. */
  let remoteKeysAllowed: KeysAllowed | null = null;
  /** Her own click may rightly move the keyboard (a dialog it opened): the next keys follow it, the agreement does not. */
  const followOwnClick = async () => {
    if (keysAllowed === null) return;
    const seen = await focusSoon();
    if (seen !== null)
      keysAllowed = {
        ...keysAllowed,
        label: seen.label,
        ...(seen.window === undefined ? {} : { window: seen.window }),
      };
  };
  /** Drive's checks, at the moment keys are sent (keysRefusal): same window, no command line nobody agreed to, the clipboard he saw. */
  const checkKeys = async (
    keys: ReadonlyArray<string> | null,
    allowed: KeysAllowed | null = keysAllowed,
  ) => {
    // Where the keyboard is cannot be read here: that is a refusal, not a pass.
    const seen = actions?.focus === undefined ? null : await keyboardWindow();
    const refusal = keysRefusal({
      allowed,
      now: seen,
      paste: keys !== null && isPasteKeys(keys),
      clipboard: await Electron.clipboard.readText(),
    });
    if (refusal !== null) {
      input.onNote?.("keys_refused", { why: refusal });
      throw new Error(refusal);
    }
  };
  type BatonToolType = ReturnType<typeof buildBatonTools>[number];
  /** Each turn's tools, results, decisions and routes, kept apart from the next turn's. */
  const turns = createTurnLedger();
  // Cleared each turn: a tool that failed twice in one turn may work in the next.
  const toolFailures = new Map<string, number>();
  let chromeRelaunched = false;
  /** The last ui_tree's lines: a click on a text box there only moves the cursor. */
  let lastControls: ReadonlyArray<string> = [];
  const agentGate = createAgentGate({
    actWithoutAsking: () => settings.actWithoutAsking,
    chrome: {
      socialOn: () => settings.socialOn,
      now: () => Date.now(),
      log: (line) =>
        NodeFS.appendFileSync(NodePath.join(input.stateDir, "social-actions.ndjson"), `${line}\n`),
    },
    taint: agentTaint,
    textIsHis: (text) =>
      textIsFromConversation(
        text,
        // "Alfred, type what Freya just said": her words are his too, unless she is private.
        conversations.heard(12, isPrivate).filter((t) => !outsideSaid.has(t.said)),
      ),
    focusedWindow: gateWindow,
    pointerField: (tool, call) => tool === "click_element" && clickTargetsField(lastControls, call),
    confirm: async (p) =>
      (await askHandsFree(
        {
          title: p.title,
          detail: p.detail,
          buttons: ["Go ahead", "Not now"],
          cancel: 1,
          scoped: true,
        },
        p.spoken,
        0,
        p.noOnExpiry,
      )) === 0,
    inPlan: () => planGrant?.steps ?? null,
    agent: () => ({
      ...face,
      leadsProject: (p: ProjectRef) => leadsProject(face, p, actions?.projects?.() ?? []),
    }),
    jobProjects: async (id) => (await actions?.jobProjects?.(id)) ?? null,
    keysAllowed: (at) => {
      const plan = planGrant;
      // Inside a plan, a paste may only paste what the clipboard held when he said go ahead.
      keysAllowed = { ...at, ...(plan === null ? {} : { clipboard: plan.clipboard }) };
    },
    record: (entry) => {
      if (typeof entry["tool"] === "string") {
        // The tool itself is listed once, by onTool.
        turns
          .current()
          .decisions.push({ tool: entry["tool"], outcome: String(entry["outcome"] ?? "") });
        // Not "Thinking" while it clicks and types: the pill is the one line that says what it is doing.
        input.onActivity?.("Working");
      }
      input.onAction?.({ by: "assistant", persona: face.name, ...entry });
    },
  });

  // Remote hands: its own gate and taint. The caller is a session the Director gave baton:hands, so what it read is not
  // carried from one call to the next; every rule One Trust has still applies to each call. Away, a question is a no.
  const remoteTaint = createTaint();
  const remoteGate = createAgentGate({
    actWithoutAsking: () => false,
    taint: remoteTaint,
    textIsHis: () => false,
    focusedWindow: gateWindow,
    confirm: async (p) =>
      settings.remoteHandsAway
        ? false
        : (await askHandsFree(
            {
              title: `Remote: ${p.title}`,
              detail: p.detail,
              buttons: ["Go ahead", "Not now"],
              cancel: 1,
              scoped: true,
            },
            p.spoken,
            0,
            p.noOnExpiry,
          )) === 0,
    record: (entry) => input.onAction?.({ by: "remote-hands", ...entry }),
    keysAllowed: (at) => void (remoteKeysAllowed = at),
  });
  // Its pointer clicks ask every call, as its taint does not carry over; away, the answer is no (CU-6).
  const remoteMouse = createMouseConsent(async () =>
    settings.remoteHandsAway
      ? false
      : (await askHandsFree(
          {
            title: "Remote: use your mouse?",
            detail:
              "A remote session needs to use your mouse: the pointer moves and clicks. Say no and nothing is clicked.",
            buttons: ["Go ahead", "Not now"],
            cancel: 1,
            scoped: true,
          },
          "A remote session needs to use your mouse. Is that all right?",
          0,
          true,
        )) === 0,
  );
  /** A remote session at work shows as one line in the pill, gone a moment after its last call. */
  let remoteQuiet: ReturnType<typeof setTimeout> | null = null;
  const remoteActivity = (tool: string | null) => {
    if (remoteQuiet !== null) clearTimeout(remoteQuiet);
    remoteQuiet = null;
    if (tool !== null) input.onActivity?.("Remote session", tool);
    else remoteQuiet = setTimeout(() => input.onActivity?.(null), REMOTE_QUIET_MS);
  };
  let remoteTools: ReadonlyMap<string, BatonToolType> | null = null;
  const remoteToolsOf = (): ReadonlyMap<string, BatonToolType> => {
    if (remoteTools !== null) return remoteTools;
    const side = actions?.hands?.() ?? null;
    if (side === null || input.remoteOps === undefined) {
      throw new Error("The sensing helper is not running, so remote hands are not ready.");
    }
    remoteTools = new Map(
      withFailureGuard(
        buildRemoteHandsTools({
          sidecar: side,
          scratchDir: NodePath.join(input.stateDir, "screen"),
          ops: input.remoteOps,
          foreground: {
            clickAt: async (to, double) => {
              await remoteMouse.need();
              const dip = Electron.screen.screenToDipPoint(to);
              await pointerAction(dip, () => driverFor().clickAt(dip, "left", double ? 2 : 1));
            },
            type: async (text) => {
              await checkKeys(null, remoteKeysAllowed);
              await driverFor().type(text);
            },
            press: async (keys) => {
              await checkKeys(keys, remoteKeysAllowed);
              await driverFor().press(keys);
            },
            keyboardIn: async (window) =>
              (await focusSoon())?.label.toLowerCase().includes(window.toLowerCase()) === true,
            // A pointer click brings its window forward; the window he was using gets the keyboard back afterwards.
            restoreFocus: async (run) => {
              const before = await focusSoon();
              await run();
              if (before?.window === undefined) return false;
              const back = await side.focusWindow(before.window).catch(() => ({ error: "failed" }));
              return back.error === undefined;
            },
          },
        }),
      ).map((t) => [t.name, t]),
    );
    return remoteTools;
  };

  const driverFor = () => {
    if (driver !== null) return driver;
    const made = createInputDriver({
      platform: input.platform,
      toPhysical: (p) => (input.platform === "win32" ? Electron.screen.dipToScreenPoint(p) : p),
      clipboard: Electron.clipboard,
      sidecar: () => {
        const side = actions?.hands?.() ?? null;
        if (side === null) return null;
        return {
          input: side.input,
          // A busy sidecar can miss the short focus read; a longer one follows before giving up on it.
          target: async () => ((await focusSoon()) ?? (await keyboardWindow()))?.window ?? null,
          pasteInto: side.pasteInto,
          paste: side.paste,
        };
      },
    });
    const own = input.ownEscape;
    driver =
      own === undefined
        ? made
        : {
            ...made,
            press: (keys) =>
              keys.some((k) => k.toLowerCase() === "escape")
                ? own(() => made.press(keys))
                : made.press(keys),
          };
    return driver;
  };
  const desktopPoint = (a: {
    readonly x: number;
    readonly y: number;
    readonly screen?: number;
  }) => {
    const shot = shotFor(lastShots, a.screen ?? null);
    if (shot === null) throw new Error("Take a screenshot first, so I know where things are.");
    return toDesktop(a, shot);
  };
  /** Where her cursor last went, so typing and keys show where she was working. */
  let actLast: { x: number; y: number } | null = null;
  /** Her own cursor glides to the target just before an action and the action follows the glide (never his pointer). */
  const showAct = async (act: Act, control?: { x: number; y: number } | null) => {
    if (!settings.actCursor) return;
    const to = actTarget({ control, last: actLast, window: focus?.centre ?? null });
    if (to === null) return;
    actLast = { x: to.x, y: to.y };
    await sleep(await overlay.glide(actLast, actLabel(act)).catch(() => 0));
  };
  const mouse = createMouseConsent(
    async () =>
      (await askHandsFree(
        {
          title: "Use your mouse?",
          detail:
            "I need to use your mouse for this: the pointer moves and clicks. Say no and I'll find another way.",
          buttons: ["Go ahead", "Not now"],
          cancel: 1,
          scoped: true,
        },
        "I need to use your mouse for this. Is that all right?",
      )) === 0,
  );
  /** Where Baton last left the pointer this turn; null before its first move. */
  let leftPointer: { x: number; y: number } | null = null;
  const pointerAction = async (to: { x: number; y: number }, act: () => Promise<void>) => {
    const here = Electron.screen.getCursorScreenPoint();
    if (pointerMoved(leftPointer, here)) {
      throw new Error("He moved the mouse, so I stopped. Tell him, and carry on only if he asks.");
    }
    await act();
    leftPointer = to;
  };
  const vaultState = vaultFor(input.stateDir);
  vaultHost = createVaultHost({
    vault: vaultState.vault,
    confirm: async (title, detail) =>
      (await askHandsFree(
        { title, detail, buttons: ["Go ahead", "Not now"], cancel: 1, scoped: true },
        title,
        0,
        true,
      )) === 0,
    type: async (text) => {
      await driverFor().type(text, true);
    },
    clipboard: {
      read: () => Electron.clipboard.readText(),
      write: (text) => Electron.clipboard.writeText(text),
      clear: () => Electron.clipboard.clear(),
    },
    // A device's turn has no vault tools at all (outsideSlot.ts).
    tainted: () => agentTaint.on(),
    audit: vaultState.audit,
    hello: (message) => windowsHello(message, input.platform),
    askToUnlock: () => input.onOpenTab?.("vault"),
  });
  // Transforms and spoken edits on the selection (Wispr parity): copy it, ask his own Claude, paste over it.
  const transformStore = createTransformStore(input.stateDir);
  const textEdit = createTextEdit({
    copySelection: async () => {
      const before = await Promise.resolve(Electron.clipboard.readText());
      Electron.clipboard.clear();
      await driverFor().press(["ctrl", "c"]);
      let got = "";
      for (let i = 0; i < 8 && got === ""; i += 1) {
        await new Promise((r) => setTimeout(r, 60));
        got = await Promise.resolve(Electron.clipboard.readText());
      }
      Electron.clipboard.writeText(before);
      return got === "" ? null : got;
    },
    replaceSelection: (text) => driverFor().type(text),
    press: (keys) => driverFor().press(keys),
    setClipboard: (text) => Electron.clipboard.writeText(text),
    // A rewrite of text he selected is routine work: the cheap model in his routing table (D148).
    ask: createModelAsk({
      claudeBinary: () => settings.claudeBinary,
      model: () => {
        try {
          const file = NodePath.join(input.stateDir, PACK_FOLDER, "routing.json");
          return parseRouting(NodeFS.readFileSync(file, "utf8")).cheap;
        } catch {
          return DEFAULT_ROUTING.cheap;
        }
      },
      workDir: NodePath.join(input.stateDir, "edit"),
      env: claudeEnv,
      platform: input.platform,
    }),
    now: () => Date.now(),
  });
  let hotkeys: ReadonlyArray<string> = [];
  const setTransformHotkeys = (on: boolean): void => {
    for (const k of hotkeys) Electron.globalShortcut.unregister(k);
    hotkeys = [];
    if (!on) return;
    const bound: string[] = [];
    const run = (work: () => Promise<string>) => () =>
      void work().then(
        (line) => linger("Tessaya", line),
        () => undefined,
      );
    transformStore
      .all()
      .slice(0, 9)
      .forEach((t, i) => {
        const key = hotkeyFor(i);
        if (
          key !== null &&
          Electron.globalShortcut.register(
            key,
            run(() => textEdit.transform(t)),
          )
        ) {
          bound.push(key);
        }
      });
    const undoKey = `${HOTKEY_PREFIX}Z`;
    if (
      Electron.globalShortcut.register(
        undoKey,
        run(() => textEdit.undo()),
      )
    )
      bound.push(undoKey);
    hotkeys = bound;
  };
  setTransformHotkeys(transformStore.read().enabled);
  // The assistant's last numbered tree: a click by number is refused once any other caller numbered a list.
  let lastTree: number | undefined;
  const toolHost: ToolHost = {
    // The index lives on one server (D5); this machine's server answers from it or from the paired peer that holds it.
    history: async (ask) => {
      if (input.direct === undefined) return "The history index is not available here.";
      const answer = (await input.direct("baton.memory.historySearch", ask).catch(() => null)) as {
        readonly text?: string;
      } | null;
      return (
        answer?.text ??
        "This computer's server did not answer, so past work could not be searched right now."
      );
    },
    vault: {
      list: () => vaultHost!.list(),
      use: (a) => vaultHost!.use(a),
      savePending: (name, category) => vaultHost!.savePending(name, category),
    },
    capture: async (a) => {
      if (!(await approveCapture("what is on your screen", null))) {
        throw new Error(
          "Looking at his screen was not allowed: he said no, or did not answer the question in time. Ask him again, or ask which screen he means.",
        );
      }
      if (a?.zoom !== undefined) {
        const shot = shotFor(lastShots, a.screen ?? null);
        if (shot === null) throw new Error("Take a screenshot first, then zoom into part of it.");
        const from = toDesktop(a.zoom, shot);
        const to = toDesktop({ x: a.zoom.x + a.zoom.width, y: a.zoom.y + a.zoom.height }, shot);
        const area = await overlay.hiddenFor(() =>
          captureArea({ x: from.x, y: from.y, width: to.x - from.x, height: to.y - from.y }),
        );
        lastShots = [area.shot];
        imagesSent += 1;
        return {
          text: `a closer look at that area, image ${area.shot.width}x${area.shot.height}; points in it are its own pixels`,
          images: [{ data: area.jpeg.toString("base64"), mimeType: "image/jpeg" }],
        };
      }
      const window = a?.all === true ? null : await windowShot();
      if (window !== null) {
        lastShots = [window.shot];
        imagesSent += 1;
        return {
          text: `the window he is using (${focus?.label ?? "the window with the keyboard"}), image ${window.shot.width}x${window.shot.height}. For his whole screen, all.`,
          images: [{ data: window.jpeg.toString("base64"), mimeType: "image/jpeg" }],
        };
      }
      const captured = await capture();
      lastShots = captured.map((c) => c.shot);
      shotWindow = null;
      imagesSent += captured.length;
      const missing = missingDisplaysNote(captured.length, Electron.screen.getAllDisplays().length);
      return {
        text: [
          ...captured.map(
            (c) =>
              `${screenLabel(c.shot, captured.length)}, image ${c.shot.width}x${c.shot.height}`,
          ),
          ...(missing === null ? [] : [missing]),
        ].join("\n"),
        images: captured.map((c) => ({ data: c.jpeg.toString("base64"), mimeType: "image/jpeg" })),
      };
    },
    uiTree: async (_window, find) => {
      if (!(await approveCapture("what is on your screen", null))) {
        throw new Error("He did not allow looking at his screen.");
      }
      const tree = await actions?.uiTree?.(find, true);
      if (tree === null || tree === undefined) {
        throw new Error("The window's controls can't be read here. Take a screenshot instead.");
      }
      lastTree = tree.tree;
      lastControls = tree.controls;
      return treeText(tree);
    },
    focusWindow: async (title) => {
      const side = actions?.hands?.() ?? null;
      if (side === null) throw new Error("The sensing helper is not running.");
      const done = await side.focusWindowTitled(title);
      if (done.error !== undefined)
        throw new Error(
          `${done.error} Text can still go into it without focus: type_text with window "${title}".`,
        );
      const which = titlesAllowed() ? `"${done.title ?? title}"` : "That window";
      return `${which} is in front and has the keyboard. Read ui_tree for its controls.`;
    },
    // Quiet: an action's readback never asks, so it is left out while looking needs his yes.
    focusState: async () => (titlesAllowed() ? ((await actions?.focusState?.()) ?? null) : null),
    browserRoute: async (ask) => {
      const check = await refreshChrome();
      const tree = await actions?.uiTree?.().catch(() => null);
      // The tree is the focused window's: it says nothing about Chrome unless Chrome is that window.
      const accessibility =
        tree === null || tree === undefined || !/chrome/i.test(tree.window)
          ? "unknown"
          : accessibilityLooksOff(tree.controls.join("\n"))
            ? "off"
            : "on";
      const choice = chooseBrowserRoute({
        task: ask.task,
        url: ask.url,
        needsLogin: ask.needsLogin,
        ownChromeOn: settings.browserChrome,
        chrome: check,
        chromeVisible: null,
        accessibility,
        relaunchApproved: chromeRelaunched,
      });
      turns.current().routes.push({ route: choice.route, why: choice.why });
      return [
        `${choice.route}: ${choice.why}`,
        ...choice.steps.map((step) => `- ${step}`),
        ...(choice.needsApproval === undefined ? [] : ["If he agrees, browser_accessibility_on."]),
      ].join("\n");
    },
    browserAccessibilityOn: async () => {
      const response = await askHandsFree(
        {
          title: "Restart Chrome?",
          detail:
            "Chrome closes and opens again with your tabs, so I can read its pages through the screen's controls.",
          buttons: ["Go ahead", "Not now"],
          cancel: 1,
          scoped: true,
        },
        "Can I restart Chrome? Yes or no.",
      );
      if (response !== 0) return "He said no.";
      chromeRelaunched = true;
      return relaunchChromeWithAccessibility(realRelaunchPorts(input.platform));
    },
    point: async (a) => {
      if (lastShots.length === 0) throw new Error("Take a screenshot first.");
      await pointAt(
        { x: a.x, y: a.y, label: a.label ?? null, screen: a.screen ?? null, confidence: null },
        lastShots,
      );
      return "Pointing.";
    },
    guided: async (_mode, goal) => {
      // The lesson runs on its own after this turn ends; its card must not be replaced by the turn's closing line.
      void teach(goal).catch(fail);
      return "The lesson has started and its first step is on his screen. Say nothing more.";
    },
    planShow: async (plan) => {
      // A new plan replaces any earlier yes, whatever he answers to this one.
      planGrant = null;
      const title = plan.title.replace(/[.?!]$/, "");
      const response = await askHandsFree(
        {
          title: `Want me to ${title.charAt(0).toLowerCase()}${title.slice(1)}?`,
          detail: `${plan.steps.map((step, i) => `${i + 1}. ${step}`).join("\n")}\n\nYou watch; your mouse stays yours. Esc or "stop" stops me. Anything that deletes, sends, pays or publishes still asks.`,
          buttons: ["Go ahead", "Change a step", "Not now"],
          cancel: 2,
          scoped: true,
        },
        "Shall I do that? Yes or no. Or tell me what to change.",
      );
      const answer = response === 0 ? "approved" : response === 1 ? "change" : "declined";
      input.onNote?.("plan", { title: plan.title, steps: plan.steps, answer });
      if (response === 0) {
        planGrant = {
          title: plan.title,
          steps: plan.steps,
          clipboard: await Electron.clipboard.readText(),
        };
        return "He said go ahead. Do these steps now with the hands tools; what still asks will ask him.";
      }
      return response === 1
        ? "He wants to change a step. Ask him which and how in one short question, then plan_show the new plan."
        : "He said no. Do nothing; say so in a few words.";
    },
    click: async (a) => {
      const point = desktopPoint(a);
      // A name read in the screenshot snaps the click onto that control when the tree finds it near the point.
      const found =
        a.label === undefined ? null : await actions?.locate?.(a.label, point).catch(() => null);
      if (found?.coveredBy !== undefined) {
        throw new Error(
          `"${found.name}" is covered by "${found.coveredBy}", so a click would land there. Take a screenshot, deal with what covers it, then click.`,
        );
      }
      const to = found === null || found === undefined ? point : { x: found.x, y: found.y };
      // A picture of one window says nothing about what is on top of it now: the click must reach that window.
      if (shotWindow !== null) {
        const under = await actions?.windowAt?.(to).catch(() => null);
        if (under !== null && under !== undefined && under.window !== shotWindow) {
          throw new Error(
            `The window in the screenshot${shotLabel === null ? "" : ` (${shotLabel})`} is covered there by "${under.label}", so nothing was clicked. Take a screenshot again.`,
          );
        }
      }
      // His mouse stays his (CU-6): the control at the point is pressed by its own pattern when it has one.
      if (a.button !== "right" && a.double !== true) {
        const pressed = await actions?.locate?.("", to, false, true).catch(() => null);
        if (pressed?.invoked !== undefined) {
          void showAct({ kind: "click", name: pressed.name || a.label }, pressed);
          await followOwnClick();
          const how =
            pressed.invoked === "focus"
              ? "focus, no pointer"
              : `${pressed.invoked}, no pointer, no focus change`;
          return `Pressed ${pressed.name || "it"} (${how})${pressed.state ? `; it now reads ${pressed.state}` : ""}.`;
        }
      }
      await mouse.need();
      await showAct({ kind: "click", name: found?.name ?? a.label, double: a.double === true }, to);
      await pointerAction(to, () =>
        driverFor().clickAt(to, a.button ?? "left", a.double === true ? 2 : 1),
      );
      await followOwnClick();
      return "Clicked.";
    },
    windowKey: async () => {
      const seen = (await focusSoon()) ?? (await keyboardWindow());
      if (seen?.window === undefined)
        throw new Error("The window with the keyboard can't be told apart, so a batch cannot run.");
      return String(seen.window);
    },
    clickElement: async (target, double) => {
      const label = typeof target === "number" ? `line ${target}` : target;
      // Its own pattern first: his pointer and the focus stay where they are (CU-6).
      const found = await actions?.locate?.(
        label,
        Electron.screen.getCursorScreenPoint(),
        true,
        !double,
        typeof target === "number" ? { line: target, tree: lastTree ?? 0 } : undefined,
      );
      if (found === null || found === undefined) {
        throw new Error(
          `No control is named "${label}" in the window with the keyboard. Take a screenshot and click by position.`,
        );
      }
      if (found.invoked === "focus") {
        // A text box, given the keyboard by UI Automation and checked. No blind click after: it could land
        // on a dialog or move the caret in his draft, so the model decides what next.
        void showAct({ kind: "click", name: found.name }, found);
        const now = (await actions?.focusState?.().catch(() => null))?.focus;
        const there = focusIsOn(now, found.name);
        await followOwnClick();
        return there === null
          ? `Focused ${found.name}; where the keyboard is could not be checked.`
          : there
            ? `The keyboard is in ${found.name}.`
            : `Focused ${found.name}, but the keyboard is in ${now}.`;
      }
      if (found.invoked !== undefined) {
        // A press by pattern has already happened: her cursor follows it rather than lead it.
        void showAct({ kind: "click", name: found.name }, found);
        await followOwnClick();
        return `Pressed ${found.name} (${found.invoked}, no pointer, no focus change)${found.state ? `; it now reads ${found.state}` : ""}.`;
      }
      if (found.coveredBy !== undefined) {
        throw new Error(
          `"${found.name}" is covered by "${found.coveredBy}", so a click would land there. Take a screenshot, deal with what covers it, then click.`,
        );
      }
      const to = { x: found.x, y: found.y };
      await mouse.need();
      await showAct({ kind: "click", name: found.name, double }, to);
      input.onNote?.("hands_pointer", {
        label: found.name,
        why: double ? "double click" : "no pattern",
      });
      await pointerAction(to, () => driverFor().clickAt(to, "left", double ? 2 : 1));
      await followOwnClick();
      return `Clicked ${found.name} (pointer: it has no pattern to act on).`;
    },
    waitFor: async (label, seconds) => {
      const until = Date.now() + seconds * 1000;
      let slow: Error | null = null;
      do {
        const found = await actions
          ?.locate?.(label, Electron.screen.getCursorScreenPoint(), true)
          .catch((error: Error) => ((slow = error), null));
        if (found !== null && found !== undefined) return `${found.name} is there.`;
        await sleep(400);
      } while (Date.now() < until);
      // Not "not there" when the tree could not be read in time: that would send the model to pixels for nothing.
      return slow === null
        ? `No control named "${label}" appeared in ${seconds} seconds.`
        : `${(slow as Error).message} Whether "${label}" appeared is not known.`;
    },
    scroll: async (amount) => {
      await driverFor().scrollAt(null, amount);
      return "Scrolled.";
    },
    drag: async (a) => {
      const d = driverFor();
      const from = desktopPoint(a);
      const to = desktopPoint({
        x: a.toX,
        y: a.toY,
        ...(a.screen === undefined ? {} : { screen: a.screen }),
      });
      // Explorer and most lists start a drag only after the pointer moves past a few pixels with the button down.
      await pointerAction(to, async () => {
        await d.pressAt(from);
        for (const t of [0.2, 0.4, 0.6, 0.8]) {
          await d.moveAt({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t });
        }
        await d.releaseAt(to);
      });
      return "Dragged.";
    },
    type: async (text, window) => {
      if (window !== undefined) {
        const side = actions?.hands?.() ?? null;
        if (side === null) throw new Error("The sensing helper is not running.");
        const added = await typeByValue(side.setValue, window, text);
        if (added !== null) return added;
        throw new Error(
          `"${window}" has no text box that takes a value. window_focus it, then type_text without window.`,
        );
      }
      await checkKeys(null);
      await showAct({ kind: "type" });
      await driverFor().type(text);
      return "Typed.";
    },
    press: async (keys) => {
      await checkKeys(keys);
      await showAct({ kind: "press", keys });
      await driverFor().press(keys);
      return "Pressed.";
    },
    sessions: async () => actions?.sessionsList?.() ?? "No sessions are listed here yet.",
    ...(input.catalog === undefined ? {} : { catalog: lateCatalog(input.catalog) }),
    session: async (id) =>
      actions?.sessionShow?.(id) ?? "There is no session by that id. Use sessions_list.",
    send: async (id, text) =>
      actions?.sessionSend?.(id, text) ?? "There is no session by that id. Use sessions_list.",
    fleet: async () => actions?.fleetStatus?.() ?? "Sessions are not reachable from here yet.",
    dictation: async (on) => actions?.dictation?.(on) ?? "Dictation is not available here.",
    assistantModel: async (model, effort) => setModelByName(model, effort),
    memory: async (query) => {
      const hits = conversation.search(query);
      const kept = await memory.search(query);
      const found = [
        ...kept,
        ...hits.map(
          (t) =>
            `${t.at.slice(0, 16).replace("T", " ")}\nhe said: ${t.said}\n${(t.persona !== undefined && t.persona !== face.id ? nameOf(t.persona) : undefined) ?? "you"} replied: ${t.reply}`,
        ),
      ];
      return found.length === 0 ? "Nothing earlier matches." : found.join("\n\n");
    },
    conversationSearch: async (ask) =>
      answerConversationSearch(
        {
          conversations,
          personas: readPack(NodePath.join(input.stateDir, PACK_FOLDER)).personas,
          speaking: face,
          isPrivate,
        },
        ask,
      ),
    remember: (text) => memory.remember(text),
    forget: (id) => memory.forget(id),
    pin: (id, pinned) => memory.pin(id, pinned),
    memoryHistory: (id) => memory.history(id),
    used: async () => {
      const text = await memory.used();
      // The memories behind the last answer, shown where he is looking as well as read out.
      if (text.startsWith("- ")) linger("Memory used", text);
      return text;
    },
    jobs: async (op, args) => {
      // His turn: a card and his yes. A device's turn reaches here as a proposal (outsideSlot.ts).
      if (op === "user_job_create" || op === "user_job_propose")
        return createUserJob(args, op === "user_job_propose");
      // A weave never carries a secret: it is offered to the vault instead and nothing is sent.
      if (op === "weave_send") {
        const secret = detectSecret(String(args["text"] ?? ""));
        if (secret !== null) {
          return (
            vaultHost?.offer(String(args["text"]), secret) ??
            `That looks like ${secret}, and a weave never carries one. Nothing was sent.`
          );
        }
      }
      return actions?.jobs?.(op, args) ?? "Jobs are not reachable from here yet.";
    },
    target: async (label, workSessionId) => {
      conversation.add({
        route: "act",
        said: "(noted what this is about)",
        reply: label,
        target: { label, ...(workSessionId === undefined ? {} : { workSessionId }) },
      });
      return "Noted.";
    },
  };
  /**
   * His own standing job (KIRO-1), from the job_create call: checked, read back on a card, and saved only on his yes.
   * A device's or another agent's turn can only leave it as a proposal, off until he approves it on the Trust page.
   */
  const createUserJob = async (
    args: Readonly<Record<string, unknown>>,
    proposal: boolean,
  ): Promise<string> => {
    const personas = readPack(NodePath.join(input.stateDir, PACK_FOLDER)).personas;
    const made = userJobFromArgs(args, {
      owner: face.id,
      id: "",
      now: Date.now(),
      owners: personas.map((p) => p.id),
    });
    if ("refused" in made) return `Nothing was saved: ${made.refused} Ask him for what is missing.`;
    const save = (proposed: boolean) =>
      actions?.jobs?.("user_job_save", { job: made.job, proposed }) ??
      Promise.resolve("Standing jobs are not reachable from here yet.");
    if (proposal) return save(true);
    const response = await askHandsFree(
      {
        title: `Set up "${made.job.title}"?`,
        detail: `${userJobCard(made.job, personas.find((p) => p.id === made.job.owner)?.name ?? made.job.owner)}\n\nIt runs by itself; every run is judged as one nobody is watching, and anything that would act is held. You can switch it off or remove it on the Trust page.`,
        buttons: ["Set it up", "Not now"],
        cancel: 1,
        scoped: true,
      },
      `Shall I set up ${made.job.title}, ${whenText(made.job.trigger)}: ${made.job.instruction}? Yes or no.`,
    );
    input.onNote?.("user_job", { title: made.job.title, answer: response === 0 ? "yes" : "no" });
    if (response !== 0) return "He said no. Nothing was saved; say so in a few words.";
    return save(false);
  };
  const agentStart = (systemPrompt: string, chosen = leadBrain()): Promise<VisionSession> =>
    sessionWithOwnMcp(
      () =>
        startBatonMcp({
          tools: withFailureGuard(buildBatonTools(toolHost), toolFailures),
          gate: stopsOnCutIn(agentGate, cutIns.since),
          scrub: (text) => vaultHost?.scrub(text) ?? text,
          onResult: ({ text, ...r }) => {
            const record = turns.current();
            record.results.push(r);
            // The answer stays on this machine, only for replaying the turn if he asks to learn from it.
            if (r.ok && text !== undefined) record.answers[r.tool] ??= text.slice(0, 2_000);
          },
        }),
      (mcp) =>
        startVisionSession({
          claudeBinary: settings.claudeBinary,
          model: chosen.model,
          effort: chosen.effort,
          systemPrompt,
          workDir: NodePath.join(input.stateDir, "screen"),
          cwd: input.env["USERPROFILE"] ?? input.env["HOME"] ?? input.stateDir,
          env: claudeEnv(),
          platform: input.platform,
          timeoutMs: OPERATOR_TURN_MS,
          gate: stopsOnCutIn(
            async (call) =>
              call.tool.startsWith(BATON_TOOL_PREFIX) ? { allow: true as const } : agentGate(call),
            cutIns.since,
          ),
          mcp: { url: mcp.url, token: mcp.token },
          chrome: settings.browserChrome,
          onTool: (call) => turns.current().tools.push(call.tool),
        }),
      agentMcps,
    );
  /** A device turn's session: its slot's tool server and harness gate (outsideSlot.ts). */
  const sessionStart = async (
    systemPrompt: string,
    chosen: Brain,
    slot: {
      readonly host: ToolHost;
      readonly gate: Gate;
      readonly failures: Map<string, number>;
      readonly keep: (mcp: BatonMcp) => Promise<void>;
      readonly wrap?: (tools: ReadonlyArray<BatonTool>) => ReadonlyArray<BatonTool>;
      readonly onResult?: Parameters<typeof startBatonMcp>[0]["onResult"];
    },
  ): Promise<VisionSession> => {
    const mcp = await startBatonMcp({
      tools: (slot.wrap ?? ((tools) => tools))(
        withFailureGuard(buildBatonTools(slot.host), slot.failures),
      ),
      gate: slot.gate,
      scrub: (text) => vaultHost?.scrub(text) ?? text,
      ...(slot.onResult === undefined ? {} : { onResult: slot.onResult }),
    });
    await slot.keep(mcp);
    return startVisionSession({
      claudeBinary: settings.claudeBinary,
      model: chosen.model,
      effort: chosen.effort,
      systemPrompt,
      workDir: NodePath.join(input.stateDir, "screen"),
      cwd: input.env["USERPROFILE"] ?? input.env["HOME"] ?? input.stateDir,
      env: claudeEnv(),
      platform: input.platform,
      timeoutMs: OPERATOR_TURN_MS,
      gate: async (call) =>
        call.tool.startsWith(BATON_TOOL_PREFIX) ? { allow: true as const } : slot.gate(call),
      mcp: { url: mcp.url, token: mcp.token },
      chrome: settings.browserChrome,
      onTool: (call) => turns.current().tools.push(call.tool),
    });
  };
  /** What one turn may leave the next, his or a device's: nothing. */
  const freshTurn = () => {
    planGrant = null;
    keysAllowed = null;
    turns.begin();
    toolFailures.clear();
    leftPointer = null;
    mouse.reset();
    lastShots = [];
    shotWindow = null;
    lastTree = undefined;
  };
  const beginTurn = (said: string) => {
    cutIns.begin();
    memory.beginTurn();
    agentTaint.reset(said);
    freshTurn();
  };
  const agentOf = (): AssistantAgent => {
    agent ??= createAssistantAgent({
      start: agentStart,
      conversation,
      conversationOf: conversations.of,
      isPrivate,
      latest: conversations.latest,
      nameOf,
      clockLine: () => clockLine(new Date()),
      presence: async () => (await actions?.presence?.()) ?? "",
      images: () => imagesSent,
      notes: async () => {
        const standing = await memory.standing();
        // His operating-system pack frames the jobs this assistant starts and splits (D148), read fresh.
        const frame = assistantFrame(readPack(NodePath.join(input.stateDir, PACK_FOLDER)));
        return `${frame}\n\n${standing === "" ? notesBlock(notes.list()) : standing}`;
      },
      recall: async (text, project) => {
        const learned = skillsForTurn(
          skillsDir(),
          { text, app: appOf(focus?.label ?? null), persona: face.id, project },
          face.tools ?? buildBatonTools(toolHost).map((t) => t.name),
        );
        turns.current().skills.push(...learned.slugs);
        const remembered = await memory.forSentence(text, project);
        return [remembered, learned.block].filter((b) => b !== "").join("\n\n");
      },
      learn: (said, reply, project) => {
        // Called before this turn is written, so the newest turn in the file is the one before.
        const before = conversation.recent(1)[0];
        memory.learn(
          said,
          reply,
          agentTaint.on(),
          project,
          before === undefined ? "" : `he said: ${before.said}\nyou replied: ${before.reply}`,
        );
      },
      beginTurn,
    });
    return agent;
  };
  /**
   * A device's or agent's ask gets a session of its own, started fresh each time: none of his conversation, presence,
   * missed turns or standing memory, so "repeat what you told him" has nothing to repeat. It costs a cold start.
   */
  const outsideAgentOf = (standing?: StandingRunJob) => {
    const file = NodePath.join(
      input.stateDir,
      "screen",
      `outside-turn-${NodeCrypto.randomUUID()}.ndjson`,
    );
    const slot = createOutsideSlot({
      host: toolHost,
      memoryCall: (op, args) =>
        actions?.memory === undefined
          ? Promise.reject(new Error("Memory is not reachable yet."))
          : actions.memory(op, args),
      notes,
      focusedWindow: gateWindow,
      // A standing job's run has nobody to ask: an ask is a no.
      confirm: async (p) =>
        standing === undefined &&
        (await askHandsFree(
          {
            title: p.title,
            detail: p.detail,
            buttons: ["Go ahead", "Not now"],
            cancel: 1,
            scoped: true,
          },
          p.spoken,
          0,
          p.noOnExpiry,
        )) === 0,
      record: (entry) =>
        input.onAction?.({
          by: "assistant",
          persona:
            standing === undefined
              ? "Tessaya, for a paired device"
              : `Tessaya, for your standing job "${standing.title}"`,
          ...entry,
        }),
      jobProjects: async (id) => (await actions?.jobProjects?.(id)) ?? null,
    });
    const gate: Gate = standing === undefined ? slot.gate : standingGate(slot.gate, standing);
    let mine: BatonMcp | null = null;
    const agent = createAssistantAgent({
      start: (systemPrompt, brain = leadBrain()) =>
        sessionStart(systemPrompt, brain, {
          host: slot.host,
          gate,
          failures: new Map(),
          wrap:
            standing === undefined
              ? slot.guard
              : (tools) => slot.guard(tools.filter((t) => standing.tools.includes(t.name))),
          keep: async (mcp) => {
            await mine?.close();
            // Cancelled while it was starting: the server that came up late goes at once.
            if (slot.closed()) {
              await mcp.close();
              throw new SessionClosed("The device's turn was stopped.");
            }
            mine = mcp;
            outsideServers.add(mcp);
          },
        }),
      conversation: createConversationLog({ file }),
      clockLine: () => clockLine(new Date()),
      notes: () => assistantFrame(readPack(NodePath.join(input.stateDir, PACK_FOLDER))),
      recall: (text, project) => slot.memory.forSentence(text, project),
      beginTurn: slot.beginTurn,
    });
    let ending: Promise<void> | null = null;
    return {
      say: agent.say,
      /** Stops the turn: its open question closes as a no, and what it was running gets up to 2 s to stop. */
      end: (): Promise<void> =>
        (ending ??= (async () => {
          if (turnLock.deviceRunning()) windows.closePrompt();
          await slot.close();
          agent.dispose();
          if (mine !== null) {
            outsideServers.delete(mine);
            await mine.close();
          }
          NodeFS.rmSync(file, { force: true });
        })()),
    };
  };
  /**
   * One run of his own standing job (KIRO-1): a device's kind of turn (a fresh session, its own gate with taint on, the
   * walled memory view, no vault), in the device's place in the lock so his turn stops it, and only the job's tools.
   */
  const runStanding = async (
    job: StandingRunJob,
    /** The whole pass's budget: a job still waiting for its turn when it ends does not start. */
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<{
    readonly status: "ok" | "error" | "timeout" | "cancelled";
    readonly text: string;
    readonly model?: string;
    readonly turns?: number;
  }> => {
    const busy = {
      status: "cancelled" as const,
      text: "Held: a lesson, drive or look was running.",
    };
    if (run !== null) return busy;
    const out = await turnLock.device(async (onCancel) => {
      if (run !== null) return busy;
      // Its time starts once it has the turn, not while it waited for his.
      return runOnceItsTurn(signal, timeoutMs, async (timeout) => {
        freshTurn();
        const once = outsideAgentOf(job);
        const stop = () => void once.end();
        onCancel(stop);
        timeout.addEventListener("abort", stop, { once: true });
        signal.addEventListener("abort", stop, { once: true });
        try {
          const reply = await once.say(standingTurnText(job), { window: null, session: null });
          // One model turn, and one more for each tool call it made (the turn record counts them).
          return {
            status: "ok" as const,
            text: reply,
            model: leadBrain().model,
            turns: 1 + turns.current().tools.length,
          };
        } catch (error) {
          return {
            status: timeout.aborted
              ? ("timeout" as const)
              : error instanceof SessionClosed
                ? ("cancelled" as const)
                : ("error" as const),
            text: error instanceof Error ? error.message : String(error),
          };
        } finally {
          signal.removeEventListener("abort", stop);
          await once.end();
        }
      });
    });
    return out === INTERRUPTED
      ? { status: "cancelled", text: "He started talking to Tessaya, so it stopped." }
      : out;
  };
  /** His sentence goes to his session; a device's to a fresh one of its own, ended with the turn. */
  const sayFor = (
    outside: boolean,
    onCancel?: (stop: () => void) => void,
  ): AssistantAgent["say"] =>
    outside
      ? async (text, where, onDelta) => {
          const once = outsideAgentOf();
          // He spoke: the device's session closes, and its pending answer fails with SessionClosed.
          onCancel?.(() => void once.end());
          try {
            return await once.say(text, where, onDelta);
          } finally {
            await once.end();
          }
        }
      : agentOf().say;
  /** A sentence of his, to the one assistant. Streams its first sentence as soon as it is written. */
  const agentTurn = async (
    text: string,
    started: number,
    direct: boolean,
    focusedSession: string | null,
    outside = false,
    turn: {
      readonly onEnd?: () => void;
      readonly onCancel?: (stop: () => void) => void;
      readonly cutIn?: CutIn | null;
    } = {},
  ) => {
    answering += 1;
    const speaker = face.id;
    const brain = chooseTurnBrain(text, faceModel, tierMemories.of(speaker).previous(), manual());
    const mine = turns.ask();
    const record = mine.record;
    let firstTokenAt: number | null = null;
    let firstAudioAt: number | null = null;
    const project = focusedSession === null ? null : (actions?.projectOf?.(focusedSession) ?? null);
    turnProject =
      focusedSession === null
        ? null
        : (actions?.projectRefOf?.(focusedSession) ??
          (project === null ? null : { title: project, computer: null }));
    const windowLabel = titlesAllowed() && focus !== null ? redactFocusLabel(focus.label) : null;
    /** The turn as the learning loop may see it, for "Learn from that". */
    const keepTurn = (error: unknown) => {
      // A device's turn is never his to learn from, replay or keep for the nightly pass.
      if (outside) return;
      const results = record().results;
      lastTurn = {
        trace: {
          said: text,
          app: appOf(windowLabel),
          persona: face.id,
          project,
          calls: traceCalls(results),
          stoppedBy: stoppedBy(results, error),
        },
        window: windowLabel,
        answers: { ...record().answers },
        allowed: face.tools ?? buildBatonTools(toolHost).map((t) => t.name),
        brain: brain.brain,
      };
      // Kept two days on this machine for the nightly pass, only while it is on; the trace names it by `started`.
      try {
        if (nightlyOn()) keepRecentTurn(skillsDir(), { ...lastTurn, turn: started }, Date.now());
      } catch {
        // A turn not kept is only one the nightly pass will not see.
      }
    };
    try {
      const voice = streamSpeech(() => (firstAudioAt ??= Date.now()));
      const who = {
        wake: woke,
        persona: face.name,
        voice: voiceNow(),
        model: brain.brain.model,
        effort: brain.brain.effort,
        tier: brain.tier,
        why: brain.why,
      };
      input.onNote?.("agent_turn_start", { said: text, ...who });
      // The pill says it is working; nothing is drawn over the window it may be acting in (CU-1).
      input.onActivity?.("Thinking");
      const reply = await sayFor(outside, turn.onCancel)(
        direct ? `(to the focused session) ${text}` : text,
        {
          outside,
          // The persona who was speaking is named only when he woke another one to cut in.
          ...(turn.cutIn == null
            ? {}
            : { cutIn: { ...turn.cutIn, by: turn.cutIn.by === woke ? null : turn.cutIn.by } }),
          window: windowLabel,
          session: focusedSession,
          project,
          persona: {
            id: face.id,
            name: face.name,
            role: face.role,
            ...(face.lead ||
            (turnProject !== null && leadsProject(face, turnProject, actions?.projects?.() ?? []))
              ? {}
              : { lead: leadName }),
          },
          brain: brain.brain,
        },
        (delta) => {
          firstTokenAt ??= Date.now();
          voice.feed(delta);
        },
      );
      voice.finish(reply);
      input.onActivity?.(null);
      if (runningMode() === null) voice.linger(reply);
      keepTurn(null);
      input.onNote?.("agent_turn", {
        ok: true,
        turn: started,
        ...who,
        skills: [...record().skills],
        project,
        said: text,
        reply,
        decisions: [...record().decisions],
        routes: [...record().routes],
        firstTokenMs: firstTokenAt === null ? null : firstTokenAt - started,
        // P1's measure: whether the persona's session was already warm, against first-token times.
        session: outside ? null : agentOf().lastStart(),
        personaId: speaker,
        firstAudioMs: firstAudioAt === null ? null : firstAudioAt - started,
        totalMs: Date.now() - started,
        tools: [...record().tools],
        toolResults: [...record().results],
        route: "agent",
      });
    } catch (error) {
      keepTurn(error);
      // Every turn leaves its line, a failed one too, with what the tools did before it stopped.
      input.onNote?.("agent_turn", {
        ok: false,
        turn: started,
        skills: [...record().skills],
        stoppedBy: lastTurn?.trace.stoppedBy ?? null,
        wake: woke,
        persona: face.name,
        voice: voiceNow(),
        model: brain.brain.model,
        effort: brain.brain.effort,
        tier: brain.tier,
        said: text,
        error: error instanceof Error ? error.message : String(error),
        totalMs: Date.now() - started,
        tools: [...record().tools],
        toolResults: [...record().results],
        decisions: [...record().decisions],
        routes: [...record().routes],
        route: "agent",
      });
      // A device's turn failing never speaks over him or ends his lesson, drive or look.
      if (!outside) fail(error);
    } finally {
      tierMemories.of(speaker).settled(brain.tier, outside);
      answering -= 1;
      mine.done();
      turn.onEnd?.();
      input.onTurnEnd?.();
    }
  };

  const saidNow = async (
    text: string,
    {
      direct,
      typed = false,
      session = null,
      wake = null,
      outside = false,
      cutIn = null,
    }: Parameters<ScreenCompanion["said"]>[1],
    turn: {
      readonly onEnd?: () => void;
      readonly onCancel?: (stop: () => void) => void;
      readonly handed?: { done: boolean };
    } = {},
  ): ReturnType<ScreenCompanion["said"]> => {
    const started = Date.now();
    voiceTurn = !typed;
    woke = wake;
    const pack = readPack(NodePath.join(input.stateDir, PACK_FOLDER));
    face = personaFor(pack.personas, { wake, text: outside ? "" : text });
    // A device's turn never changes whose conversation he is in.
    if (!outside) conversations.setCurrent(face.id);
    leadName = pack.personas.find((p) => p.lead)?.name ?? leadName;
    faceModel = modelOf(pack, face.id);
    // The wake named one persona and the words another ("Tessaya, ask Alfred…"): his tiers, before the turn runs.
    if (!outside && warmedFor !== null && face.id !== warmedFor) warmTiers(face);
    // VAULT.md section 1: a secret never reaches a prompt, the conversation file, memory or the turn log.
    const secret = redactForHistory(text, null).secret;
    // A device's words are never held for his vault or offered to it.
    if (secret !== null && outside)
      return {
        kind: "refused",
        reply: `That looked like ${secret}. A paired device's request never carries one, so nothing was done.`,
      };
    if (secret !== null) {
      pendingSecret.set(text, started);
      const offer = `That looked like ${secret}, so I kept it out of our conversation. Say "put that in the vault" to keep it safely.`;
      say(offer);
      linger("Tessaya", offer);
      input.onNote?.("secret_held", { kind: secret });
      return { kind: "handled" };
    }
    // "Use Opus", "think harder", "go faster", "back to normal": a choice, not a question for the model.
    const choice = modelCommand(text, manual(), outside);
    if (choice !== null) {
      const label = chooseModel(choice);
      const reply =
        label === "Automatic"
          ? "Back to normal: I'll pick the model for each question."
          : `${label} from now on, until you say back to normal.`;
      say(reply);
      linger("Tessaya", reply);
      return { kind: "handled" };
    }
    // A stop never waits on the sidecar, and needs no window.
    const busy = runningMode() !== null || answering > 0 || speech.busy();
    if (instantDecision(text, busy)?.route !== "control") {
      // His own spoken turn from a wake: the window he had then. Typed, phone and outside turns read it now.
      const atWake = typed || outside ? null : await actions?.wakeFocus?.().catch(() => null);
      focus = askFocus ?? atWake ?? (await focusSoon());
    }
    askFocus = null;
    // Stop and its kin never wait on a model; everything else goes to the one assistant.
    // His own "teach:", "drive:" and "look:" prefixes name the mode: they are not for the assistant's judgement.
    // A device's words always go to the assistant, whose gate asks; they never pick a mode or a control.
    const instant = outside ? null : instantDecision(text, busy);
    if (instant === null) {
      if (outside) await agentTurn(text, started, direct, session, true, turn);
      else {
        if (turn.handed !== undefined) turn.handed.done = true;
        void agentTurn(text, started, direct, session, false, { ...turn, cutIn });
      }
      return { kind: "handled" };
    }
    const decision = guardDecision(instant, text);
    const decidedAt = Date.now();
    input.onTrace?.({
      said: text,
      focused: focus?.label ?? null,
      decision,
      recent: conversation.recent().length,
    });
    if (decision.route === "refused") {
      conversation.add({ route: "refusal", said: text, reply: decision.text, note: "guard" });
      input.onNote?.("refusal", { kind: "guard", reason: decision.text, said: text });
      return { kind: "refused", reply: decision.text };
    }
    perform(decision, started, decidedAt);
    return { kind: "handled" };
  };

  /** A paired device's words, in its place in the lock; `capture` collects what it says for the phone's card. */
  const deviceTurn = async (
    text: string,
    options: Parameters<ScreenCompanion["said"]>[1],
    capture?: { readonly spoken: string[]; card: string | null },
  ): ReturnType<ScreenCompanion["said"]> => {
    // A lesson, a drive or a look is his until it ends; `run` covers all three.
    if (run !== null) return { kind: "refused", reply: DEVICE_BUSY };
    const out = await turnLock.device(async (onCancel) => {
      if (run !== null) return { kind: "refused" as const, reply: DEVICE_BUSY };
      freshTurn();
      if (capture !== undefined) {
        phoneCapture = capture;
        phoneTurn = true;
      }
      try {
        return await saidNow(text, { ...options, outside: true }, { onCancel });
      } finally {
        if (capture !== undefined) {
          phoneCapture = null;
          phoneTurn = false;
        }
      }
    });
    return out === INTERRUPTED ? { kind: "refused", reply: DEVICE_INTERRUPTED } : out;
  };
  /** His words: a device turn that is running stops first, and none starts until his turn is over. */
  const said: ScreenCompanion["said"] = async (text, options) => {
    if (options.outside === true) return deviceTurn(text, options);
    const end = await turnLock.his();
    const handed = { done: false };
    try {
      return await saidNow(text, options, { onEnd: end, handed });
    } finally {
      if (!handed.done) end();
    }
  };

  /** Typed asks: the same decision, with the card and the voice standing in for the voice side. */
  const typed = async (text: string) => {
    const result = await said(text, { direct: false, typed: true });
    if (result.kind === "handled") return;
    say(result.reply);
    linger("Tessaya", result.reply);
  };

  const askFromPhone = async (text: string, source: "phone" | "device") => {
    const mine: { spoken: string[]; card: string | null } = { spoken: [], card: null };
    if (source === "device") {
      rememberOutside(outsideSaid, text);
      // The whole turn runs before the card is read: it may wait for his turn, and he may interrupt it.
      const result = await deviceTurn(text, { direct: false, typed: true }, mine);
      if (result.kind !== "handled") return { spoken: result.reply, card: result.reply };
      const spoken = mine.spoken.join(" ").trim();
      return {
        spoken,
        card: mine.card ?? (spoken === "" ? "Done. There was nothing to say." : spoken),
      };
    }
    phoneCapture = mine;
    phoneTurn = true;
    try {
      await typed(text);
      for (let step = 0; step < PHONE_SETTLE_STEPS && mine.card === null; step += 1)
        await sleep(500);
    } finally {
      phoneCapture = null;
      phoneTurn = false;
    }
    const spoken = mine.spoken.join(" ").trim();
    return {
      spoken,
      card: mine.card ?? (spoken === "" ? "Done. There was nothing to say." : spoken),
    };
  };

  const windows = createCompanionWindows({
    output: () => settings.output,
    setOutput: (output) => save({ output }),
    onAsk: (text) => void typed(text).catch(fail),
  });

  // Taken first: once the box is up, it is the focused window.
  let askFocus: AssistantFocus | null = null;
  const openAskBox = () => {
    void focusSoon().then((window) => {
      askFocus = window;
      windows.openAsk();
    });
  };

  let askKey: string | null = ASK_HOTKEY;
  Electron.globalShortcut.register(ASK_HOTKEY, openAskBox);

  const stop = () => perform({ route: "control", control: "stop", source: "instant" }, 0, 0);
  /** "Learn from that": a skill from the last turn, tested by replaying it, shown for his yes. */
  const learnFromLast = async () => {
    const turn = lastTurn;
    if (turn === null || learning !== null) return;
    const progress = (line: string) => {
      learning = line;
      input.onChange?.();
    };
    // Learning's model turns are counted in the turn log, never limited.
    let replays = 0;
    try {
      const lead = leadBrain();
      const reply = await learnFromTurn({
        dir: skillsDir(),
        turn,
        // The writer is judgment work: the lead's model. It sees only his words and code-written fields.
        ask: createModelAsk({
          claudeBinary: () => settings.claudeBinary,
          model: () => lead.model,
          workDir: NodePath.join(input.stateDir, "edit"),
          env: claudeEnv,
          platform: input.platform,
          timeoutMs: 90_000,
        }),
        // Tested on the model that will use it, with every call refused except the recorded answers.
        replay: async (c, extra) => {
          replays += 1;
          const replayed = await replayTurn({
            claudeBinary: settings.claudeBinary,
            brain: turn.brain,
            said: c.said,
            where: { window: c.window, session: null },
            answers: c.answers,
            ...(extra === undefined ? {} : { extra }),
            env: claudeEnv(),
            platform: input.platform,
          });
          return replayed.calls;
        },
        now: new Date(),
        progress,
      });
      linger("Tessaya", reply);
      input.onNote?.("learned", { said: turn.trace.said, reply, replays, model: turn.brain.model });
    } catch (error) {
      linger(
        "Tessaya",
        `I could not learn from that: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      learning = null;
      input.onChange?.();
    }
  };
  /** The lead's standing job: replays use each turn's own model, the writer the lead's; nothing is adopted. */
  const learnNightly: ScreenCompanion["learnNightly"] = async (rows) => {
    const lead = leadBrain();
    const out = await learnNightlyFrom({
      dir: skillsDir(),
      traced: tracedTurns(rows),
      ask: createModelAsk({
        claudeBinary: () => settings.claudeBinary,
        model: () => lead.model,
        workDir: NodePath.join(input.stateDir, "edit"),
        env: claudeEnv,
        platform: input.platform,
        timeoutMs: 90_000,
      }),
      replay: (brain) => async (c, extra) =>
        (
          await replayTurn({
            claudeBinary: settings.claudeBinary,
            brain,
            said: c.said,
            where: { window: c.window, session: null },
            answers: c.answers,
            ...(extra === undefined ? {} : { extra }),
            env: claudeEnv(),
            platform: input.platform,
          })
        ).calls,
      now: new Date(),
    });
    input.onNote?.("learned", {
      said: "nightly",
      reply: out.text,
      replays: out.replays,
      model: lead.model,
    });
    input.onChange?.();
    return out.text;
  };
  const dismissQuietly = () => {
    hush();
    dropOperator();
    if (run !== null && run.mode !== "look") end();
    void wipe();
  };

  return {
    said,
    runStanding,
    setTransformHotkeys,
    memorySync,
    setActions: (next) => {
      actions = next;
      stopMemorySync ??= memorySync.start();
    },
    active: () => runningMode() !== null,
    hush,
    cutIn: () => {
      if (answering > 0) cutIns.cut();
      hush();
    },
    dismiss,
    addressed: (wake) => {
      face = personaFor(readPack(NodePath.join(input.stateDir, PACK_FOLDER)).personas, {
        wake,
        text: "",
      });
      conversations.setCurrent(face.id);
    },
    warm: (wake) => {
      // First run: a Chrome that is already connected turns this on, once; otherwise it stays off and asks again next time.
      if (!settings.browserChromeSet) {
        void refreshChrome().then((check) => {
          if (check.state !== "ready" || settings.browserChromeSet) return;
          dropOperator();
          save({ browserChrome: true, browserChromeSet: true });
          linger(
            "Tessaya",
            "Chrome is connected, so the assistant can use it. Turn it off under Assistant if you would rather not.",
          );
        });
      }
      warmTiers(
        wake == null
          ? face
          : personaFor(readPack(NodePath.join(input.stateDir, PACK_FOLDER)).personas, {
              wake,
              text: "",
            }),
        wake != null,
      );
      if (run?.mode !== "look" && spareLook?.alive() !== true) {
        spareLook?.dispose();
        spareLook = visionFor("look");
      }
    },
    warmAssistant: () => {
      if (!disposed) warmTiers();
    },
    openAskBox,
    askAbout: (text) => {
      rememberOutside(outsideSaid, text);
      void typed(text).catch(fail);
    },
    askFromPhone,
    stateForServer: () => ({
      screen: settings,
      personas: readPack(NodePath.join(input.stateDir, PACK_FOLDER)).personas,
      skills: readSkills(skillsDir()),
      brain: `${faceModel.model} (${faceModel.effort})`,
      voiceEngine: settings.output === "written" ? "written only" : "on this computer",
      errors: recentErrors,
    }),
    setPhoneMirror: (mirror) => {
      phoneMirror = mirror;
    },
    notice: (text) => {
      if (text.trim().length > 0) linger("Tessaya", text);
    },
    announce: (text, speak, spoken) => {
      if (text.trim().length === 0) return;
      if (speak) say(spoken ?? text);
      linger("Tessaya", text);
    },
    writtenOnly: () => settings.output === "written",
    remoteHands: {
      enabled: () => settings.remoteHands,
      run: async (call) => {
        if (!settings.remoteHands)
          return { ok: false, error: "Remote hands are off on this computer." };
        remoteTaint.reset();
        remoteMouse.reset();
        remoteActivity(call.tool);
        try {
          const tool = remoteToolsOf().get(call.tool);
          if (tool === undefined)
            return { ok: false, error: `${call.tool} is not a remote hands tool.` };
          // A picture or the controls of a window follow his screen setting while he is here; "I'm away" is his yes.
          if (
            (call.tool === "window_capture" || call.tool === "ui_tree") &&
            !settings.remoteHandsAway &&
            !(await approveCapture(`a remote session wants to see a window (${call.tool})`, null))
          ) {
            return { ok: false, error: "Refused: he did not allow looking at his screen." };
          }
          const verdict = await remoteGate({
            tool: `${BATON_TOOL_PREFIX}${call.tool}`,
            input: call.args,
          }).catch(() => ({ allow: false as const, reason: "Tessaya could not check that." }));
          if (!verdict.allow) return { ok: false, error: `Refused: ${verdict.reason}` };
          const out = await tool.run(call.args);
          return {
            ok: true,
            ...(out.text === undefined ? {} : { text: vaultHost?.scrub(out.text) ?? out.text }),
            ...(out.images === undefined ? {} : { images: out.images }),
          };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        } finally {
          remoteActivity(null);
        }
      },
    },
    voice: voiceNow,
    volume: () => settings.volume,
    ask: windows.ask,
    askMirrored: (box, needs) =>
      askHandsFree({ inactive: false, ...box }, box.title, 0, false, needs),
    stop,
    dismissQuietly,
    learnNightly,
    menuItems: () => [
      { label: "Ask Tessaya…", accelerator: ASK_HOTKEY, click: openAskBox },
      { label: "Clear the screen", click: dismiss },
      {
        label: `Model: ${manualLabel(manual())}`,
        submenu: [
          ...(["auto", "haiku", "sonnet", "opus"] as const).map((model) => ({
            label: model === "auto" ? "Automatic" : model.charAt(0).toUpperCase() + model.slice(1),
            type: "radio" as const,
            checked: settings.assistantModel === model,
            click: () => void chooseModel({ ...manual(), model: model === "auto" ? null : model }),
          })),
          { type: "separator" as const },
          ...(["auto", "low", "medium", "high"] as const).map((effort) => ({
            label:
              effort === "auto"
                ? "Automatic effort"
                : `${effort.charAt(0).toUpperCase()}${effort.slice(1)} effort`,
            type: "radio" as const,
            checked: settings.assistantEffort === effort,
            click: () =>
              void chooseModel({ ...manual(), effort: effort === "auto" ? null : effort }),
          })),
        ],
      },
      ...(run !== null && run.mode !== "look"
        ? [
            {
              label: run.mode === "teach" ? "Stop the lesson" : "Stop driving",
              click: stop,
            },
          ]
        : []),
    ],
    controls: () => [
      ...stepMark("home-state:screen-learned"),
      ...learnedControls(skillsDir(), {
        lastTurn: lastTurn?.trace.said ?? null,
        busy: learning,
        now: new Date(),
      }),
      ...stepMark("home-state:screen-settings"),
      {
        id: "s.assistantModel",
        section: "Answers and voice",
        label: "Model for conversation",
        hint: `Now: ${manualLabel(manual())}. Automatic picks per question: Haiku for quick ones, Sonnet by default, the persona's model for planning. Or say "use Opus", "think harder", "go faster", "back to normal".`,
        kind: "choice",
        value: settings.assistantModel,
        options: [
          { value: "auto", label: "Automatic" },
          { value: "haiku", label: "Haiku" },
          { value: "sonnet", label: "Sonnet" },
          { value: "opus", label: "Opus" },
        ],
      },
      {
        id: "s.assistantEffort",
        section: "Answers and voice",
        label: "Thinking effort",
        kind: "choice",
        value: settings.assistantEffort,
        options: [
          { value: "auto", label: "Automatic" },
          { value: "low", label: "Low" },
          { value: "medium", label: "Medium" },
          { value: "high", label: "High" },
        ],
      },
      {
        id: "s.output",
        section: "Answers and voice",
        label: "How Tessaya answers",
        kind: "choice",
        value: settings.output,
        options: [
          { value: "spoken", label: "Spoken and written" },
          { value: "written", label: "Written only" },
        ],
      },
      {
        id: "s.volume",
        section: "Answers and voice",
        label: "Speaking volume",
        hint: "How loud Tessaya speaks, apart from your system volume.",
        kind: "choice",
        value: String(settings.volume),
        options: [
          { value: "0.4", label: "Quiet" },
          { value: "0.7", label: "Medium" },
          { value: "1", label: "Full" },
        ],
      },
      {
        id: "s.voice",
        section: "Personas",
        label: "Voices",
        hint: "Tessaya's voices: each persona speaks in the voice chosen beside it below. Quick is one smaller voice for all, less natural. System uses your computer's voice.",
        kind: "choice",
        value: settings.voice,
        options: [
          {
            value:
              settings.voice === "quick" || settings.voice === "system" ? "anna" : settings.voice,
            label: "Tessaya's voices",
          },
          { value: "quick", label: "Quick" },
          { value: "system", label: "System voice" },
        ],
      },
      {
        id: "s.brain",
        section: settings.brainChosen ? "Working for you" : "Choose what Tessaya works through",
        label: "Works through",
        ...(settings.brainChosen ? {} : { hint: "Listening and speaking stay on this computer." }),
        kind: "brain",
        value: settings.operator,
        options: brainRows(brains ?? UNKNOWN_BRAINS),
        // A ready default needs no first-run card on Home; the Assistant page is the one place to change it.
        lead:
          !settings.brainChosen &&
          !brainRows(brains ?? UNKNOWN_BRAINS).some(
            (r) => r.value === settings.operator && r.state === "ready",
          ),
      },
      {
        id: "s.brainCheck",
        section: settings.brainChosen ? "Working for you" : "Choose what Tessaya works through",
        label: "Installed and signed in?",
        kind: "action",
        button: "Check again",
        more: settings.brainChosen,
      },
      {
        id: "s.chrome",
        section: "Working for you",
        label: "Use my Chrome",
        hint: "Lets the assistant read and use pages in your own Chrome through Claude in Chrome. Reading is routine; a submit, send, purchase, delete or settings change asks aloud, and moving money is refused. Not yet tried on this computer.",
        kind: "toggle",
        on: settings.browserChrome,
      },
      {
        id: "s.chromeCheck",
        section: "Working for you",
        label: "Chrome",
        kind: "check",
        status: chromeStatus().state === "ready" ? "ok" : "warn",
        detail: chromeStatus().message,
        ...(chromeStatus().state === "ready" ? {} : { fix: "Check again" }),
      },
      {
        id: "s.social",
        section: "Working for you",
        label: "Allow social accounts in Chrome",
        hint: "Applies once Use my Chrome is on. Reading is routine; every post, comment, like, follow, message, share, delete or profile change asks aloud and shows what it would send, ten at most an hour, each logged in social-actions.ndjson. Off, social sites are refused.",
        kind: "toggle",
        on: settings.socialOn,
      },
      {
        id: "s.act",
        section: "Working for you",
        label: "Act without asking",
        hint: "Routine steps run on their own. Anything that deletes, sends, pays or publishes still asks.",
        kind: "toggle",
        on: settings.actWithoutAsking,
      },
      {
        id: "s.cursor",
        section: "Working for you",
        label: "Show my cursor while I work",
        hint: "When I click or type for you, my own small cursor glides to the spot with a word or two, then fades. Your mouse never moves.",
        kind: "toggle",
        on: settings.actCursor,
      },
      {
        id: "s.hands",
        section: "Working for you",
        label: "Let a remote session drive this computer",
        hint: "A session you gave remote hands (baton:hands) can read windows, press named controls and take pictures of windows, through this app and the same checks as the assistant. Off, none of it is listened for.",
        kind: "toggle",
        on: settings.remoteHands,
      },
      {
        id: "s.handsAway",
        section: "Working for you",
        label: "I'm away: remote hands never ask me",
        hint: "With this on, anything a remote call would ask you about is refused instead, because nobody can answer.",
        kind: "toggle",
        on: settings.remoteHandsAway,
      },
      {
        id: "s.account",
        section: "Working for you",
        label: "Claude login for Tessaya",
        hint: "Which login Tessaya's assistant runs as. By default it follows the claude login.",
        kind: "choice",
        value: settings.assistantAccount ?? "",
        options: [
          { value: "", label: "Follow the claude login" },
          ...(accounts.cached() ?? []).map((a) => ({
            value: a.key,
            label: `${accountLabel(a)}${a.loggedIn ? "" : " (signed out)"}`,
          })),
        ],
        more: true,
      },
      ...(accounts.cached()?.find((a) => a.key === settings.assistantAccount)?.email == null
        ? []
        : [
            {
              id: "s.accountEmail",
              section: "Working for you",
              label: "Address",
              kind: "secret" as const,
              masked: maskEmail(
                accounts.cached()!.find((a) => a.key === settings.assistantAccount)!.email!,
              ),
              revealed: accounts.cached()!.find((a) => a.key === settings.assistantAccount)!.email!,
              more: true,
            },
          ]),
      {
        id: "s.capture",
        section: "Working for you",
        label: "Always allow screen capture",
        hint: "Off, Tessaya asks before it looks at your screen.",
        kind: "toggle",
        on: settings.captureApproval === "always",
      },
    ],
    needsBrainChoice: () => !settings.brainChosen,
    setAskHotkey: (accelerator) => {
      if (accelerator === askKey) return;
      if (askKey !== null) Electron.globalShortcut.unregister(askKey);
      askKey = null;
      // A chord another app already owns is skipped, not fatal.
      if (accelerator !== null && Electron.globalShortcut.register(accelerator, openAskBox)) {
        askKey = accelerator;
      }
    },
    signIn: async () => {
      await checkBrains();
      return brains ?? UNKNOWN_BRAINS;
    },
    applySetting: (id, value) => {
      if (
        id === "s.assistantModel" &&
        (value === "auto" || value === "haiku" || value === "sonnet" || value === "opus")
      ) {
        chooseModel({ ...manual(), model: value === "auto" ? null : value });
        return;
      }
      if (
        id === "s.assistantEffort" &&
        (value === "auto" || value === "low" || value === "medium" || value === "high")
      ) {
        chooseModel({ ...manual(), effort: value === "auto" ? null : value });
        return;
      }
      if (id === "s.output" && (value === "spoken" || value === "written")) {
        if (value === "written") hush();
        save({ output: value });
      } else if (id === "s.volume" && typeof value === "string") {
        const volume = Number.parseFloat(value);
        if (Number.isFinite(volume)) save({ volume: Math.min(1, Math.max(0.1, volume)) });
      } else if (id === "s.voice" && typeof value === "string") {
        save({ voice: value as PocketVoice });
      } else if (id === "s.brain" && typeof value === "string") {
        if (brains !== null && canChoose(brains, value)) {
          dropOperator();
          save({ operator: value, brainChosen: true });
        }
      } else if (id === "s.brainCheck") {
        void checkBrains();
      } else if (id === "s.account" && typeof value === "string") {
        dropOperator();
        dropSpare();
        toldAbout = null;
        save({ assistantAccount: value === "" ? null : value });
        void accounts.refresh();
      } else if (id === "s.chromeCheck") {
        void refreshChrome();
      } else if (id === "s.chrome") {
        dropOperator();
        save({ browserChrome: value === true, browserChromeSet: true });
        if (value === true) {
          void refreshChrome().then((check) => {
            if (check.state !== "ready") linger("Tessaya", check.message);
          });
        }
      } else if (id === "s.social") save({ socialOn: value === true });
      else if (id === "s.act") save({ actWithoutAsking: value === true });
      else if (id === "s.hands") save({ remoteHands: value === true });
      else if (id === "s.cursor") save({ actCursor: value === true });
      else if (id === "s.handsAway") save({ remoteHandsAway: value === true });
      else if (id === "s.capture") save({ captureApproval: value === true ? "always" : "ask" });
      else if (id === "s.learn") void learnFromLast();
      else if (learnedAction(id) !== null) {
        const act = learnedAction(id)!;
        const accepted = readStates(skillsDir())[act.slug]?.state === "accepted";
        decideSkill(
          skillsDir(),
          act.slug,
          act.secondary ? "reject" : accepted ? "forget" : "accept",
          new Date(),
        );
        input.onChange?.();
      }
    },
    dispose: () => {
      disposed = true;
      stopMemorySync?.();
      agent?.dispose();
      for (const mcp of agentMcps) void mcp.close();
      agentMcps.clear();
      for (const server of outsideServers) void server.close();
      end();
      dropSpare();
      if (askKey !== null) Electron.globalShortcut.unregister(askKey);
      windows.dispose();
      driver?.dispose();
      overlay.dispose();
    },
  };
};
