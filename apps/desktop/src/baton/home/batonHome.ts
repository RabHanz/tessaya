/* oxlint-disable t3code/no-global-process-runtime -- Baton file predating the rule (D82) */
/* oxlint-disable t3code/no-low-value-comments -- Baton file predating upstream's rule (D82) */
/**
 * Baton's own window: a settings home with a few plain choices up front and the raw ones behind
 * "More" (D130). It is not T3's web app. The page is local, built from a string like the pill and
 * the ask box, and talks to the main process over three IPC channels. Every control is described
 * by data (`HomeControl`), so the tray, the voice side and the companion each own their settings and
 * this file owns only how they look.
 */
// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off
import * as Electron from "electron";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { BatonLearnCallInput, type EnrolCard } from "@t3tools/tessaya-contracts";
import * as Schema from "effect/Schema";

import { guestLinkOut, isEmbedSrc } from "./links.ts";
import { admitTrustedGuestsToClerk, trustRenderer } from "../trustedRenderers.ts";
import { markCompanionWindow } from "../lastAppWindow.ts";
import { markPhase } from "../lifecycle/mainStall.ts";
import { homeDocumentFor } from "./homeDocument.ts";
import { THEME_GROUND, resolveTheme, themeSourceFor, type Appearance } from "./theme.ts";
import { tabOf, type TabId } from "./tabs.ts";
import {
  applyLookScript,
  effectiveGlass,
  effectiveMotion,
  lookClasses,
  materialFor,
  seeThrough,
  type Glass,
  type Motion,
} from "./look.ts";
import type { Palette } from "./palette.ts";
import { artDir, companionDir, readArt, stingFile } from "./artFiles.ts";
import { shouldSplash, splashCentre } from "./splash.ts";
import { startSplash } from "./splashWindow.ts";
import { envOf } from "@t3tools/tessaya-shared/envOf";

export interface HomeOption {
  readonly value: string;
  readonly label: string;
  /** One line saying what choosing it does. */
  readonly note?: string;
  /** The voice this option speaks in, for a Play button beside it. */
  readonly voice?: string;
}

interface HomeControlBase {
  readonly id: string;
  readonly section: string;
  readonly label: string;
  readonly hint?: string;
  /** Behind "More" in its section. */
  readonly more?: boolean;
  readonly disabled?: boolean;
  /** What the closed section's button says ("Show all"), when it is not "More options". */
  readonly moreLabel?: string;
  /** Which tab it is drawn on; filled in here from its id. */
  readonly tab?: TabId;
  /** How it may change by voice, when not its Settings category's (remoteSettings.ts TAB_VOICE). */
  readonly voice?: "free" | "confirm" | "owner" | "never";
  /** Its section goes first: what he should do before anything else. */
  readonly lead?: boolean;
}

export type HomeControl =
  | (HomeControlBase & { readonly kind: "toggle"; readonly on: boolean })
  | (HomeControlBase & {
      readonly kind: "choice";
      readonly value: string;
      readonly options: ReadonlyArray<HomeOption>;
    })
  | (HomeControlBase & {
      readonly kind: "action";
      readonly button: string;
      /** Sent with the click, so the handler acts on what the button said when he pressed it. */
      readonly value?: string;
      /** A second button beside it; its action id is `<id>:later`. */
      readonly secondary?: string;
    })
  /** One of several, each with a note; "soon" rows are shown and cannot be picked. */
  | (HomeControlBase & {
      readonly kind: "brain";
      readonly value: string;
      readonly options: ReadonlyArray<{
        readonly value: string;
        readonly label: string;
        readonly note: string;
        readonly state: "ready" | "unavailable" | "soon";
      }>;
    })
  /** One live session: open its thread, or type to it. */
  | (HomeControlBase & {
      readonly kind: "session";
      readonly project: string;
      readonly box: string;
      readonly state: "working" | "waiting" | "idle";
      readonly stateLabel: string;
      readonly urgent: boolean;
      readonly masked?: string;
      readonly revealed?: string;
      readonly canOpen: boolean;
      readonly canSend: boolean;
    })
  /** One line of the Check area: how it is, and what to do. */
  | (HomeControlBase & {
      readonly kind: "check";
      readonly status: "ok" | "warn" | "bad";
      readonly detail: string;
      readonly fix?: string;
    })
  /** A text he edits in the window. Ids: `<id>:save` (the text) and `<id>:reset` (back to the default). */
  | (HomeControlBase & {
      readonly kind: "editor";
      readonly text: string;
      /** His own file exists, so "Use default" does something. */
      readonly mine: boolean;
    })
  /** The guided voice read (Voice ID): the window shows it as a card over everything. Ids: `<id>:redo`, `<id>:close`. */
  | (HomeControlBase & { readonly kind: "enrol"; readonly card: EnrolCard })
  /** A calendar of days as a grid, oldest first, one column per week: level 0 to 4, or -1 for a blank. */
  | (HomeControlBase & {
      readonly kind: "heat";
      readonly cells: ReadonlyArray<{ readonly label: string; readonly level: number }>;
    })
  /** A list he edits: each item with Remove, and a line to add one. Ids: `<id>:add` (the text) and `<id>:rm` (the item). */
  | (HomeControlBase & {
      readonly kind: "list";
      readonly items: ReadonlyArray<string>;
      readonly placeholder: string;
      readonly addLabel?: string;
      /** The line is typed like a password and never shown back (a cloud key). */
      readonly secret?: boolean;
      /** It always has a value: its item has no Remove (a member's name). */
      readonly required?: boolean;
    })
  /** One memory (D150): its text is the label, `hint` says where it came from. Edit, pin and forget are the page's. */
  | (HomeControlBase & {
      readonly kind: "memory";
      readonly pinned: boolean;
      /** A proposal waiting for his yes. */
      readonly held: boolean;
      /** The plain answer to "why do you remember this". */
      readonly why: string;
      /** A private store's id: its buttons act on that store, and it has no Pin or History. */
      readonly store?: string;
      /** Only this persona recalls it; "Make household" opens it to every persona. */
      readonly personaOnly?: string;
    })
  /** The People area of the Memory tab: everyday memory, his private store and each person's, each under a PIN. */
  | (HomeControlBase & {
      readonly kind: "privatePeople";
      readonly people: ReadonlyArray<{
        readonly id: string;
        readonly name: string;
        /** "everyday" is the plain list; "wait" and "recovery" take no PIN. */
        readonly state: "everyday" | "open" | "locked" | "wait" | "recovery";
        /** Its count and lock in words: "12 memories · locks in 4 min". */
        readonly note: string;
        readonly selected: boolean;
        /** His store is open here, so this person's store opens with no PIN, as admin. */
        readonly admin: boolean;
      }>;
      /** He has no private store yet. */
      readonly canSetup: boolean;
      /** His store is open: he may add a person. */
      readonly ownerOpen: boolean;
      /** Saved Voice ID people with no store yet: the only ones a store can be made for. */
      readonly voices: ReadonlyArray<{ readonly id: string; readonly name: string }>;
      /** Shown once, after a store is made, until he says it is saved. */
      readonly recovery: { readonly name: string; readonly code: string } | null;
      readonly status: string;
    })
  /** An open private store's tools: search, lock, export, PIN, recall and its audit. */
  | (HomeControlBase & {
      readonly kind: "privateBar";
      readonly store: string;
      readonly query: string;
      readonly recallOff: boolean;
      /** Opened as admin: its PIN is theirs to change. */
      readonly canChangePin: boolean;
      readonly canDelete: boolean;
      readonly confirmDelete: boolean;
      readonly audit: {
        readonly intact: boolean;
        readonly rows: ReadonlyArray<{ readonly line: string; readonly at: string }>;
      } | null;
    })
  /** The Sessions browser's bar: search, machine and state filters, New session. */
  | (HomeControlBase & {
      readonly kind: "catalogBar";
      readonly query: string;
      readonly machine: string;
      readonly stateFilter: string;
      readonly machines: ReadonlyArray<HomeOption>;
      readonly states: ReadonlyArray<HomeOption>;
      /** Every word the bar shows, so the page script holds none. */
      readonly words: Readonly<Record<string, string>>;
      readonly creating: boolean;
      readonly newMachine: string;
      readonly folders: ReadonlyArray<string>;
      /** Folders that already hold stopped sessions: how many, and the latest one's row id. */
      readonly earlierHere: ReadonlyArray<{
        readonly cwd: string;
        readonly count: number;
        readonly id: string;
      }>;
      readonly background: boolean;
      /** The Auto-resume switch; null until the servers have answered. */
      readonly autoResume: boolean | null;
      /** Helper threads a dry run found, waiting for "Archive them". */
      readonly tidyFound: number;
      readonly models: ReadonlyArray<HomeOption>;
      readonly efforts: ReadonlyArray<HomeOption>;
      readonly status: string;
      /** Rows past the page, behind Show more. */
      readonly remaining: number;
    })
  /** One session in the browser: running or stopped, on a machine, with Resume when it is stopped. */
  | (HomeControlBase & {
      readonly kind: "catalogRow";
      readonly project: string;
      readonly machine: string;
      readonly when: string;
      readonly state: "running" | "stopped" | "resuming" | "failed";
      readonly stateLabel: string;
      readonly resumeLabel: string | null;
      /** One line on what Resume does. */
      readonly note: string;
      /** Stop, on a running session. */
      readonly stopLabel: string | null;
      readonly source: string;
      /** What it is really bound to: "Herdr pane ...", "T3-hosted handoff session", or "". */
      readonly binding: string;
      /** Reattach, on a thread a handoff session answers; "Reattach to <pane>?" once it found one to offer. */
      readonly reattachLabel: string | null;
      /** "2 kept messages", which opens them; null when it keeps none. */
      readonly keptLabel: string | null;
      /** The kept messages, when open. */
      readonly kept: ReadonlyArray<string> | null;
      readonly keptNote: string;
      readonly discardLabel: string;
    })
  /** The Memory area's bar: search, the kinds to browse, export, import and sync. */
  | (HomeControlBase & {
      readonly kind: "memoryBar";
      readonly query: string;
      readonly filter: string;
      readonly kinds: ReadonlyArray<{
        readonly value: string;
        readonly label: string;
        readonly count: number;
      }>;
      readonly usedOnly: boolean;
      readonly usedCount: number;
      readonly syncOn: boolean;
      /** Each connected server; one that is not paired for sync keeps its walled memory to itself. */
      readonly peers: ReadonlyArray<{
        readonly environmentId: string;
        readonly label: string;
        readonly local: boolean;
        readonly paired: boolean;
        readonly expiresAt?: number;
      }>;
      /** The daily pull of learnings from the history index (held for his yes). */
      readonly pullOn: boolean;
      readonly status: string;
    })
  /** The Vault area's header: make, unlock, lock, add, export, import, and the activity log (D151). */
  | (HomeControlBase & {
      readonly kind: "vaultBar";
      readonly state: "none" | "locked" | "unlocked";
      readonly status: string;
      /** Shown once after the vault is made, until he says it is saved. */
      readonly recovery: string | null;
      /** Windows Hello is there to confirm it is him. */
      readonly hello: boolean;
      readonly activity: ReadonlyArray<string>;
    })
  /** One secret: its name and rules; the value only while he has asked to see it. */
  | (HomeControlBase & {
      readonly kind: "vaultItem";
      readonly policy: string;
      /** Financial: the policy cannot be changed. */
      readonly locked: boolean;
      readonly revealed: string | null;
    })
  /** Shown masked until he clicks it. */
  | (HomeControlBase & {
      readonly kind: "secret";
      readonly masked: string;
      readonly revealed: string;
    });

/** One thing on Home's Today card: a History row or a command or action from the turn log. */
export interface HomeActivity {
  readonly id: string;
  readonly at: string;
  readonly kind: "dictation" | "spoken" | "command" | "assistant";
  /** The words, or what was done as a sentence. Empty for a hidden row. */
  readonly text: string;
  readonly detail: string | null;
  readonly app?: string;
  readonly hidden?: string | null;
}

/** What the tabs show beyond the controls: all data, nothing the page decides. */
export interface HomeExtra {
  /** The tour: opens on its own when "open", one card on Home when "offer"; run again from Help or Settings. */
  readonly setup?: {
    readonly mode: "open" | "offer" | "none";
    readonly step: number;
    readonly steps: ReadonlyArray<{
      readonly id: string;
      readonly title: string;
      readonly text: string;
      readonly controls: ReadonlyArray<string>;
      readonly meter?: boolean;
      readonly tryBox?: boolean;
      readonly facts?: ReadonlyArray<{ readonly label: string; readonly hint: string }>;
    }>;
    readonly hold: string;
  };
  readonly wakeWords: ReadonlyArray<string>;
  readonly activity: ReadonlyArray<HomeActivity>;
  readonly stats: {
    readonly turns: number;
    readonly dictations: number;
    readonly sessions: number;
    readonly needYou: number;
  };
  readonly insights: {
    readonly wordsToday: number;
    readonly dictationsToday: number;
    readonly minutesSaved: number;
    readonly wpm: number | null;
    readonly streak: number;
    readonly topApps: ReadonlyArray<{ readonly app: string; readonly count: number }>;
  };
  readonly vocabulary: ReadonlyArray<{
    readonly phrase: string;
    readonly replacement: string | null;
    readonly heard?: ReadonlyArray<string>;
  }>;
  readonly hotkeys: ReadonlyArray<{
    readonly label: string;
    readonly keys: string;
    readonly tab: string;
    readonly hint?: string;
  }>;
  readonly usage: ReadonlyArray<{
    readonly account: string;
    readonly box: string;
    readonly windows: ReadonlyArray<{
      readonly label: string;
      readonly usedPercent: number | null;
      readonly resetsAt: string | null;
    }>;
  }>;
  readonly bindings: ReadonlyArray<{
    readonly action: string;
    readonly label: string;
    readonly hint: string;
    /** Up to four ways to do it; empty is off on purpose. */
    readonly inputs: ReadonlyArray<
      | { readonly type: "key"; readonly accelerator: string }
      | { readonly type: "mouse"; readonly button: string }
    >;
    readonly isDefault: boolean;
    readonly conflictsWith: ReadonlyArray<string>;
    /** Per input who else has it, to say so beside the chip. */
    readonly conflicts: ReadonlyArray<{
      readonly index: number;
      readonly with: ReadonlyArray<string>;
    }>;
  }>;
  /** Why the last change to a binding was refused, in plain words; null when it was not. */
  readonly bindingsNote: string | null;
  /** Whether Baton can act on a mouse button yet; until then they are saved and say so. */
  readonly mouseReady: boolean;
  /** Mouse buttons can be bound here: the hook is the Windows helper's, so on Windows only. */
  readonly mouseButtons: boolean;
  readonly lifecycle: ReadonlyArray<{ readonly at: string; readonly text: string }>;
  readonly paths: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly path: string;
  }>;
  readonly about: {
    readonly version: string;
    readonly source: string;
    readonly licence: string;
    readonly notices: string;
  };
}

export interface HomeState {
  readonly status: {
    readonly label: string;
    readonly tone: string;
    readonly device: string;
    /** The mark in the state's colour, made by the main process. */
    readonly mark: string;
    /** The same mark in Baton's own colour, for the sidebar. */
    readonly brandMark?: string;
  };
  readonly controls: ReadonlyArray<HomeControl>;
  readonly extra?: HomeExtra;
}

export interface BatonHomeInput {
  /** Where the window remembers its size. */
  readonly stateDir: string;
  readonly state: () => HomeState;
  readonly apply: (id: string, value: string | boolean | null) => void;
  /** T3's window, filtered to live sessions or at one of its own pages (`/settings/worktrees`). */
  readonly openSessions: (liveOnly?: boolean, path?: string) => void;
  /** T3's app address, whose `/tessaya/<page>` routes this window shows inline; absent, those pages offer T3 instead. */
  readonly embed?: { readonly url: string; readonly preload: string };
  /** His tips' progress on this machine's server (`baton.learn.call`); absent, the window keeps it alone. */
  readonly learn?: (call: BatonLearnCallInput) => Promise<unknown>;
  /** The window moved to this tab. */
  readonly onTab?: (tab: string) => void;
  /** System, Light or Dark, as he chose it in Settings. */
  readonly appearance: () => Appearance;
  /** The motion and glass he chose; the system's own asks are read here. */
  readonly look?: () => {
    readonly motion: Motion;
    readonly glass: Glass;
    readonly palette?: Palette;
  };
  /** Whether this run was started quietly (at sign-in, or hidden): no splash then. */
  readonly quietLaunch?: () => boolean;
  /** The microphone's level now, 0 to 1, for the guide's meter. */
  readonly level?: () => number;
}

export interface BatonHome {
  /** Up front, at a place (`hardware`, `voice`) when given. */
  readonly open: (place?: string) => void;
  /** Re-reads Motion and Glass and applies them to the open window now. */
  readonly applyLook: () => void;
  /** Push fresh state if the window is up. */
  readonly refresh: () => void;
}

const DEFAULT_WIDTH = 1100;
const DEFAULT_HEIGHT = 740;

/** The last size and place, or null: a missing or odd file is the default size. */
const readBounds = (file: string) => {
  try {
    const parsed: unknown = JSON.parse(NodeFS.readFileSync(file, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const { x, y, width, height } = parsed as Record<string, unknown>;
    if (typeof width !== "number" || typeof height !== "number") return null;
    if (width < 860 || height < 580 || width > 6000 || height > 4000) return null;
    return {
      width,
      height,
      ...(typeof x === "number" ? { x } : {}),
      ...(typeof y === "number" ? { y } : {}),
    };
  } catch {
    return null;
  }
};

const GET = "baton-home:get";
const SET = "baton-home:set";
const SESSIONS = "baton-home:sessions";
const PUSH = "baton-home:state";
const PUSH_MS = 250;
const THEME = "baton-home:theme";
const LEVEL = "baton-home:level";
const STING = "baton-home:sting";
const EMBED = "baton-home:embed";
const LEARN = "baton-home:learn";
const decodeLearnCall = Schema.decodeUnknownOption(BatonLearnCallInput);
const GO = "baton-home:go";
const T3_PATH = /^\/(settings|tessaya)\/[a-z-]+$/;
/** Tessaya's palette art: the app's resources when packaged, the source tree when run from it. */
export const ART_DIR = artDir(__dirname, process.resourcesPath);
export const COMPANION_DIR = companionDir(__dirname, process.resourcesPath);
const art = ART_DIR;

const withTabs = (state: HomeState): HomeState => ({
  ...state,
  controls: state.controls.map((c) => ({ ...c, tab: c.tab ?? tabOf(c.id) })),
});

export const createBatonHome = (input: BatonHomeInput): BatonHome => {
  let win: Electron.BrowserWindow | null = null;
  const live = () => (win !== null && !win.isDestroyed() ? win : null);
  // The splash was this window's opening sting: the page then rests instead of playing a second one beside it.
  let splashed = false;

  Electron.ipcMain.handle(GET, () => ({ ...withTabs(input.state()), splashed }));
  Electron.ipcMain.handle(SET, (_event, id: unknown, value: unknown) => {
    if (
      typeof id === "string" &&
      (value === null || ["string", "boolean"].includes(typeof value))
    ) {
      input.apply(id, value as string | boolean | null);
    }
    return withTabs(input.state());
  });
  Electron.ipcMain.handle(LEVEL, () => input.level?.() ?? 0);
  Electron.ipcMain.handle(STING, () => readArt(art, stingFile(look().palette, theme())));
  Electron.ipcMain.on(SESSIONS, (_event, filter: unknown) =>
    input.openSessions(
      filter === "live",
      typeof filter === "string" && T3_PATH.test(filter) ? filter : undefined,
    ),
  );
  Electron.ipcMain.handle(EMBED, () => input.embed?.url ?? null);
  // The T3 pages shown inline sign in to T3 Connect too, or their remote environments stay offline.
  if (input.embed !== undefined) admitTrustedGuestsToClerk();
  Electron.ipcMain.handle(LEARN, (_event, call: unknown) => {
    const decoded = decodeLearnCall(call);
    return decoded._tag === "Some" && input.learn !== undefined
      ? input.learn(decoded.value).catch(() => null)
      : null;
  });
  // BATON_TEST_DIR: a PNG of the window's own page when it shows and at each tab change, from inside the app;
  // otherwise nothing.
  let tabShots = 0;
  const shoot = (open: Electron.BrowserWindow | null, tab: string) => {
    const dir = envOf("TEST_DIR") ?? "";
    if (dir === "" || open === null) return;
    const n = (tabShots += 1);
    setTimeout(() => {
      if (open.isDestroyed()) return;
      void open.webContents
        .capturePage()
        .then((image) => {
          NodeFS.mkdirSync(dir, { recursive: true });
          NodeFS.writeFileSync(
            NodePath.join(dir, `home-${tab.replace(/[^a-z]/g, "")}-${n}.png`),
            image.toPNG(),
          );
        })
        .catch(() => undefined);
    }, 500).unref();
  };
  Electron.ipcMain.on("baton-home:tab", (_event, tab: unknown) => {
    if (typeof tab !== "string") return;
    input.onTab?.(tab);
    shoot(live(), tab);
  });

  const systemAsks = () => ({
    reducedMotion:
      Electron.systemPreferences.getAnimationSettings?.().prefersReducedMotion === true,
    reducedTransparency:
      (Electron.nativeTheme as { prefersReducedTransparency?: boolean })
        .prefersReducedTransparency === true,
  });
  const look = () => {
    const chosen = input.look?.() ?? { motion: "full" as const, glass: "on" as const };
    return {
      motion: effectiveMotion(chosen.motion, systemAsks()),
      glass: effectiveGlass(chosen.glass, systemAsks()),
      palette: chosen.palette ?? "woad",
    };
  };
  const material = () => materialFor(process.platform, NodeOS.release(), look().glass);
  const overlayFor = (t: "light" | "dark") => ({
    // With a material behind it the strip stays clear, so the glass shows through to the window controls.
    color: seeThrough(material()) ? "#00000000" : THEME_GROUND[t],
    symbolColor: t === "dark" ? "#e9e6df" : "#1c1b18",
    height: 50,
  });
  const boundsFile = NodePath.join(input.stateDir, "baton-window.json");
  /** The page for a theme, written next to the other state only when it differs from what is there. */
  const documentFile = (t: "light" | "dark"): string | null => {
    const file = NodePath.join(input.stateDir, `baton-window-${t}.html`);
    try {
      const html = homeDocumentFor(t);
      if (!NodeFS.existsSync(file) || NodeFS.readFileSync(file, "utf8") !== html) {
        NodeFS.mkdirSync(input.stateDir, { recursive: true });
        NodeFS.writeFileSync(file, html);
      }
      return file;
    } catch {
      return null;
    }
  };
  const theme = () => resolveTheme(input.appearance(), Electron.nativeTheme.shouldUseDarkColors);
  // What each window was last given, so a burst of refreshes does not repeat synchronous window-manager calls.
  const applied = new WeakMap<object, string>();
  const bars = new WeakMap<object, string>();
  const looked = new WeakMap<object, string>();
  const grounds = new WeakMap<object, string>();
  /** The page and the window's own colour, set live: no reload, no flicker. */
  const applyTheme = () => {
    const open = live();
    if (open === null) return;
    // Set only on a change: each set fires nativeTheme "updated", which calls this again.
    const source = themeSourceFor(input.appearance());
    if (Electron.nativeTheme.themeSource !== source) Electron.nativeTheme.themeSource = source;
    // A synchronous window-manager call: only when the colour changes, not on every push.
    const ground =
      process.platform === "win32" && seeThrough(material()) ? "#00000000" : THEME_GROUND[theme()];
    if (grounds.get(open) !== ground) {
      grounds.set(open, ground);
      open.setBackgroundColor(ground);
    }
    // The window controls follow the page, both ways, live.
    if (process.platform !== "darwin" && bars.get(open) !== theme()) {
      bars.set(open, theme());
      try {
        open.setTitleBarOverlay(overlayFor(theme()));
      } catch {
        // A platform without the overlay keeps its own frame.
      }
    }
    open.webContents.send(THEME, theme());
  };
  Electron.nativeTheme.on("updated", applyTheme);
  /** The classes on the page's root, and the window's material: live, no reload. */
  /** `force` after a page load, whose root starts with no classes; a refresh sends the script only when it changed. */
  const applyLook = (force = true) => {
    const open = live();
    if (open === null) return;
    const now = look();
    const script = `${applyLookScript(lookClasses(now.motion, now.glass, now.palette))};document.documentElement.classList.toggle("material",${seeThrough(material())})`;
    if (force || looked.get(open) !== script) {
      looked.set(open, script);
      void open.webContents.executeJavaScript(script).catch(() => undefined);
    }
    if (process.platform === "win32") {
      // Each of these is a synchronous call into the window manager: only when the value changed, never per refresh.
      const key = `${material().backgroundMaterial ?? "none"}|${theme()}`;
      if (applied.get(open) === key) return;
      applied.set(open, key);
      try {
        open.setBackgroundMaterial(material().backgroundMaterial ?? "none");
        open.setBackgroundColor(seeThrough(material()) ? "#00000000" : THEME_GROUND[theme()]);
        open.setTitleBarOverlay(overlayFor(theme()));
      } catch {
        // Windows 10 and older builds keep a plain background.
      }
    } else if (process.platform === "darwin") {
      try {
        open.setVibrancy(material().vibrancy ?? null);
      } catch {
        // No vibrancy: plain.
      }
    }
  };
  let opened = false;
  // Download progress, sidebar snapshots and catalog refreshes each ask for a refresh: one push per PUSH_MS at most,
  // and the trailing one builds the state when it is sent, so the window always ends on the latest.
  let pushedAt = 0;
  let pushTimer: ReturnType<typeof setTimeout> | null = null;
  // A window nobody can see is not rebuilt for: it is marked stale and gets the latest when it shows again.
  let stale = false;
  const push = () => {
    pushTimer = null;
    const open = live();
    if (open === null) return;
    if (!open.isVisible() || open.isMinimized()) {
      stale = true;
      return;
    }
    stale = false;
    pushedAt = Date.now();
    markPhase("home-push:begin");
    // Named steps, so a slow push in the stall log says whether building the state or sending it took the time.
    markPhase("home-state:begin");
    const state = withTabs(input.state());
    markPhase("home-state:end");
    open.webContents.send(PUSH, state);
    markPhase("home-sent");
    applyTheme();
    applyLook(false);
    markPhase("home-push:end");
  };
  const showing = () => {
    if (stale && pushTimer === null) push();
  };
  return {
    applyLook: () => applyLook(),
    refresh: () => {
      if (pushTimer !== null) return;
      const wait = pushedAt + PUSH_MS - Date.now();
      if (wait > 0) pushTimer = setTimeout(push, wait);
      else push();
    },
    open: (place) => {
      const existing = live();
      if (existing !== null) {
        if (existing.isMinimized()) existing.restore();
        existing.show();
        existing.focus();
        if (place !== undefined) existing.webContents.send(GO, place);
        return;
      }
      const remembered = readBounds(boundsFile);
      const created = new Electron.BrowserWindow({
        width: remembered?.width ?? DEFAULT_WIDTH,
        height: remembered?.height ?? DEFAULT_HEIGHT,
        ...(remembered?.x === undefined || remembered.y === undefined
          ? {}
          : { x: remembered.x, y: remembered.y }),
        minWidth: 860,
        minHeight: 580,
        title: "Tessaya",
        backgroundColor: seeThrough(material()) ? "#00000000" : THEME_GROUND[theme()],
        ...material(),
        autoHideMenuBar: true,
        // Our own title strip, so the window controls take the page's theme, not Windows'.
        ...(process.platform === "darwin"
          ? {}
          : { titleBarStyle: "hidden" as const, titleBarOverlay: overlayFor(theme()) }),
        show: false,
        webPreferences: { nodeIntegration: true, contextIsolation: false, webviewTag: true },
      });
      // T3 pages shown inline run as T3's own window does: its preload, sandboxed, and nothing but T3's app address.
      created.webContents.on("will-attach-webview", (event, webPreferences, params) => {
        const embed = input.embed;
        if (embed === undefined || !isEmbedSrc(embed.url, params.src ?? "")) {
          event.preventDefault();
          return;
        }
        webPreferences.preload = embed.preload;
        webPreferences.sandbox = true;
        webPreferences.contextIsolation = true;
        webPreferences.nodeIntegration = false;
        webPreferences.nodeIntegrationInSubFrames = false;
      });
      created.webContents.on("did-attach-webview", (_event, guest) => {
        guest.setWindowOpenHandler(() => ({ action: "deny" }));
        // It talks to T3's desktop IPC as T3's window does, so it never leaves T3's own pages.
        const appUrl = input.embed?.url;
        guest.on("will-navigate", (event, url) => {
          if (appUrl === undefined || !url.startsWith(appUrl)) event.preventDefault();
        });
        // A link to the rest of T3 (Hardware's voice settings, an account's provider) opens in T3's own window.
        guest.on("did-navigate-in-page", (_event, url, isMainFrame) => {
          const path = appUrl === undefined || !isMainFrame ? null : guestLinkOut(appUrl, url);
          if (path === null) return;
          input.openSessions(false, T3_PATH.test(path) ? path : undefined);
          guest.navigationHistory.goBack();
        });
        trustRenderer(guest);
      });
      // Baton's own window is not T3's: without this "Open sessions" reveals this window and T3 never opens.
      markCompanionWindow(created);
      let saveTimer: ReturnType<typeof setTimeout> | null = null;
      const saveBounds = () => {
        if (saveTimer !== null) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
          if (created.isDestroyed() || created.isMinimized() || created.isMaximized()) return;
          try {
            NodeFS.writeFileSync(boundsFile, JSON.stringify(created.getBounds()));
          } catch {
            // The size is a nicety; losing it must never matter.
          }
        }, 400);
        saveTimer.unref();
      };
      created.on("resized", saveBounds);
      created.on("moved", saveBounds);
      created.removeMenu();
      // The page is ours alone: it never navigates, and a link opens nothing.
      created.webContents.on("will-navigate", (event) => event.preventDefault());
      created.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      // The splash plays on a cold start the person made; it never holds the window past its own cap.
      const coldStart = !opened && process.uptime() < 20;
      opened = true;
      const wanted = shouldSplash({
        coldStart,
        quietLaunch: input.quietLaunch?.() ?? false,
        reducedMotion: look().motion !== "full",
      });
      const splash = wanted
        ? startSplash(
            splashCentre(Electron.screen.getDisplayMatching(created.getBounds()).workArea),
            readArt(art, stingFile(look().palette, theme())),
          )
        : null;
      splashed = splash !== null;
      created.webContents.on("did-finish-load", () => applyLook());
      if (place !== undefined)
        created.webContents.once("did-finish-load", () => created.webContents.send(GO, place));
      created.once("ready-to-show", () => {
        if (splash === null) return created.show();
        splash.whenToShow(() => {
          created.setOpacity(0);
          created.show();
          splash.fade((o) => created.isDestroyed() || created.setOpacity(o), 0, 1);
        });
      });
      created.once("show", () => shoot(created, "open"));
      created.on("show", showing);
      created.on("restore", showing);
      created.on("closed", () => {
        if (win === created) win = null;
        // No page is on show: what a page holds while it is open (private memories) can go.
        input.onTab?.("");
      });
      // A file, not a 600 KB data: URL that is percent-encoded and parsed on every open; the URL is the fallback.
      const file = documentFile(theme());
      if (file !== null) void created.loadFile(file);
      else {
        void created.loadURL(
          `data:text/html;charset=utf-8,${encodeURIComponent(homeDocumentFor(theme()))}`,
        );
      }
      win = created;
    },
  };
};
