/**
 * Every setting by voice, in plain words with a safety class (free: at once; confirm and owner: his yes on his phone;
 * never: refused, with why). Typed over the schemas' fields: a setting without a voice path does not compile.
 */
import { TEMPERAMENT_DIALS, TRAITS } from "@t3tools/tessaya-shared/affect";
import { type DesktopSettingsControl, DesktopVoiceSettingsPatch } from "@t3tools/tessaya-contracts";
import { ServerSettings, ServerSettingsPatch } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import { ServerSettingsService } from "../serverSettings.ts";
import { TessayaDesktopSettings } from "./TessayaDesktopSettings.ts";
import { TessayaHousehold } from "./TessayaHousehold.ts";
import { TessayaPhoneInbox } from "./TessayaPhoneInbox.ts";
import { TurnOrigin } from "./TurnOrigin.ts";
import { PROMPT_EXPIRED, type PhonePrompt } from "@t3tools/tessaya-shared/phoneRelay";
import { approvalRefusal } from "@t3tools/tessaya-shared/trust";
import { DEVICE } from "@t3tools/tessaya-shared/productNames";

export type SettingClass = "free" | "confirm" | "owner" | "never";

export interface SettingVoice {
  /** What it does, as he would say it; settings_find matches his words against it. */
  readonly say: string;
  readonly class: SettingClass;
  /** Why a never setting is never, in one line. */
  readonly why?: string;
}

const free = (say: string): SettingVoice => ({ say, class: "free" });
const confirm = (say: string): SettingVoice => ({ say, class: "confirm" });
const owner = (say: string): SettingVoice => ({ say, class: "owner" });
const never = (say: string, why: string): SettingVoice => ({ say, class: "never", why });

export const SERVER_SETTINGS_VOICE: {
  readonly [K in keyof typeof ServerSettings.fields]: SettingVoice;
} = {
  favorites: free("favourite models pinned in the model picker"),
  providerModelPreferences: free("which models each provider hides and their order in the picker"),
  worktreeCleanup: confirm("whether and when old worktrees are cleaned up"),
  storageCleanup: confirm("cleaning up old stored data and attachments"),
  worktreesDirectory: owner("the folder new worktrees are made in"),
  fastWorktreeCheckout: free("fast worktree checkout"),
  previousWorktreesDirectories: owner("worktree folders used before"),
  responseStreamingMode: free("whether replies stream by paragraph or arrive per turn"),
  enableProviderUpdateChecks: free("checking for provider updates"),
  keepAwakeWhileAgentsWork: free("keeping the computer awake while agents work"),
  tessayaExpression: free(
    "lines written fresh each time, varied and in character, instead of fixed ones",
  ),
  tessayaMood: free(
    `mood: on or off, its strength (intensity 0 to 1, default 0.6), the warmth that builds from talking most days (bondCap 0 to 0.15; 0 starts afresh each day), and per device its owner and whether it shows feelings toward that person (devices: {"<device id>": {"owner": "<member id>" or null, "show": true or false}}; owned phones and desktops show it by default, Tessels do not), and per persona every emotional dial, 0 to 1 (personas: {"<persona id>": {"<dial>": 0.5}}; dials: ${Object.keys({ ...TRAITS, ...TEMPERAMENT_DIALS }).join(", ")}; jealousy and pressure start at 0, "a bit more jealous" is about 0.3). Its value is an object: {"enabled": true, "intensity": 0.6, "bondCap": 0.15, "devices": {}, "personas": {}}`,
  ),
  companionMotion: free(
    'how proactive she is, how much is said and done unprompted: lively ("be more proactive"), calm, or important only ("be less proactive", less chatter)',
  ),
  tessayaMotion: free(
    'how the Tessel reacts when picked up, put down, shaken or dropped: each on or off, and how hard a move must be (sensitivity low, normal or high). Its value is an object: {"sensitivity": "normal", "lifted": true, "setdown": true, "shaken": true, "dropped": true}',
  ),
  tessayaHaptics: free(
    'the Tessel\'s vibration (buzzing): how strong (intensity off, low, normal or high; "stop buzzing" is off, "vibrate softer" one step down) and what may buzz: reactions to being moved, moods, wake confirmation, reminders. Its value is an object: {"intensity": "normal", "reactions": true, "moods": true, "wake": true, "reminders": true}',
  ),
  tessayaPulse: free(
    'the pulse: noticing things unprompted, on or off; which kinds (jobs, sessions, messages, reminders, calendar, people, home, mood, patterns); topics muted by "stop telling me about X"; daily caps on calls and tokens. Its value is an object: {"enabled": true, "dailyCalls": 48, "dailyTokens": 150000, "categories": {"jobs": true}, "muted": []}',
  ),
  tessayaFeedback: owner(
    'developer feedback loop, problem reports to developers: "off" collects nothing; "silent" sends reports without a word; "developer" also keeps a live dev feed and triage, and she says one line per report',
  ),
  tessayaFeedbackGithub: owner("opening a GitHub issue for each problem report"),
  tessayaCast: free(
    'the cast: which persona lives on each Tessel and whether it follows; tessaya_cast does this. Its value is an object by device id: {"<device id>": {"home": "<persona>", "follows": false, "crew": []}}',
  ),
  newSessionsRun: free("whether new sessions run in Tessaya or a terminal"),
  mainThreadId: owner("which thread is the main session"),
  continueThreadsAfterServerUpdate: confirm("continuing sessions after the server updates"),
  enableAgentBrowserAccess: owner("letting agents use the browser"),
  cloudSpeechCredentials: never(
    "cloud speech keys",
    "a key is a secret: never read aloud or set from a room",
  ),
  dictationCleanupCredentials: never(
    "the dictation clean-up key",
    "a key is a secret: never read aloud or set from a room",
  ),
  roomBrain: never(
    "the desk device's old brain choice",
    "replaced by the brain's routing table: ask which login or model she talks on instead",
  ),
  brainCredentials: owner(
    "which login pays for each kind of her work: his subscription or an API key, and any fallback",
  ),
  brainKeyRoles: owner("which kinds of work each API key is allowed to pay for"),
  approvalCardMinutes: owner(
    "how many minutes a card waiting for his yes stays answerable before it expires (default 30)",
  ),
  brainDeferNearLimit: free(
    "background learning waiting for the reset when the subscription is nearly spent, so talking keeps working",
  ),
  brainEscalation: free(
    'when hard tasks go to Opus: ask him each time, go on her own up to a daily cap, or never; and his standing rules such as coding questions to Opus. Its value is an object: {"mode": "ask" | "auto" | "never", "autoDeepDailyCap": 20, "rules": [{"when": "coding questions", "then": "opus" | "ask" | "sonnet"}]}; send the whole rules list, old ones included',
  ),
  brainSpendAlert: free(
    'API spend alerts: tell him when an API key spends past a dollar limit in a day or a month, for all work or one kind. Its value is an object: {"all": {"day": 1, "month": 20}, "cleanup": {"day": 0.5}}; null clears one',
  ),
  brainModels: confirm(
    "which model and effort each kind of her work uses: talking, hard tasks, background, cleanup",
  ),
  speechModelId: confirm("the speech recognition model"),
  speechAcceleration: free("speech recognition on the GPU or the CPU"),
  speechModelUnloadTimeout: free("how long the speech model stays loaded when idle"),
  speechProjectCustomWords: free("his custom words and names for dictation"),
  voicePronounce: free("how she says words and names aloud"),
  voiceIdGate: owner(
    "who besides him she answers: guests, saved people, talk-over, and anyone when the speaker model is missing",
  ),
  speechPostProcessingModelSelection: confirm("the model that tidies dictation"),
  dictationCleanup: free("how dictation is cleaned up"),
  projectAgentBrowserAccessOverrides: owner("per-project browser access for agents"),
  defaultAutoPull: free("pulling new commits automatically"),
  defaultProjectScripts: owner("scripts every project gets"),
  projectScriptOverrides: owner("per-project scripts"),
  projectAutoPullOverrides: free("per-project automatic pulling"),
  defaultModelSelection: confirm("the default model for new sessions"),
  fallbackModelSelection: confirm("the model used when the default is unavailable"),
  defaultRuntimeMode: owner(
    "how much agents may do without asking: approval required, auto-accept edits, auto, or full access",
  ),
  projectSettingsOverrides: owner("per-project settings"),
  projectSettingsFolded: free("whether project settings are folded in the sidebar"),
  enableAgentDeviceAccess: owner("letting agents use phones and simulators"),
  enableDeviceSupport: confirm("phone and simulator support"),
  deviceOnboardingCompleted: owner("whether device setup was finished"),
  deviceHosts: owner("machines that host devices"),
  easDeviceHosts: owner("EAS build hosts"),
  simlockDeviceHosts: owner("simulator lock hosts"),
  simlockDeviceHostsEnabled: owner("simulator locking"),
  sidebarAutoSettleAfterDays: free("after how many days quiet sessions settle in the sidebar"),
  compactIdleThreads: free("compacting idle sessions"),
  idleCompaction: free("when idle sessions are compacted"),
  snoozeLimitedThreads: free("snoozing sessions that hit a usage limit"),
  autoResumeLimitedThreads: free("resuming limited sessions automatically"),
  snoozePresets: free("the snooze choices offered"),
  hiddenThreadTags: free("tags that hide sessions"),
  hideTaggedThreads: free("hiding tagged sessions"),
  guestSharingEnabled: owner("sharing with guests"),
  linkedEnvironmentsEnabled: owner("linking other machines"),
  promptSuggestionsEnabled: free("prompt suggestions"),
  sidebarAutoSettleKeepPullRequests: free("keeping sessions with pull requests out of auto-settle"),
  sidebarAutoSettleOnMerge: free("settling a session when its pull request merges"),
  backgroundActivity: confirm("background activity limits"),
  automaticGitFetchInterval: free("how often git fetches in the background"),
  providerHealthRefreshInterval: free("how often provider health is checked"),
  backgroundActivityProfile: free("background activity: balanced, performance or battery saver"),
  defaultTheme: free("the app's colour theme"),
  defaultThemeSetAt: owner("when the theme was last chosen"),
  environmentIcon: free("this machine's icon"),
  defaultThreadEnvMode: free("whether new sessions start locally or in a worktree"),
  newWorktreesStartFromOrigin: free("starting new worktrees from the remote branch"),
  worktreeSubmodules: free("worktree submodules"),
  addProjectBaseDirectory: owner("the folder new projects are added from"),
  ghqCloneLayout: free("ghq-style clone folders"),
  textGenerationModelSelection: confirm("the model that writes titles and messages"),
  threadTitleInstructions: free("how session titles are written"),
  branchNamingMode: free("how branches are named"),
  branchNamePrefix: free("the branch name prefix"),
  branchNameInstructions: free("instructions for naming branches"),
  removeAgentCreditsOnMerge: free("removing agent credits from merged commits"),
  sourceControlWritingStyle: free("the style of commit and pull request text"),
  sourceControlWriterModelSelection: confirm("the model that writes commits and pull requests"),
  reviewGuidesEnabled: free("review guides"),
  reviewGuideModelSelection: confirm("the model that writes review guides"),
  reviewGuideInstructions: free("instructions for review guides"),
  pullRequestMergeMethod: confirm("how pull requests merge: merge, squash or rebase"),
  providerInstances: owner("provider accounts and their setup"),
  observability: owner("tracing and telemetry"),
  sourceControlHosts: owner("source control hosts"),
  offeredSourceControlProviders: free("which code hosts the add and publish project pickers offer"),
  usageLimitSources: owner("where usage limits are read from"),
  textGenerators: owner("text generators"),
  secretProviders: never(
    "secret stores",
    "where secrets are kept: a wrong word would expose or lose them",
  ),
  usagePriceOverrides: owner("usage prices"),
  usageModelAliases: owner("usage model aliases"),
  usageModelFilter: free("which models usage shows"),
};

export const DESKTOP_SETTINGS_VOICE: {
  readonly [K in keyof typeof DesktopVoiceSettingsPatch.fields]: SettingVoice;
} = {
  dictationCleanup: free("how dictation is cleaned up on the computer: Claude, local or off"),
  pillStyle: free("the dictation pill's shape: pill or field"),
  pillDesign: free("the pill's look: Tessaya, quiet or lively"),
  pillWaveform: free("the pill's waveform: match, mound, bars or beads"),
  showWords: free("showing his words while he dictates"),
  holdKey: confirm("the key he holds to dictate"),
  holdKeyCues: free("the sounds when the dictation key is pressed and released"),
  frosted: free("the frosted pill background"),
  doubleTap: free("double tap to dictate hands free"),
  learnWords: free("learning his words from corrections"),
  duckWhileDictating: free("lowering or muting other sound while he dictates"),
  recognizeOnServers: confirm("recognising speech on his servers instead of the computer"),
  gpuRecognition: free("recognising speech on the GPU"),
  openTessayaOnStart: free("opening Tessaya when the computer starts"),
  openSessionsOnStart: free("opening sessions when the computer starts"),
  devicesMayLook: owner(
    `letting his own devices, like the ${DEVICE}, look at this computer's screen without asking`,
  ),
};

export type SettingStore = "server" | "desktop" | "control";

export interface SettingEntry extends SettingVoice {
  readonly key: string;
  readonly store: SettingStore;
  /** One of the desktop's own Settings controls, as it published it ("control" store). */
  readonly control?: DesktopSettingsControl;
}

const CONTROL_PREFIX = "desktop:";

/** The fixed settings, then every Settings control the desktop beside this server has published. */
export const allSettings = Effect.gen(function* () {
  const desktop = yield* Effect.serviceOption(TessayaDesktopSettings);
  const published = Option.isNone(desktop) ? [] : ((yield* desktop.value.get).controls ?? []);
  return [
    ...SETTINGS,
    ...published.map((c): SettingEntry => ({
      key: `${CONTROL_PREFIX}${c.id}`,
      store: "control",
      say: `${c.section}: ${c.label}${c.hint === undefined ? "" : ` (${c.hint.slice(0, 160)})`}${
        c.kind === "action"
          ? `; a button, "${c.value}": value true presses it`
          : c.kind === "list"
            ? `; a list: value {"add": "…"} or {"remove": "…"}`
            : c.kind === "editor"
              ? `; a text he edits, which starts "${c.value}": value {"save": "the whole new text"}${c.resettable === true ? ' or {"reset": true} for the default' : ""}`
              : ""
      }`,
      class: c.voice,
      ...(c.voice === "never" ? { why: "his desktop keeps it out of voice" } : {}),
      control: c,
    })),
  ];
});

export const SETTINGS: ReadonlyArray<SettingEntry> = [
  ...Object.entries(SERVER_SETTINGS_VOICE).map(([key, v]) => ({
    key,
    store: "server" as const,
    ...v,
  })),
  ...Object.entries(DESKTOP_SETTINGS_VOICE).map(([key, v]) => ({
    key,
    store: "desktop" as const,
    ...v,
  })),
];

const words = (text: string): ReadonlyArray<string> =>
  text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 2);

/** The settings his words are most likely about, best first; the model picks among them by meaning. */
export const findSettings = (
  text: string,
  entries: ReadonlyArray<SettingEntry> = SETTINGS,
  limit = 5,
): ReadonlyArray<SettingEntry> => {
  const asked = words(text);
  return entries
    .map((s) => {
      // A choice's options are words he says for it ("make her voice slower").
      const hay = words(`${s.key} ${s.say} ${(s.control?.options ?? []).join(" ")}`);
      const score = asked.filter((w) => hay.some((h) => h.startsWith(w) || w.startsWith(h))).length;
      return { s, score };
    })
    .filter((x) => x.score > 0)
    .toSorted((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.s);
};

/** A spoken value as the setting takes it: "true", "40" and the like from a voice turn. */
export const spokenValue = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  const v = value.trim();
  if (v === "true" || v === "on") return true;
  if (v === "false" || v === "off") return false;
  return v !== "" && Number.isFinite(Number(v)) ? Number(v) : value;
};

const shown = (value: unknown): string => {
  const text = JSON.stringify(value ?? null);
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
};
/** The most of an editor's text one spoken change carries (the sync's own bound). */
const EDITOR_MAX = 4000;
/** A control's value as it takes it: true or false for a toggle, one of its options (any case) for a choice. */
const controlValue =
  (key: string, control: DesktopSettingsControl) =>
  (patch: Record<string, unknown>): Option.Option<Record<string, unknown>> => {
    const value = patch[key];
    if (control.kind === "action")
      return value === true || value === "press" ? Option.some({ [key]: true }) : Option.none();
    if (control.kind === "list") {
      const op =
        typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
      const add = typeof op["add"] === "string" ? op["add"].trim() : "";
      const remove = typeof op["remove"] === "string" ? op["remove"].trim() : "";
      const item = control.items?.find((i) => i.toLowerCase() === remove.toLowerCase());
      if (add !== "" && add.length <= 200) return Option.some({ [key]: { add } });
      return item === undefined ? Option.none() : Option.some({ [key]: { remove: item } });
    }
    if (control.kind === "editor") {
      const op =
        typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
      if (op["reset"] === true)
        return control.resettable === true
          ? Option.some({ [key]: { reset: true } })
          : Option.none();
      const raw = typeof value === "string" || typeof value === "number" ? value : op["save"];
      const save = typeof raw === "string" || typeof raw === "number" ? String(raw).trim() : "";
      return save !== "" && save.length <= EDITOR_MAX
        ? Option.some({ [key]: { save } })
        : Option.none();
    }
    if (control.options === undefined)
      return typeof value === "boolean" ? Option.some({ [key]: value }) : Option.none();
    const picked = control.options.find(
      (o) => typeof value === "string" && o.toLowerCase() === value.trim().toLowerCase(),
    );
    return picked === undefined ? Option.none() : Option.some({ [key]: picked });
  };
const decodeServer = Schema.decodeUnknownOption(ServerSettingsPatch);
const decodeDesktop = Schema.decodeUnknownOption(DesktopVoiceSettingsPatch);

export const entryOf = (
  key: string,
  entries: ReadonlyArray<SettingEntry> = SETTINGS,
): SettingEntry | null =>
  entries.find((s) => s.key === key) ??
  entries.find((s) => s.key.toLowerCase() === key.trim().toLowerCase()) ??
  null;

/** Its value now; null for a desktop that has not reported one. A never setting is not read. */
export const settingValue = Effect.fn("SettingsVoice.value")(function* (entry: SettingEntry) {
  if (entry.class === "never") return "(not read aloud)";
  if (entry.control !== undefined) return entry.control.value;
  if (entry.store === "server") {
    const settings = yield* Effect.serviceOption(ServerSettingsService);
    if (Option.isNone(settings)) return null;
    const all = yield* settings.value.getSettings.pipe(Effect.orElseSucceed(() => null));
    return all === null ? null : (all as Record<string, unknown>)[entry.key];
  }
  const desktop = yield* Effect.serviceOption(TessayaDesktopSettings);
  if (Option.isNone(desktop)) return null;
  const view = yield* desktop.value.get;
  return (view.effective as Record<string, unknown> | null)?.[entry.key] ?? null;
});

/** The values a setting takes, when it is a choice. */
export const choicesOf = (entry: SettingEntry): ReadonlyArray<string> | null => {
  if (entry.control !== undefined) return entry.control.options ?? null;
  const fields = (entry.store === "server" ? ServerSettings : DesktopVoiceSettingsPatch)
    .fields as Record<string, Schema.Top>;
  const field = fields[entry.key];
  if (field === undefined) return null;
  const text = JSON.stringify(Schema.toJsonSchemaDocument(field));
  const found = /"enum":(\[[^\]]*\])/.exec(text);
  return found === null ? null : (JSON.parse(found[1]!) as ReadonlyArray<string>);
};

const apply = Effect.fn("SettingsVoice.apply")(function* (entry: SettingEntry, patch: unknown) {
  if (entry.control !== undefined) {
    const desktop = yield* Effect.serviceOption(TessayaDesktopSettings);
    if (Option.isNone(desktop)) return false;
    const value = (patch as Record<string, unknown>)[entry.key];
    const id = entry.control.id;
    const op = value as { add?: string; remove?: string; save?: string; reset?: true };
    // A list's line and Remove, an editor's Save and Use default, as the window sends them.
    yield* desktop.value.setControls([
      entry.control.kind === "list"
        ? op.add !== undefined
          ? { id: `${id}:add`, value: op.add }
          : { id: `${id}:rm`, value: op.remove! }
        : entry.control.kind === "editor"
          ? op.save !== undefined
            ? { id: `${id}:save`, value: op.save }
            : { id: `${id}:reset`, value: true }
          : { id, value: value as string | boolean },
    ]);
    return true;
  }
  if (entry.store === "server") {
    const settings = yield* Effect.serviceOption(ServerSettingsService);
    if (Option.isNone(settings)) return false;
    return yield* settings.value.updateSettings(patch as never).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
  }
  const desktop = yield* Effect.serviceOption(TessayaDesktopSettings);
  if (Option.isNone(desktop)) return false;
  yield* desktop.value.set(patch as never);
  return true;
});

/** What a change is, for his yes, and the line said when it is done, with its way back. */
const linesOf = (entry: SettingEntry, was: unknown, now: unknown) => {
  const control = entry.control;
  if (control?.kind === "action")
    return {
      changed: `press "${String(control.value)}" (${entry.say})`,
      done: `Pressed "${String(control.value)}".`,
    };
  if (control?.kind === "list") {
    const op = now as { add?: string; remove?: string };
    return op.add !== undefined
      ? {
          changed: `add "${op.add}" to ${control.label}`,
          done: `Added "${op.add}" to ${control.label}. To undo, remove it.`,
        }
      : {
          changed: `remove "${op.remove}" from ${control.label}`,
          done: `Removed "${op.remove}" from ${control.label}. To undo, add it back.`,
        };
  }
  if (control?.kind === "editor") {
    const op = now as { save?: string; reset?: true };
    const before = `It was ${shown(was)}${String(was).length >= 200 ? " (its start)" : ""}.`;
    return op.save === undefined
      ? {
          changed: `put ${control.label} back to its default text`,
          done: `${control.label} is back to its default text. ${before} To undo, save that text again.`,
        }
      : {
          changed: `replace ${control.label} with ${shown(op.save)}`,
          done: `Saved ${control.label} as ${shown(op.save)}. ${before} To undo, save that text again${control.resettable === true ? ", or reset it to the default" : ""}.`,
        };
  }
  const changed = `${entry.say}: ${shown(was)} to ${shown(now)}`;
  return {
    changed,
    done: `Changed ${changed}. To change it back, set ${entry.key} to ${shown(was)}.`,
  };
};

export interface SettingSet {
  readonly status: "done" | "asked" | "refused" | "failed";
  readonly line: string;
  readonly key?: string;
  readonly was?: unknown;
  readonly now?: unknown;
}

/** A confirm or owner change, checked and waiting to be put to him on a card. */
interface Asking {
  readonly entry: SettingEntry;
  readonly patch: Record<string, unknown>;
  readonly was: unknown;
  readonly now: unknown;
  readonly changed: string;
}

const askedLine = (changed: string) =>
  `Sent to the Director's phone for a yes: ${changed}. Nothing changes until he says yes.`;

/** One change checked: done, refused or failed as a SettingSet, or an Asking that needs his yes. */
const prepare = Effect.fn("SettingsVoice.prepare")(function* (input: {
  readonly key: string;
  readonly value: unknown;
  readonly dryRun?: boolean;
}) {
  const entry = entryOf(input.key, yield* allSettings);
  if (entry === null)
    return {
      status: "refused",
      line: `No setting is called ${input.key}; use settings_find.`,
    } satisfies SettingSet;
  if (entry.class === "never")
    return {
      status: "refused",
      line: `${entry.say} is never changed by voice: ${entry.why}.`,
    } satisfies SettingSet;
  const decode =
    entry.control !== undefined
      ? controlValue(entry.key, entry.control)
      : entry.store === "server"
        ? decodeServer
        : decodeDesktop;
  const tried = [input.value, spokenValue(input.value)].map(
    (v): Option.Option<Record<string, unknown>> => decode({ [entry.key]: v }),
  );
  const patch = tried.find(Option.isSome);
  if (patch === undefined)
    return {
      status: "refused",
      line: `${shown(input.value)} is not a value ${entry.key} takes${
        choicesOf(entry) === null ? "" : `: one of ${choicesOf(entry)!.join(", ")}`
      }.`,
    } satisfies SettingSet;
  const now = (patch.value as Record<string, unknown>)[entry.key];
  const was = yield* settingValue(entry);
  const { changed, done } = linesOf(entry, was, now);
  const desktop = yield* Effect.serviceOption(TessayaDesktopSettings);
  if (entry.store !== "server" && (Option.isNone(desktop) || !(yield* desktop.value.get).connected))
    return {
      status: "failed",
      line: `${entry.say} is a setting of his desktop app, which is not connected to this server; it changes from the desktop itself.`,
    } satisfies SettingSet;
  if (input.dryRun === true)
    return {
      status: entry.class === "free" ? "done" : "asked",
      key: entry.key,
      was,
      now,
      line: entry.class === "free" ? done : askedLine(changed),
    } satisfies SettingSet;
  if (entry.class === "free") {
    if (!(yield* apply(entry, patch.value)))
      return {
        status: "failed",
        line: `${entry.say} could not be changed here.`,
      } satisfies SettingSet;
    return { status: "done", key: entry.key, was, now, line: done } satisfies SettingSet;
  }
  return { entry, patch: patch.value, was, now, changed } satisfies Asking;
});

const isAsking = (p: SettingSet | Asking): p is Asking => "entry" in p;

/** The card for one change, and its wait: applied once his yes on it comes, off the turn. */
const askCard = (inbox: TessayaPhoneInbox["Service"], id: string, ask: Asking, asked: string) => ({
  card: {
    id,
    title: "Tessaya wants to change a setting",
    detail: `${ask.changed}. ${asked}`,
    buttons: ["Yes, change it", "No"],
    yes: 0,
    cancel: 1,
    needs: "cloud-approve",
  } satisfies PhonePrompt,
  // His yes is waited for as long as the card lives.
  wait: Effect.flatMap(inbox.cardLife, (life) =>
    inbox
      .promptAnswer(id)
      .pipe(
        Effect.repeat({ schedule: Schedule.spaced("2 seconds"), until: (a) => a !== null }),
        Effect.timeoutOption(`${life} millis`),
      ),
  ).pipe(
    Effect.flatMap((answer) =>
      Option.isSome(answer) && answer.value === 0 ? apply(ask.entry, ask.patch) : Effect.void,
    ),
    Effect.ignore,
    Effect.forkDetach,
  ),
});

const askedBy = (who: string, why: string) => `Asked by ${who}: "${why.slice(0, 200)}".`;
const noInbox = (say: string) => `${say} needs his yes, and nothing here can ask him.`;

/**
 * One setting changed by his words: a free one at once, said back with the way to change it back; a confirm or owner
 * one through his yes on a phone card; a never one not at all.
 */
export const setSetting = Effect.fn("SettingsVoice.set")(function* (input: {
  readonly key: string;
  readonly value: unknown;
  readonly why: string;
  readonly who: string;
  /** The tool suite's pretend R1: checked as for real, then nothing changes or is sent. */
  readonly dryRun?: boolean;
}) {
  const ready = yield* prepare(input);
  if (!isAsking(ready)) return ready;
  const inbox = yield* Effect.serviceOption(TessayaPhoneInbox);
  if (Option.isNone(inbox))
    return { status: "refused", line: noInbox(ready.entry.say) } satisfies SettingSet;
  const id = `setting-${ready.entry.key}-${yield* Clock.currentTimeMillis}`.slice(0, 64);
  const { card, wait } = askCard(inbox.value, id, ready, askedBy(input.who, input.why));
  yield* inbox.value.mirror(card);
  // His answer is waited for off the turn: she says it is with him now, and it changes when he says yes.
  yield* wait;
  return {
    status: "asked",
    key: ready.entry.key,
    was: ready.was,
    now: ready.now,
    line: askedLine(ready.changed),
  } satisfies SettingSet;
});

/**
 * Several settings in one breath: free ones change at once, never ones are refused with why, and the ones that need
 * his yes go to his phone as one batch card (each still its own card, tier and Record row underneath).
 */
export const setSettings = Effect.fn("SettingsVoice.setMany")(function* (input: {
  readonly changes: ReadonlyArray<{ readonly key: string; readonly value: unknown }>;
  readonly why: string;
  readonly who: string;
  readonly dryRun?: boolean;
  /** One card across his machines: each machine's part of one request shares this id, and his phone shows one card. */
  readonly batch?: string;
}) {
  const ready = yield* Effect.forEach(input.changes, (c) =>
    prepare({ ...c, ...(input.dryRun === true ? { dryRun: true } : {}) }),
  );
  const asks = ready.filter(isAsking);
  const inbox = yield* Effect.serviceOption(TessayaPhoneInbox);
  if (asks.length > 0 && Option.isSome(inbox)) {
    const at = yield* Clock.currentTimeMillis;
    const asked = askedBy(input.who, input.why);
    const cards = asks.map((ask, i) =>
      askCard(inbox.value, `setting-${at}-${i}-${ask.entry.key}`.slice(0, 64), ask, asked),
    );
    if (cards.length === 1 && input.batch === undefined) yield* inbox.value.mirror(cards[0]!.card);
    else
      yield* inbox.value.mirrorBatch({
        id: input.batch ?? `settings-${at}`,
        title: `Tessaya wants to change ${asks.length} settings`,
        detail: [...asks.map((a, i) => `${i + 1}. ${a.changed}`), asked].join("\n"),
        items: cards.map((c) => c.card),
      });
    for (const c of cards) yield* c.wait;
  }
  return {
    results: ready.map((r): SettingSet =>
      !isAsking(r)
        ? r
        : Option.isNone(inbox)
          ? { status: "refused", line: noInbox(r.entry.say) }
          : {
              status: "asked",
              key: r.entry.key,
              was: r.was,
              now: r.now,
              line:
                asks.length > 1
                  ? `On one card to the Director's phone with the others: ${r.changed}. Nothing changes until he says yes.`
                  : askedLine(r.changed),
            },
    ),
  };
});

/**
 * "Approve them all" or "deny them all", said aloud: answers the newest batch card as his phone would, only in his own
 * verified voice and under the same rule as any yes (a card that needs his device's yes still needs it).
 */
export const answerBatch = Effect.fn("SettingsVoice.answerBatch")(function* (
  answer: "approve" | "deny",
) {
  const origin = yield* TurnOrigin;
  if (origin === null || origin.hisVoice !== true || origin.tainted === true)
    return {
      ok: false,
      line: "Only his own verified voice answers his cards. Nothing was answered.",
    };
  const inbox = yield* Effect.serviceOption(TessayaPhoneInbox);
  const batch = Option.isNone(inbox) ? null : yield* inbox.value.pendingBatch;
  if (Option.isNone(inbox) || batch === null)
    return {
      ok: false,
      line:
        Option.isSome(inbox) && (yield* inbox.value.expiredBatch)
          ? PROMPT_EXPIRED
          : "No batch of changes is waiting for him.",
    };
  const member = origin.member ?? null;
  const assurance = origin.assurance ?? 0;
  // Saying no narrows: his voice may always deny.
  const refusal =
    answer === "deny"
      ? null
      : approvalRefusal({
          risky: batch.needs === "cloud-approve",
          approver: { member, role: "owner", assurance },
        });
  if (refusal !== null) return { ok: false, line: `${refusal} It is still on his phone.` };
  const household = yield* Effect.serviceOption(TessayaHousehold);
  const grants =
    member === null || Option.isNone(household) ? null : yield* household.value.grantsOf(member);
  const took = yield* inbox.value.answerPrompt(
    batch.id,
    answer === "approve" ? batch.yes : batch.cancel,
    {
      member,
      name: grants?.name ?? member ?? "him",
      assurance,
      via: `his voice on ${origin.label}`,
    },
  );
  if (!took) return { ok: false, line: "It was already answered." };
  return {
    ok: true,
    line: `${answer === "approve" ? "Approved" : "Denied"} all: ${batch.title}.`,
  };
});

/** Whether this server reads and changes it itself: its own setting, or its desktop's while that desktop is connected. */
export const settingHere = Effect.fn("SettingsVoice.here")(function* (key: string) {
  const entry = entryOf(key, yield* allSettings);
  if (entry === null) return false;
  if (entry.store === "server") return true;
  const desktop = yield* Effect.serviceOption(TessayaDesktopSettings);
  return Option.isSome(desktop) && (yield* desktop.value.get).connected;
});
