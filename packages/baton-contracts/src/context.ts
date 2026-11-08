/* oxlint-disable t3code/no-low-value-comments -- Baton file predating upstream's rule (D82) */
/**
 * Where the user is, and what can be typed into.
 *
 * §15's desktop context bus, §16's VS Code report, §17's browser report and
 * §18's injection abstraction share one shape, because they answer one
 * question: **which target does this sentence belong to?** §14's ladder is only
 * as good as the facts under it, and every rung above "the user said so" is a
 * fact some producer has to report.
 *
 * Two rules constrain this contract, and both are privacy rules rather than
 * engineering ones:
 *
 *   1. **This is client-local.** §15 says a local authenticated IPC interface,
 *      not a public network API, and nothing here crosses the environment
 *      boundary. The environment learns the *resolved target* — a work session
 *      id — and never the window titles, page origins or field contents that
 *      produced it.
 *   2. **No page content.** §17 is explicit: the browser reports whether the
 *      focused element is editable, what kind of field it is, and where the tab
 *      is — never the text around it. A field label is optional and exists for
 *      the read-back ("insert into Gmail's compose box"), not for context.
 *
 * @module baton/context
 */
import * as Schema from "effect/Schema";

import { IsoDateTime, ThreadId, TrimmedNonEmptyString, TrimmedString } from "@t3tools/contracts";
import { WorkSessionId } from "./workSession.ts";
import type { BATON_PHONE_OPS } from "./phone.ts";

/**
 * Who reported a snapshot. §15's producer list, and the reason the bus keeps
 * one slot per producer rather than one global snapshot: VS Code going quiet
 * must not erase what the browser just said.
 */
export const BatonContextProducer = Schema.Literals([
  /** The Baton client itself: which work session the user is looking at. */
  // Legacy name (D71): producers already publish as "fabric".
  "fabric",
  /** The desktop shell: foreground application and window title, where the OS allows. */
  "desktop",
  "vscode",
  "browser",
  /** The voice conversation manager: the target inherited between utterances. */
  "voice",
]);
export type BatonContextProducer = typeof BatonContextProducer.Type;

export const BatonFocusTargetKind = Schema.Literals(["editable", "editor", "terminal", "unknown"]);
export type BatonFocusTargetKind = typeof BatonFocusTargetKind.Type;

/**
 * Somewhere text could go. Deliberately thin: what it is, who owns it, whether
 * it will accept text right now, and enough to name it out loud.
 */
export const BatonFocusTarget = Schema.Struct({
  producer: BatonContextProducer,
  kind: BatonFocusTargetKind,
  /** "Gmail compose", "the editor", "the terminal" — for the read-back. */
  label: TrimmedNonEmptyString,
  /** The producer's own answer to "can I insert here, now?". */
  injectable: Schema.Boolean,
  /**
   * Origin for a browser target, so a dictation refusal can name the site.
   * Never a URL with a path, and never page content.
   */
  origin: Schema.NullOr(TrimmedNonEmptyString),
});
export type BatonFocusTarget = typeof BatonFocusTarget.Type;

/** §16: what the extension observes. Nothing here is a provider bypass. */
export const BatonVsCodeContext = Schema.Struct({
  workspaceFolder: Schema.NullOr(TrimmedNonEmptyString),
  /** `ssh-remote`, `wsl`, `dev-container`; null when the window is local. */
  remoteAuthority: Schema.NullOr(TrimmedNonEmptyString),
  repositoryRoot: Schema.NullOr(TrimmedNonEmptyString),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  /** The file on screen. A path, never its contents. */
  visibleFile: Schema.NullOr(TrimmedNonEmptyString),
  hasSelection: Schema.Boolean,
  activeTerminalName: Schema.NullOr(TrimmedNonEmptyString),
  /** The work session this window is already linked to, when it is. */
  workSessionId: Schema.NullOr(WorkSessionId),
});
export type BatonVsCodeContext = typeof BatonVsCodeContext.Type;

/** §17: focus and editability, and nothing that would be surveillance. */
export const BatonBrowserContext = Schema.Struct({
  /** Which browser profile, so two accounts are distinguishable. */
  profile: Schema.NullOr(TrimmedNonEmptyString),
  /** Origin only: `https://mail.google.com`, never the path or the query. */
  origin: Schema.NullOr(TrimmedNonEmptyString),
  pageTitle: Schema.NullOr(TrimmedNonEmptyString),
  activeElementEditable: Schema.Boolean,
  /** `textarea`, `contenteditable`, `input:text`; null when nothing is focused. */
  fieldType: Schema.NullOr(TrimmedNonEmptyString),
  hasSelection: Schema.Boolean,
  /**
   * The field's own label, when the extension has been given permission to
   * read it. Optional by design — §17 requires explicit capability before any
   * surrounding text is exposed, and this is the smallest useful case.
   */
  fieldLabel: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
});
export type BatonBrowserContext = typeof BatonBrowserContext.Type;

/** §15's snapshot, from one producer, at one instant. */
export const BatonContextSnapshot = Schema.Struct({
  producer: BatonContextProducer,
  observedAt: IsoDateTime,
  foregroundApplication: Schema.NullOr(TrimmedNonEmptyString),
  activeWindowTitle: Schema.NullOr(TrimmedNonEmptyString),
  activeWorkSessionId: Schema.NullOr(WorkSessionId),
  activeThreadId: Schema.NullOr(ThreadId),
  vscode: Schema.NullOr(BatonVsCodeContext),
  browser: Schema.NullOr(BatonBrowserContext),
  editableTarget: Schema.NullOr(BatonFocusTarget),
  recentVoiceTarget: Schema.NullOr(WorkSessionId),
});
export type BatonContextSnapshot = typeof BatonContextSnapshot.Type;

/**
 * How long a producer's snapshot stays authoritative.
 *
 * A context bus whose facts never expire is worse than none: VS Code closed
 * ten minutes ago is not where the user is now, and routing a message there
 * because nothing newer arrived is the failure §14 exists to prevent. Thirty
 * seconds is long enough for a producer that only reports on change and short
 * enough that a dead producer stops voting.
 */
export const CONTEXT_SNAPSHOT_TTL_MS = 30_000;

// ---------------------------------------------------------------------------
// §18 — text injection, reported honestly
// ---------------------------------------------------------------------------

/**
 * §18's preference order, most preferred first. The order is the contract:
 * an application that knows how to insert text does it properly, and simulated
 * keystrokes are what you reach for when everything else has failed.
 */
export const BatonInjectionMethod = Schema.Literals([
  "application",
  "accessibility",
  "clipboard",
  "keystrokes",
]);
export type BatonInjectionMethod = typeof BatonInjectionMethod.Type;

export const BATON_INJECTION_PREFERENCE: ReadonlyArray<BatonInjectionMethod> = [
  "application",
  "accessibility",
  "clipboard",
  "keystrokes",
];

export const BatonInjectionCapability = Schema.Struct({
  method: BatonInjectionMethod,
  available: Schema.Boolean,
  /**
   * Why not, in words the user can act on: a permission to grant, a display
   * server that forbids it, a host that is not connected. Never empty when
   * `available` is false — §18's "surface capability must be reported
   * honestly" is only met if the refusal says something.
   */
  reason: TrimmedString,
});
export type BatonInjectionCapability = typeof BatonInjectionCapability.Type;

export const BatonDisplayServer = Schema.Literals(["wayland", "x11", "unknown"]);
export type BatonDisplayServer = typeof BatonDisplayServer.Type;

export const BatonPlatform = Schema.Literals(["darwin", "win32", "linux", "unknown"]);
export type BatonPlatform = typeof BatonPlatform.Type;

export const BatonInjectionReport = Schema.Struct({
  platform: BatonPlatform,
  /** Linux only. Wayland restricts global injection; X11 does not. */
  displayServer: Schema.NullOr(BatonDisplayServer),
  capabilities: Schema.Array(BatonInjectionCapability),
});
export type BatonInjectionReport = typeof BatonInjectionReport.Type;

/** True when at least one method can actually put text somewhere. */
export const canInjectAnywhere = (report: BatonInjectionReport): boolean =>
  report.capabilities.some((capability) => capability.available);

/**
 * The one-line answer to "can you type for me?", written to be spoken.
 *
 * Never "no": always which method is missing and why, because a user told only
 * "no" will try again, and a user told "Wayland does not allow it" will stop.
 */
export const describeInjection = (report: BatonInjectionReport): string => {
  const available = report.capabilities.filter((capability) => capability.available);
  if (available.length > 0) {
    return `I can type into the focused field here (${available[0]?.method}).`;
  }
  const first = report.capabilities.find((capability) => capability.reason.length > 0);
  return first === undefined
    ? "I cannot type into anything from here."
    : `I cannot type into anything from here: ${first.reason}`;
};

/** One account's limits as T3 reports them, for the Usage tab. */
export interface BatonUsageSummary {
  readonly account: string;
  /** The machines it is on, in plain words: "laptop + build-server". */
  readonly box: string;
  /** The same machines as a list, for a page that lists them itself. */
  readonly boxes?: ReadonlyArray<string>;
  readonly windows: ReadonlyArray<{
    readonly label: string;
    /** null: this account reports no such window. */
    readonly usedPercent: number | null;
    readonly resetsAt: string | null;
  }>;
}

export type BatonSessionRequest =
  | { readonly kind: "open"; readonly environmentId: string; readonly threadId: string }
  /** The thread list with only live sessions shown (its Live only filter on), from the Sessions tab. */
  | { readonly kind: "showLive" }
  /** The session catalog across every connected environment; the answer's detail is JSON (see baton/sessions/catalogBridge). */
  | { readonly kind: "catalogList"; readonly query: string; readonly background?: boolean }
  | { readonly kind: "catalogCleanup"; readonly apply: boolean }
  | { readonly kind: "catalogStop"; readonly environmentId: string; readonly sessionId: string }
  | { readonly kind: "catalogAutoResume"; readonly action: "status" | "on" | "off" }
  | {
      readonly kind: "catalogReattach";
      readonly environmentId: string;
      readonly sessionId: string;
      readonly cwd: string | null;
      readonly confirmPane?: string;
    }
  | {
      readonly kind: "catalogResume";
      readonly environmentId: string;
      readonly sessionId: string;
      readonly cwd: string | null;
    }
  | {
      readonly kind: "catalogCreate";
      readonly environmentId: string;
      readonly cwd: string;
      readonly model?: string;
      readonly effort?: string;
      readonly message?: string;
    }
  | { readonly kind: "catalogFolders"; readonly environmentId: string }
  | {
      readonly kind: "catalogWaiting";
      readonly environmentId: string;
      readonly sessionId: string;
      readonly discard?: { readonly index: number; readonly text: string };
    }
  | {
      readonly kind: "send";
      readonly environmentId: string;
      readonly pane: string;
      readonly text: string;
    };

/**
 * Baton's desktop bridge, `window.batonDesktopBridge`, beside upstream's `desktopBridge` rather
 * than patched into it or into `@t3tools/contracts`. Every member is optional: a desktop build without
 * Baton voice simply lacks them.
 */
export interface BatonDesktopBridge {
  /** What this machine can type into, for §18's "capability must be reported honestly". */
  readonly getBatonInjectionReport?: (request: {
    readonly applicationIntegrationConnected: boolean;
    readonly keystrokeSimulationAllowed: boolean;
  }) => Promise<BatonInjectionReport>;
  /**
   * The desktop voice core's intent calls (`@t3tools/baton-voice` router), answered with this
   * window's own `fabric.intent.resolve` / `run`, so spoken sentences meet the same grammar and
   * server gates as typed ones. Dictation never arrives here: the desktop pastes it itself.
   */
  readonly onBatonVoiceRequest?: (
    handler: (
      request:
        | {
            readonly kind: "resolve";
            readonly text: string;
            readonly focusedWorkSessionId: string | null;
            readonly allowModel: boolean;
          }
        | {
            readonly kind: "run";
            readonly text: string;
            readonly focusedWorkSessionId: string | null;
          }
        | BatonJobBridgeRequest
        | BatonMemoryBridgeRequest
        | BatonCommitmentBridgeRequest
        | BatonWeaveBridgeRequest
        | BatonCloudBridgeRequest
        | BatonPhoneBridgeRequest,
    ) => Promise<unknown>,
  ) => () => void;
  /** The accounts' limits, pushed when they change, for Baton's own window. */
  readonly setBatonUsage?: (usage: ReadonlyArray<BatonUsageSummary>) => void;
  /** Open a thread or send to a session on behalf of Baton's window; the answer is the result. */
  readonly onBatonSessionRequest?: (
    handler: (
      request: BatonSessionRequest,
    ) => Promise<{ readonly ok: boolean; readonly detail: string }>,
  ) => () => void;
  /** §14 rung 3 for the voice core: the work session on screen, or null. */
  readonly setBatonVoiceFocus?: (workSessionId: string | null) => void;
}

/** `window.batonDesktopBridge` (exposed by Baton's own preload), or undefined outside the desktop app. */
export const batonDesktopBridge = (): BatonDesktopBridge | undefined =>
  (globalThis as { batonDesktopBridge?: BatonDesktopBridge }).batonDesktopBridge;

/** The desktop's job tools (D145), answered by the window with the job RPCs; arguments are checked server-side. */
export interface BatonJobBridgeRequest {
  readonly kind: "job";
  readonly op:
    | "list"
    | "team"
    | "start"
    | "agree"
    | "refine"
    | "grant"
    | "revoke"
    | "watch"
    | "stop"
    | "schedule"
    | "split"
    | "handoff"
    | "rule_preview"
    | "rule_run";
  readonly args: Readonly<Record<string, unknown>>;
}

/** The desktop's memory calls (D150), answered by the window with `baton.memory.*`; the server checks every argument. */
export interface BatonMemoryBridgeRequest {
  readonly kind: "memory";
  readonly op:
    | "list"
    | "search"
    | "add"
    | "edit"
    | "pin"
    | "forget"
    | "accept"
    | "recall"
    | "used"
    | "history"
    | "restore"
    | "export"
    | "learn"
    | "import"
    | "pull"
    | "syncPush"
    | "syncPeers"
    | "syncPair"
    | "syncLink";
  readonly args: Readonly<Record<string, unknown>>;
}

/** The desktop's commitments ledger calls (D149), answered by the window with `baton.commitments.*`. */
export interface BatonCommitmentBridgeRequest {
  readonly kind: "commitments";
  readonly op: "list" | "upsert";
  readonly args: Readonly<Record<string, unknown>>;
}

/** The desktop assistant's weave calls (D149), answered by the window with `baton.weave.*`. */
export interface BatonWeaveBridgeRequest {
  readonly kind: "weave";
  readonly op: "send" | "list" | "tick";
  readonly args: Readonly<Record<string, unknown>>;
}

/** Cloud tasks on the computer that runs them (transport 2): which environments are connected, and a read or an act call to one. */
export interface BatonCloudBridgeRequest {
  readonly kind: "cloud";
  readonly op: "environments" | "read" | "act" | "approve";
  /** The connected environment to ask; absent means the one this window is on. */
  readonly environmentId?: string;
  readonly args: Readonly<Record<string, unknown>>;
}

/** The desktop assistant's phone relay calls, answered by the window with `baton.phone.call`. */
export interface BatonPhoneBridgeRequest {
  readonly kind: "phone";
  readonly op: (typeof BATON_PHONE_OPS)[number];
  readonly args: Readonly<Record<string, unknown>>;
}
