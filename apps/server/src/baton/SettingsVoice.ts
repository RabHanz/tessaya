/**
 * Every setting by voice, in plain words with a safety class (free: at once; confirm and owner: his yes on his phone;
 * never: refused, with why). Typed over the schemas' fields: a setting without a voice path does not compile.
 */
import { type DesktopSettingsControl, DesktopVoiceSettingsPatch } from "@t3tools/tessaya-contracts";
import { ServerSettings, ServerSettingsPatch } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import { ServerSettingsService } from "../serverSettings.ts";
import { BatonDesktopSettings } from "./BatonDesktopSettings.ts";
import { BatonPhoneInbox } from "./BatonPhoneInbox.ts";
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
  companionMotion: free(
    "how much is said and done unprompted: lively, calm, or important only (less chatter)",
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
  const desktop = yield* Effect.serviceOption(BatonDesktopSettings);
  const published = Option.isNone(desktop) ? [] : ((yield* desktop.value.get).controls ?? []);
  return [
    ...SETTINGS,
    ...published.map((c): SettingEntry => ({
      key: `${CONTROL_PREFIX}${c.id}`,
      store: "control",
      say: `${c.section}: ${c.label}${c.hint === undefined ? "" : ` (${c.hint.slice(0, 160)})`}`,
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
      const hay = words(`${s.key} ${s.say}`);
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
/** A control's value as it takes it: true or false for a toggle, one of its options (any case) for a choice. */
const controlValue =
  (key: string, control: DesktopSettingsControl) =>
  (patch: Record<string, unknown>): Option.Option<Record<string, unknown>> => {
    const value = patch[key];
    if (control.options === undefined)
      return typeof value === "boolean" ? Option.some({ [key]: value }) : Option.none();
    const picked = control.options.find(
      (o) => typeof value === "string" && o.toLowerCase() === value.trim().toLowerCase(),
    );
    return picked === undefined ? Option.none() : Option.some({ [key]: picked });
  };
const decodeServer = Schema.decodeUnknownOption(ServerSettingsPatch);
const decodeDesktop = Schema.decodeUnknownOption(DesktopVoiceSettingsPatch);
/** How long his yes on a setting card is waited for. */
const ANSWER_WAIT_MS = 10 * 60_000;

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
  const desktop = yield* Effect.serviceOption(BatonDesktopSettings);
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
    const desktop = yield* Effect.serviceOption(BatonDesktopSettings);
    if (Option.isNone(desktop)) return false;
    yield* desktop.value.setControls([
      { id: entry.control.id, value: (patch as Record<string, string | boolean>)[entry.key]! },
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
  const desktop = yield* Effect.serviceOption(BatonDesktopSettings);
  if (Option.isNone(desktop)) return false;
  yield* desktop.value.set(patch as never);
  return true;
});

export interface SettingSet {
  readonly status: "done" | "asked" | "refused" | "failed";
  readonly line: string;
  readonly key?: string;
  readonly was?: unknown;
  readonly now?: unknown;
}

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
  const changed = `${entry.say}: ${shown(was)} to ${shown(now)}`;
  const desktop = yield* Effect.serviceOption(BatonDesktopSettings);
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
      line:
        entry.class === "free"
          ? `Changed ${changed}. To change it back, set ${entry.key} to ${shown(was)}.`
          : `Sent to the Director's phone for a yes: ${changed}. Nothing changes until he says yes.`,
    } satisfies SettingSet;
  if (entry.class === "free") {
    if (!(yield* apply(entry, patch.value)))
      return {
        status: "failed",
        line: `${entry.say} could not be changed here.`,
      } satisfies SettingSet;
    return {
      status: "done",
      key: entry.key,
      was,
      now,
      line: `Changed ${changed}. To change it back, set ${entry.key} to ${shown(was)}.`,
    } satisfies SettingSet;
  }
  const inbox = yield* Effect.serviceOption(BatonPhoneInbox);
  if (Option.isNone(inbox))
    return {
      status: "refused",
      line: `${entry.say} needs his yes, and nothing here can ask him.`,
    } satisfies SettingSet;
  const id = `setting-${entry.key}-${yield* Clock.currentTimeMillis}`.slice(0, 64);
  yield* inbox.value.mirror({
    id,
    title: "Tessaya wants to change a setting",
    detail: `${changed}. Asked by ${input.who}: "${input.why.slice(0, 200)}".`,
    buttons: ["Yes, change it", "No"],
    yes: 0,
    cancel: 1,
    needs: "cloud-approve",
  });
  // His answer is waited for off the turn: she says it is with him now, and it changes when he says yes.
  yield* inbox.value.promptAnswer(id).pipe(
    Effect.repeat({ schedule: Schedule.spaced("2 seconds"), until: (a) => a !== null }),
    Effect.timeoutOption(`${ANSWER_WAIT_MS} millis`),
    Effect.flatMap((answer) =>
      Option.isSome(answer) && answer.value === 0 ? apply(entry, patch.value) : Effect.void,
    ),
    Effect.ignore,
    Effect.forkDetach,
  );
  return {
    status: "asked",
    key: entry.key,
    was,
    now,
    line: `Sent to the Director's phone for a yes: ${changed}. Nothing changes until he says yes.`,
  } satisfies SettingSet;
});

/** Whether this server reads and changes it itself: its own setting, or its desktop's while that desktop is connected. */
export const settingHere = Effect.fn("SettingsVoice.here")(function* (key: string) {
  const entry = entryOf(key, yield* allSettings);
  if (entry === null) return false;
  if (entry.store === "server") return true;
  const desktop = yield* Effect.serviceOption(BatonDesktopSettings);
  return Option.isSome(desktop) && (yield* desktop.value.get).connected;
});
