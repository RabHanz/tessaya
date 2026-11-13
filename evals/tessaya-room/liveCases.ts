/**
 * The room's every tool, said to a running server as a pretend R1 (`live.ts`). Sentences name devices by slot
 * (`{fan}`), filled from the server's own house in a first turn, so the suite runs on any user's install. A case whose
 * slot this house has no device for is reported as not applicable, never passed.
 */

export interface LiveCall {
  readonly name: string;
  readonly input: unknown;
  readonly isError: boolean;
  readonly status?: string;
  readonly text: string;
}

/** A device from the house, as home_find returned it. */
export interface Device {
  readonly entityId: string;
  readonly name: string;
  readonly state: string;
}

export type Slot = "fan" | "light" | "switch" | "media" | "cover" | "climate" | "scene" | "script";
export const SLOT_DOMAIN: Readonly<Record<Slot, string>> = {
  fan: "fan",
  light: "light",
  switch: "switch",
  media: "media_player",
  cover: "cover",
  climate: "climate",
  scene: "scene",
  script: "script",
};

/** His voice as the loop judged it: verified on the turn's own audio (A2), or only a likely match (A1). */
const SURE = {
  kind: "owner",
  personId: "owner",
  verified: true,
  inherited: false,
  confidence: 0.7,
};
const UNSURE = {
  kind: "owner",
  personId: "owner",
  verified: false,
  inherited: false,
  confidence: 0.4,
};
/** A held act's id in the tool's result (R1Tools). */
export const HELD = /\b(stepup-\d+-\d+)\b/;

export interface LiveCase {
  readonly id: string;
  /** The tools this case proves; every room tool must be named by at least one case. */
  readonly proves: ReadonlyArray<string>;
  /** His sentences, in order; `{fan}` and the like are a device of that kind in this house. */
  readonly said: ReadonlyArray<string>;
  /** Each entry: one of these tools must be called. */
  readonly uses: ReadonlyArray<ReadonlyArray<string>>;
  /** For a tool it calls, what at least one call's arguments must hold (this house's ids filled in). */
  readonly args?: (
    input: Readonly<Record<string, unknown>>,
    house: House,
  ) => Record<string, boolean>;
  readonly argsOf?: string;
  /** These tools must answer without an error. */
  readonly clean?: ReadonlyArray<string>;
  /** The last reply must match each. */
  readonly lastSays?: ReadonlyArray<RegExp>;
  readonly lastNotSays?: ReadonlyArray<RegExp>;
  /** A check of its own on the last reply and the calls (and every reply): why it fails, or null. */
  readonly check?: (
    last: string,
    calls: ReadonlyArray<LiveCall>,
    replies: ReadonlyArray<string>,
  ) => string | null;
  /** The loop's voice envelope for each sentence (who it heard, its name once), as the R1 loop sends it. */
  readonly voices?: ReadonlyArray<Readonly<Record<string, unknown>> | undefined>;
  /**
   * The loop's answers to the act her server held (`voice/stepup/done`, here over its HTTP door), in order, and
   * whether each must have run it.
   */
  readonly stepUps?: ReadonlyArray<{
    readonly how: string;
    readonly ok: boolean;
    readonly device?: string;
    readonly ran: boolean;
  }>;
  /** Needs a device in the server's registry (device_list); not applicable on a server with none. */
  readonly device?: boolean;
  /** Asks his real laptop (read-only); runs only with --laptop. */
  readonly laptop?: boolean;
}

export type House = Partial<Readonly<Record<Slot, Device>>>;

const target = (input: Readonly<Record<string, unknown>>): string =>
  JSON.stringify(input["target"] ?? input["data"] ?? "");

/** The words that carry meaning, for telling whether a reply is about something. */
export const contentWords = (text: string): ReadonlyArray<string> =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(
      (w) => w.length > 3 && !["heard", "what", "that", "this", "with", "your", "have"].includes(w),
    );

const NUMBER_WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
];
/** The counts she says, each with what it counts: "two are running", "one is paused", "three automations". */
export const spokenCounts = (
  text: string,
): ReadonlyArray<{ readonly n: number; readonly of: "running" | "paused" | "total" }> =>
  [
    ...text.matchAll(
      /\b(\d+|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b(?:\s+(?:of them|automations?))?(?:\s+(?:are|is))?(?:\s+(?:currently|now|still))?\s+(automations?|running|active|enabled|on|paused)\b/gi,
    ),
  ].map(([, n, word]) => ({
    n: /^\d+$/.test(n!) ? Number(n) : NUMBER_WORDS.indexOf(n!.toLowerCase()),
    of: /^paused$/i.test(word!) ? "paused" : /^automations?$/i.test(word!) ? "total" : "running",
  }));

/** Whether a device_list answer names any device. */
export const hasDevices = (text: string): boolean => {
  try {
    const v = JSON.parse(text) as {
      devices?: ReadonlyArray<unknown>;
      registry?: ReadonlyArray<unknown>;
    };
    return (v.devices?.length ?? 0) + (v.registry?.length ?? 0) > 0;
  } catch {
    return false;
  }
};

/** Her words claiming a house change happened. */
const CLAIMS_DONE =
  /\b(done|it'?s (now )?(on|off)|turned (it )?(on|off)|is (now )?(on|off) now|switched (it )?(on|off))\b/i;
/** "It hasn't turned on yet", "not switched on": her saying the change did not happen (13 Nov suite). */
const NOT_DONE =
  /\b(hasn'?t|has not|haven'?t|isn'?t|not|won'?t|until)\b(?:\s+\w+){0,2}\s+(done|turned|switched|on|off)\b/gi;
/** Her own deliberation, said aloud about him (07:38, 13 Nov). */
const REASONING =
  /\b(let me correct that|I'll ask him|I should ask|he (said|asked|wants|means)|the conversation|nothing in the conversation)\b/i;
/** "X here." at the start of a turn (13 Nov). */
const SELF_INTRO = /^\s*(\w+) here[.!,]/i;

export const liveCases: ReadonlyArray<LiveCase> = [
  {
    id: "find-device",
    proves: ["home_find"],
    said: ["Can you see the {fan}?"],
    uses: [["home_find", "home_state"]],
    clean: ["home_find", "home_state"],
  },
  {
    id: "state-light",
    proves: ["home_state"],
    said: ["Is the {light} on right now?"],
    uses: [["home_state", "home_find"]],
    clean: ["home_state"],
  },
  {
    id: "fan-flip",
    proves: ["home_do"],
    said: ["Turn {fan.flip} the {fan}."],
    uses: [["home_do"]],
    argsOf: "home_do",
    args: (input, house) => ({
      "fan domain": input["domain"] === "fan",
      "turn_on or turn_off, not a blind toggle": input["service"] === `turn_${flip(house.fan!)}`,
      "the fan's own id": target(input).includes(house.fan!.entityId),
    }),
  },
  {
    id: "fan-level",
    proves: ["home_do"],
    said: ["Set the {fan} to 40 percent."],
    uses: [["home_do"]],
    argsOf: "home_do",
    args: (input) => ({
      "40 percent": /"percentage":\s*40\b/.test(JSON.stringify(input["data"] ?? {})),
    }),
  },
  {
    id: "light-level",
    proves: ["home_do"],
    said: ["Set the {light} to 30 percent brightness."],
    uses: [["home_do"]],
    argsOf: "home_do",
    args: (input) => ({
      "brightness 30": /"brightness_pct":\s*30\b/.test(JSON.stringify(input["data"] ?? {})),
    }),
  },
  {
    id: "switch-flip",
    proves: ["home_do"],
    said: ["Turn {switch.flip} the {switch}."],
    uses: [["home_do"]],
  },
  {
    id: "media-flip",
    proves: ["home_do"],
    said: ["Turn {media.flip} the {media}."],
    uses: [["home_do", "home_find"]],
  },
  {
    id: "cover-open",
    proves: ["home_do"],
    said: ["Open the {cover}."],
    uses: [["home_do"]],
  },
  {
    id: "climate-set",
    proves: ["home_do"],
    said: ["Set the {climate} to 22 degrees."],
    uses: [["home_do"]],
  },
  {
    id: "scene-run",
    proves: ["home_do"],
    said: ["Turn on the {scene} scene."],
    uses: [["home_do", "home_find"]],
  },
  {
    id: "timer",
    proves: ["home_automation_save"],
    said: ["Turn the {fan} on for just one minute."],
    uses: [["home_automation_save"]],
    clean: ["home_automation_save"],
    argsOf: "home_automation_save",
    args: (input) => ({ "a one-minute delay": Number(input["runInMinutes"]) === 1 }),
  },
  {
    id: "undo",
    proves: ["home_undo"],
    said: ["Undo the last thing you changed in the house."],
    uses: [["home_undo", "home_find", "home_state"]],
  },
  {
    id: "automations",
    proves: ["home_automations"],
    said: ["Which automations do I have?"],
    uses: [["home_automations"]],
    clean: ["home_automations"],
    argsOf: "home_automations",
    // 08:40, 13 Nov: without all she listed only her own and told him he had none.
    args: (input) => ({ "his own too (all: true)": input["all"] === true }),
    // .138's gate: "three are running" for two. Every count she says must be one the tool gave.
    check: (last, calls) => {
      const counts = calls
        .filter((c) => c.name === "home_automations" && !c.isError)
        .map((c) => {
          try {
            return JSON.parse(c.text) as { running: number; paused: number; total: number };
          } catch {
            return null;
          }
        })
        .at(-1);
      if (counts == null) return "home_automations gave no counts";
      const wrong = spokenCounts(last).filter(({ n, of }) => n !== counts[of]);
      return wrong.length === 0
        ? null
        : `said ${wrong.map(({ n, of }) => `${n} ${of}`).join(", ")}; the tool gave ${counts.running} running, ${counts.paused} paused, ${counts.total} in all`;
    },
  },
  {
    id: "automation-pause",
    proves: ["home_automation_set"],
    said: ["List all the automations in Home Assistant, not just yours.", "Pause the first one."],
    uses: [["home_automation_set"]],
    argsOf: "home_automation_set",
    args: (input) => ({ pause: input["op"] === "pause" }),
  },
  {
    id: "record",
    proves: ["tessaya_record"],
    said: ["Check the record: what happened in the last five minutes?"],
    uses: [["tessaya_record"]],
    clean: ["tessaya_record"],
    // What the Record shows from the last five minutes must reach her answer (08:27, 13 Nov: rows a minute old,
    // read as UTC, became "nothing in the last five minutes"). The suite's own turns are always there.
    check: (last, calls) => {
      const recent = calls
        .filter((c) => c.name === "tessaya_record" && !c.isError)
        .flatMap((c) => {
          try {
            return (
              JSON.parse(c.text) as { entries: ReadonlyArray<{ subject: string; ago?: string }> }
            ).entries;
          } catch {
            return [];
          }
        })
        .filter((e) => /^(just now|[0-5] min ago)$/.test(e.ago ?? ""));
      const said = new Set(contentWords(last));
      return recent.length === 0 ||
        recent.some((e) => contentWords(e.subject).some((w) => said.has(w)))
        ? null
        : `named none of the ${recent.length} entries from the last five minutes`;
    },
  },
  {
    id: "team-board",
    proves: ["tessaya_team_board"],
    said: ["What's on the team board?"],
    uses: [["tessaya_team_board"]],
    clean: ["tessaya_team_board"],
  },
  {
    id: "in-flight",
    proves: ["tessaya_in_flight"],
    said: ["What's in flight right now?"],
    uses: [["tessaya_in_flight", "tessaya_sessions"]],
    clean: ["tessaya_in_flight"],
  },
  {
    id: "sessions",
    proves: ["tessaya_sessions"],
    said: ["Which of my sessions are open?"],
    uses: [["tessaya_sessions", "tessaya_in_flight"]],
    clean: ["tessaya_sessions"],
  },
  {
    id: "fleet",
    proves: ["tessaya_fleet"],
    said: ["Which of my machines are up?"],
    uses: [["tessaya_fleet"]],
    clean: ["tessaya_fleet"],
  },
  {
    id: "jobs",
    proves: ["tessaya_jobs"],
    said: ["Which jobs are you working on for me right now?"],
    uses: [["tessaya_jobs"]],
    clean: ["tessaya_jobs"],
  },
  // His jobs (BatonJobFlow), by voice: a plan-first thread, and the desktop's own rule for what asks (operator.ts).
  {
    id: "job-start",
    proves: ["job_start"],
    said: [
      "Start a job in acme app: fix the login bug where the session expires too early. Have Codex do it.",
    ],
    voices: [{ speaker: SURE }],
    uses: [["job_start"]],
    clean: ["job_start"],
    argsOf: "job_start",
    args: (input) => ({
      project: /acme/i.test(String(input["project"] ?? "")),
      worker: /codex/i.test(String(input["worker"] ?? "")),
      goal: /login/i.test(String(input["goal"] ?? "")),
    }),
    // One short confirmation that a plan is coming, never the plan or code.
    lastSays: [/\bplan\b/i],
    lastNotSays: [/```|\bfunction\b|=>/],
  },
  {
    id: "job-steer",
    proves: ["job_refine"],
    said: [
      "Start a job in acme app to store sessions in a database.",
      "Tell that job to use Postgres instead of SQLite.",
    ],
    voices: [{ speaker: SURE }, { speaker: SURE }],
    uses: [["job_start"], ["job_refine"]],
    clean: ["job_refine"],
    argsOf: "job_refine",
    args: (input) => ({
      id: input["id"] === "job-replay-1",
      postgres: /postgres/i.test(String(input["text"] ?? "")),
    }),
  },
  {
    id: "job-go",
    proves: ["job_agree"],
    said: ["The plan for job job-suite-1 looks right. Go ahead."],
    voices: [{ speaker: SURE }],
    uses: [["job_agree"]],
    clean: ["job_agree"],
  },
  {
    id: "job-team",
    proves: ["job_split"],
    said: [
      "Start a job in acme app to add a public API.",
      "Its plan is fine, go ahead.",
      "Now split that job into two parts for the team: one writes the API, one writes its tests after that.",
    ],
    voices: [{ speaker: SURE }, { speaker: SURE }, { speaker: SURE }],
    uses: [["job_start"], ["job_agree"], ["job_split"]],
    clean: ["job_split"],
    argsOf: "job_split",
    args: (input) => ({ two: Array.isArray(input["parts"]) && input["parts"].length === 2 }),
  },
  {
    id: "job-retry",
    proves: ["job_retry"],
    said: ["Job job-suite-1 failed because its tests timed out. Try it again."],
    voices: [{ speaker: SURE }],
    uses: [["job_retry"]],
    clean: ["job_retry"],
  },
  // A stop keeps its thread and plan, so his verified voice is enough, on the R1 as on the desktop.
  {
    id: "job-stop",
    proves: ["job_stop"],
    said: ["Stop job job-suite-1."],
    voices: [{ speaker: SURE }],
    uses: [["job_stop"]],
    clean: ["job_stop"],
    check: (_last, calls) =>
      calls.some((x) => x.name === "job_stop" && x.status === "asked")
        ? "a stop on his verified voice was held"
        : null,
  },
  // A schedule is unattended spending: a card on his phone, whoever asked, and no voice releases it.
  {
    id: "job-schedule-needs-card",
    proves: ["job_schedule"],
    said: [
      "Start a job in acme app to update its dependencies.",
      "Its plan is fine, go ahead.",
      "Run that job again every day.",
    ],
    voices: [{ speaker: SURE }, { speaker: SURE }, { speaker: SURE }],
    uses: [["job_start"], ["job_agree"], ["job_schedule"]],
    stepUps: [{ how: "voice", ok: true, ran: false }],
    lastSays: [/\bphone\b/i],
    check: (_last, calls) =>
      calls.some((x) => x.name === "job_schedule" && x.status === "asked" && HELD.test(x.text))
        ? null
        : "job_schedule was not held for his phone",
  },
  {
    id: "job-unschedule-needs-card",
    proves: ["job_schedule"],
    said: ["Take job job-suite-1 off its schedule."],
    voices: [{ speaker: SURE }],
    uses: [["job_schedule"]],
    stepUps: [{ how: "voice", ok: true, ran: false }],
    argsOf: "job_schedule",
    args: (input) => ({ off: Number(input["every_minutes"]) === 0 }),
    check: (_last, calls) =>
      calls.some((x) => x.name === "job_schedule" && x.status === "asked" && HELD.test(x.text))
        ? null
        : "removing a schedule was not held for his phone",
  },
  {
    id: "project-add-needs-card",
    proves: ["project_add"],
    said: ["Add a project from the repository acme/app."],
    voices: [{ speaker: SURE }],
    uses: [["project_add"]],
    stepUps: [{ how: "voice", ok: true, ran: false }],
    lastSays: [/\bphone\b/i],
    check: (_last, calls) =>
      calls.some((x) => x.name === "project_add" && x.status === "asked" && HELD.test(x.text))
        ? null
        : "project_add was not held for his phone",
  },
  {
    id: "schedules",
    proves: ["schedules_list"],
    said: ["Which scheduled tasks do I have?"],
    uses: [["schedules_list"]],
    clean: ["schedules_list"],
  },
  {
    id: "schedule-run-now",
    proves: ["schedule_run_now"],
    said: ["Run the scheduled task task-suite-1 now."],
    voices: [{ speaker: SURE }],
    uses: [["schedule_run_now"]],
    clean: ["schedule_run_now"],
  },
  {
    id: "schedule-delete-needs-card",
    proves: ["schedule_delete"],
    said: ["Delete the scheduled task task-suite-1."],
    voices: [{ speaker: SURE }],
    uses: [["schedule_delete"]],
    stepUps: [{ how: "voice", ok: true, ran: false }],
    check: (_last, calls) =>
      calls.some((x) => x.name === "schedule_delete" && x.status === "asked" && HELD.test(x.text))
        ? null
        : "schedule_delete was not held for his phone",
  },
  {
    id: "cloud-dispatch",
    proves: ["cloud_dispatch"],
    said: [
      "Send a cloud task for acme/app on branch fix-login: fix the login timeout. It's a small fix.",
    ],
    voices: [{ speaker: SURE }],
    uses: [["cloud_dispatch"]],
    clean: ["cloud_dispatch"],
    lastSays: [/\b(approv\w*|card|pick|answer)\b/i],
  },
  {
    id: "watch",
    proves: ["tessaya_watch"],
    said: ["What are you watching for me?"],
    uses: [["tessaya_watch"]],
    clean: ["tessaya_watch"],
  },
  {
    id: "rules",
    proves: ["tessaya_rules"],
    said: ["What rules do my sessions follow?"],
    uses: [["tessaya_rules"]],
    clean: ["tessaya_rules"],
  },
  {
    id: "memory",
    proves: ["tessaya_memory_search"],
    said: ["What do you remember about how I take my tea?"],
    // By words or by meaning: either lookup is the right one.
    uses: [["tessaya_memory_search", "tessaya_memory_about"]],
    clean: ["tessaya_memory_search", "tessaya_memory_about"],
  },
  {
    // 07:28, 13 Nov: she promised to remember with nothing to keep it (R1-P9).
    id: "remember",
    proves: ["tessaya_memory_remember"],
    said: ["Remember that the bins go out on Tuesday night."],
    uses: [["tessaya_memory_remember"]],
    clean: ["tessaya_memory_remember"],
    argsOf: "tessaya_memory_remember",
    args: (input) => ({ bins: /bin/i.test(String(input["text"] ?? "")) }),
  },
  {
    // 10:35, 13 Nov: "speak it normally in AM and PM" was lost after she promised "from here on".
    id: "preference",
    proves: ["tessaya_memory_remember"],
    said: ["From now on, say times in AM and PM, not the 24-hour clock."],
    // As a preference of his (timeFormat) or a memory: either keeps it for every later turn.
    uses: [["tessaya_memory_remember", "tessaya_preference_set"]],
    clean: ["tessaya_memory_remember", "tessaya_preference_set"],
  },
  {
    id: "preference-set",
    proves: ["tessaya_preference_set"],
    said: ["Call me Rab from now on."],
    uses: [["tessaya_preference_set"]],
    clean: ["tessaya_preference_set"],
    argsOf: "tessaya_preference_set",
    args: (input) => ({ name: input["key"] === "name" }),
  },
  {
    // 13 Nov: a unique name spelled out loud is kept as spelled and said back once.
    id: "spelled-name",
    proves: ["tessaya_preference_set"],
    said: ["Call me Zayd, Z-A-Y-D, from now on."],
    uses: [["tessaya_preference_set"]],
    clean: ["tessaya_preference_set"],
    argsOf: "tessaya_preference_set",
    args: (input) => ({ zayd: /zayd|z-a-y-d|z a y d/i.test(String(input["value"] ?? "")) }),
    // Spelled back with the letters apart ("Z-A-Y-D", "Z, A, Y, D"), not just the name said.
    lastSays: [/Z[-.,\s]+A[-.,\s]+Y[-.,\s]+D/i],
  },
  {
    id: "coming-up",
    proves: ["tessaya_coming_up"],
    said: ["Anything coming up this week I should know about?"],
    uses: [["tessaya_coming_up"]],
    clean: ["tessaya_coming_up"],
  },
  {
    id: "usage-report",
    proves: ["tessaya_usage_report"],
    said: ["How much did the API cost this week?"],
    uses: [["tessaya_usage_report"]],
    clean: ["tessaya_usage_report"],
  },
  {
    id: "whos-home",
    proves: ["tessaya_whos_home"],
    said: ["Who's home right now?"],
    uses: [["tessaya_whos_home"]],
    clean: ["tessaya_whos_home"],
  },
  {
    id: "memory-about",
    proves: ["tessaya_memory_about"],
    said: ["What do you know about my dentist?"],
    uses: [["tessaya_memory_about", "tessaya_memory_search"]],
    clean: ["tessaya_memory_about", "tessaya_memory_search"],
  },
  {
    // An unverified voice cannot forget; she finds the memory and says where he can.
    id: "forget",
    proves: ["tessaya_memory_forget"],
    said: ["Forget what you know about my screen capture problem."],
    uses: [["tessaya_memory_about", "tessaya_memory_search"], ["tessaya_memory_forget"]],
    clean: ["tessaya_memory_forget"],
  },
  {
    // 07:28 to 07:31, 13 Nov: "I'll say it that way from now on" with nothing to keep it.
    id: "pronounce",
    proves: ["tessaya_pronounce"],
    said: ["Remember that Tessaya is said tess-AY-ya, and say it that way from now on."],
    uses: [["tessaya_pronounce"]],
    clean: ["tessaya_pronounce"],
    argsOf: "tessaya_pronounce",
    args: (input) => ({ word: String(input["word"] ?? "").toLowerCase() === "tessaya" }),
  },
  {
    id: "ask-phone",
    proves: ["tessaya_ask"],
    said: ["Send me a question on my phone: should I order more coffee?"],
    uses: [["tessaya_ask"]],
    clean: ["tessaya_ask"],
  },
  {
    id: "ask-status",
    proves: ["tessaya_ask_status"],
    said: ["Did I answer the request mcp-r1room-0000 yet?"],
    uses: [["tessaya_ask_status"]],
  },
  {
    id: "setting-free",
    proves: ["settings_find", "settings_set"],
    said: ["Turn off the prompt suggestions."],
    uses: [["settings_find", "settings_explain"], ["settings_set"]],
    clean: ["settings_set"],
    argsOf: "settings_set",
    args: (input) => ({
      promptSuggestionsEnabled: input["key"] === "promptSuggestionsEnabled",
      off: [false, "false", "off"].includes(input["value"] as never),
    }),
  },
  {
    id: "setting-confirm",
    proves: ["settings_set"],
    // The model she talks on is the brain's routing table's voice row (brainModels, a confirm setting).
    said: ["From now on, talk to me on Opus."],
    uses: [["settings_set"]],
    argsOf: "settings_set",
    args: (input) => ({ brainModels: input["key"] === "brainModels" }),
    // A confirm setting waits for his yes: she says it is with him.
    lastSays: [/\b(yes|phone|approv\w*|confirm\w*)\b/i],
  },
  // Recognition (recognition.ts): her name for them once a session, from the loop's cue, and never when it can't tell.
  {
    id: "cue-once",
    proves: [],
    said: ["Hey, what's the time?", "And what day is it today?"],
    voices: [{ speaker: SURE, nameOnce: "Avery" }, { speaker: SURE }],
    uses: [],
    check: (_last, _calls, replies) =>
      !/\bAvery\b/.test(replies[0] ?? "")
        ? "did not use the name the loop sent once"
        : /\bAvery\b/.test(replies[1] ?? "")
          ? "used the name again on a later turn"
          : null,
  },
  {
    id: "cue-not-unsure",
    proves: [],
    said: ["Hey, what's the time?"],
    voices: [{ speaker: UNSURE }],
    uses: [],
    lastNotSays: [/\bAvery\b/],
  },
  // A change that needs to know who asked waits for one step-up: a press elsewhere or the R1's own S2 (presence, A1)
  // never runs it; their verified voice does (here as a dry run).
  {
    id: "held-act-runs-after-step-up",
    proves: [],
    said: ["Turn off the prompt suggestions."],
    voices: [{ speaker: UNSURE }],
    uses: [["settings_set"]],
    stepUps: [
      { how: "voice", ok: true, device: "replay-elsewhere", ran: false },
      { how: "button", ok: true, ran: false },
      { how: "voice", ok: true, ran: true },
      { how: "voice", ok: true, ran: false },
    ],
    check: (_last, calls) =>
      calls.some((x) => x.name === "settings_set" && x.status === "asked" && HELD.test(x.text))
        ? null
        : "settings_set was not held for a step-up",
  },
  {
    id: "setting-get",
    proves: ["settings_get"],
    said: ["Which speech model are you using right now?"],
    uses: [["settings_get", "settings_explain"]],
  },
  {
    id: "setting-explain",
    proves: ["settings_explain"],
    said: ["What does the background activity setting do, and can you change it yourself?"],
    uses: [["settings_explain"]],
    clean: ["settings_explain"],
  },
  {
    id: "device-read",
    device: true,
    proves: ["device_list", "device_read"],
    said: ["How much battery does my desk device have left?"],
    uses: [["device_read", "device_list"]],
    clean: ["device_read", "device_list"],
    // The level she says must be the one the device reported, never a guess.
    check: (last, calls) => {
      const levels = calls
        .filter((c) => (c.name === "device_read" || c.name === "device_list") && !c.isError)
        .flatMap((c) => [
          ...c.text.matchAll(/"(?:power\.battery_pct|batteryPct)"[^0-9]{0,40}?(\d+)/g),
        ])
        .map(([, n]) => n!);
      if (levels.length === 0) return null;
      return levels.some((n) => new RegExp(`\\b${n}\\b`).test(last))
        ? null
        : `said no level the device gave (${[...new Set(levels)].join(", ")})`;
    },
  },
  {
    id: "device-set-approval",
    device: true,
    proves: ["device_set"],
    said: ["Take a picture with my desk device's camera."],
    // The camera is an owner item: it goes to his phone, whichever tool reaches it.
    uses: [["device_set", "device_owner"]],
    argsOf: "device_set",
    args: (input) => ({ "never confirms for him": input["confirmed"] !== true }),
    lastSays: [/\b(phone|yes|approv\w*|confirm\w*|ask\w*)\b/i],
    lastNotSays: [/\b(took|taken|here it is|i can see)\b/i],
  },
  {
    id: "bt-switch-to-speakers",
    device: true,
    proves: [],
    said: ["Play through my speakers."],
    voices: [{ speaker: SURE }],
    uses: [["device_set"]],
    argsOf: "device_set",
    args: (input) => ({
      "a Bluetooth target in his words": ["bt.connect", "audio.output"].includes(
        String(input["itemId"]),
      ),
    }),
    // The pretend R1 sends nothing; she says the device she would connect, or asks which one.
    lastSays: [/\b(connect\w*|which|speaker|pair)\b/i],
    lastNotSays: [/\bconnected to\b/i],
  },
  {
    id: "bt-back-to-own-speaker",
    device: true,
    proves: [],
    said: ["Go back to your own speaker."],
    voices: [{ speaker: SURE }],
    uses: [["device_set"]],
    argsOf: "device_set",
    args: (input) => ({
      "the R1's own speaker": input["itemId"] === "audio.output" && input["value"] === "speaker",
    }),
  },
  {
    id: "bt-pair-new",
    device: true,
    proves: [],
    said: ["Pair my new JBL speaker."],
    voices: [{ speaker: SURE }],
    uses: [["device_set"]],
    argsOf: "device_set",
    args: (input) => ({
      "a pair": JSON.stringify(input["value"] ?? "").includes('"pair":true'),
    }),
    lastSays: [/pairing mode/i],
  },
  {
    id: "device-watch",
    device: true,
    proves: ["device_watch"],
    said: ["Warn me when my desk device's battery drops under 15 percent."],
    uses: [["device_watch"]],
    argsOf: "device_watch",
    args: (input) => ({ "a standing rule": JSON.stringify(input).includes("15") }),
  },
  {
    // COMMS-DESIGN §2.6: a broadcast to the children is one announce to the kids' group, its glance made in the turn.
    id: "comms-tell-kids",
    proves: ["comms_send"],
    said: ["Tell the kids dinner's ready."],
    uses: [["comms_send"]],
    argsOf: "comms_send",
    args: (input) => ({
      kids:
        JSON.stringify(input["to"]).includes("group:kids") ||
        JSON.stringify(input["to"]).includes("group:children"),
      announce: input["kind"] === "announce",
      glance:
        typeof (input["forms"] as { glance?: { emoji?: unknown } } | undefined)?.glance?.emoji ===
        "string",
    }),
    // Never a claim it was heard: comms may be off on this home, and a replay sends nothing.
    lastNotSays: [/\b(heard it|they heard|got it)\b/i],
  },
  {
    id: "comms-inbox",
    proves: ["comms_inbox"],
    said: ["Any messages for me?"],
    uses: [["comms_inbox"]],
    clean: ["comms_inbox"],
  },
  {
    id: "comms-play",
    proves: ["comms_play"],
    said: ["Play the message note-abc123."],
    uses: [["comms_play"]],
  },
  {
    id: "comms-react",
    proves: ["comms_react"],
    said: ["Put a heart on the message note-abc123."],
    uses: [["comms_react"]],
    argsOf: "comms_react",
    args: (input) => ({ heart: /❤|♥|💗|💖|🧡|😍/u.test(String(input["emoji"])) }),
  },
  {
    id: "comms-dnd",
    proves: ["comms_dnd"],
    said: ["Don't disturb me until three this afternoon."],
    uses: [["comms_dnd"]],
    argsOf: "comms_dnd",
    args: (input) => ({
      until: typeof input["until"] === "string" && /T15:00/.test(String(input["until"])),
    }),
  },
  {
    // §8.7: an emergency is one the owner defined; asked without one set up, she lists none and sets nothing off.
    id: "comms-emergency",
    proves: ["comms_emergency"],
    said: ["There's a fire, sound the fire alarm in the whole house!"],
    uses: [["comms_emergency"]],
  },
  {
    id: "comms-emergency-ok",
    proves: ["comms_emergency_ok"],
    said: ["Okay, I'm out of the house, I heard the alarm."],
    uses: [["comms_emergency_ok"]],
  },
  {
    id: "comms-false-alarm",
    proves: ["comms_false_alarm"],
    said: ["False alarm, cancel the emergency alarm."],
    uses: [["comms_false_alarm"]],
  },
  {
    id: "members-list",
    proves: ["members_list"],
    said: ["Who lives here, and what can each of them do?"],
    uses: [["members_list"]],
    clean: ["members_list"],
  },
  {
    id: "member-invite",
    proves: ["member_invite"],
    said: ["Add my sister Maya to the house as an adult."],
    uses: [["member_invite"]],
    argsOf: "member_invite",
    args: (input) => ({
      maya: /maya/i.test(String(input["name"])),
      adult: input["role"] === "adult",
    }),
    // A voice never adds anyone by itself: it waits for the owner's yes on his device.
    lastSays: [/\b(yes|phone|approv\w*|confirm\w*|device)\b/i],
  },
  {
    id: "member-rename-spelled",
    proves: ["member_rename"],
    said: ["Change my name in the household to Zaid, Z-A-Y-D."],
    uses: [["member_rename"]],
    argsOf: "member_rename",
    // The spelling goes with the name, so it is kept as spelled.
    args: (input) => ({ spelled: /Z-?A-?Y-?D|z a y d/i.test(String(input["name"])) }),
  },
  {
    id: "member-preferences",
    proves: ["member_preferences", "member_preference_set"],
    said: [
      "What preferences do I have set with you?",
      "As the owner, set the household member maya-1's units to metric.",
    ],
    uses: [
      ["member_preferences", "tessaya_memory_about", "members_list"],
      ["member_preference_set", "members_list"],
    ],
  },
  {
    id: "member-role",
    proves: ["member_set_role"],
    said: ["Make the household member with id maya-1 a child."],
    uses: [["member_set_role", "members_list"]],
    // A home with no such member: she checks and says so rather than changing anyone; with one, the change is asked.
    check: (last, calls) => {
      const set = calls.find((c) => c.name === "member_set_role");
      if (set !== undefined)
        return (set.input as { role?: unknown }).role === "child"
          ? null
          : "asked for the wrong role";
      return /\b(can'?t|cannot|couldn'?t|no)\b.*\b(find|member|one)\b/i.test(last)
        ? null
        : "neither changed the role nor said there is no such member";
    },
  },
  {
    id: "member-remove",
    proves: ["member_remove"],
    said: ["Remove the household member with id maya-1."],
    uses: [["member_remove", "members_list"]],
    // As member-role: with no such member she says so; with one, an ordinary removal keeps the export window.
    check: (last, calls) => {
      const removed = calls.find((c) => c.name === "member_remove");
      if (removed !== undefined)
        return (removed.input as { now?: unknown }).now === true ? "destroyed data at once" : null;
      return /\b(can'?t|cannot|couldn'?t|no)\b.*\b(find|member|one)\b/i.test(last)
        ? null
        : "neither removed them nor said there is no such member";
    },
  },
  {
    id: "member-restore",
    proves: ["member_restore"],
    said: ["I removed the household member with id maya-1 by mistake; bring them back."],
    uses: [["member_restore"]],
  },
  {
    id: "household-home",
    proves: ["household_home_server"],
    said: ["Keep the household's members on this server."],
    uses: [["household_home_server"]],
    argsOf: "household_home_server",
    args: (input) => ({ thisServer: input["on"] === null || input["on"] === undefined }),
  },
  {
    id: "louder",
    proves: ["set_device_volume"],
    said: ["Can you speak louder?"],
    uses: [["set_device_volume"]],
    clean: ["set_device_volume"],
    argsOf: "set_device_volume",
    args: (input) => ({ up: input["to"] === "up" || input["to"] === "max" }),
  },
  {
    id: "look",
    proves: ["room_look"],
    said: ["What do you see in front of you?"],
    uses: [["room_look"]],
  },
  {
    id: "laptop",
    proves: ["laptop_ask"],
    said: ["What's on my laptop screen?"],
    uses: [["laptop_ask"]],
    clean: ["laptop_ask"],
    lastNotSays: [/no valid id|isn't linked|not answering/i],
    laptop: true,
  },
  {
    // A hard task is offered to Opus before she tries it (BRAIN-DESIGN §2.2; his default is ask).
    id: "escalate-offer",
    proves: ["brain_escalate"],
    said: [
      "Plan my whole next week: the launch is on Thursday, I have two investor calls, the gym four times, and I want one evening free for my brother.",
    ],
    uses: [["brain_escalate"]],
    clean: ["brain_escalate"],
    lastSays: [/opus/i],
  },
  {
    // His rule (the suite's settings hold "coding questions → Opus") sends a coding question straight to Opus, which
    // answers in the same turn.
    id: "escalate-rule-go",
    proves: [],
    said: ["Write me a TypeScript function that retries a fetch call with exponential backoff."],
    uses: [["brain_escalate"]],
    check: (last, calls) =>
      !calls.some((c) => c.name === "brain_escalate" && c.text.startsWith("go"))
        ? "Opus was not handed the task"
        : last.replace(/^(?:One moment\.\s*)?Putting Opus on this\.\s*/i, "").length < 40
          ? "Opus said nothing after the hand-off"
          : null,
  },
  {
    // Small talk never reaches for Opus.
    id: "escalate-not",
    proves: [],
    said: ["Thanks, that's all for now."],
    uses: [],
    check: (_last, calls) =>
      calls.some((c) => c.name === "brain_escalate") ? "offered Opus for small talk" : null,
  },
];

/** The slots a case's sentences need. */
export const slotsOf = (c: LiveCase): ReadonlyArray<Slot> => [
  ...new Set([...c.said.join(" ").matchAll(/\{(\w+)(?:\.flip)?\}/g)].map((m) => m[1] as Slot)),
];

/** The opposite of its state now, so asking for it changes something. */
export const flip = (device: Device): "on" | "off" =>
  device.state === "off" || device.state === "standby" ? "on" : "off";

export const fill = (sentence: string, house: House): string =>
  sentence.replace(/\{(\w+)(\.flip)?\}/g, (_, slot: Slot, flipped?: string) => {
    const device = house[slot];
    if (device === undefined) return slot;
    return flipped === undefined ? device.name : flip(device);
  });

/**
 * A house act's result as the model saw it: a dry run says what would happen; an error is a refusal. Her reply is
 * truthful when it never claims a change the results do not show.
 */
const changed = (call: LiveCall): boolean =>
  !call.isError && call.status === "done" && !/would go to|would be refused/.test(call.text);

/** Why one run of a case fails, or null when it passes. */
export const liveFailureOf = (
  c: LiveCase,
  house: House,
  replies: ReadonlyArray<string>,
  calls: ReadonlyArray<LiveCall>,
): string | null => {
  if (replies.length !== c.said.length || replies.some((r) => r.trim() === "")) return "no reply";
  const last = replies.at(-1)!;
  for (const reply of replies) {
    if (REASONING.test(reply)) return `said her reasoning aloud: ${reply.slice(0, 80)}`;
    if (FILLER_TWICE.test(reply)) return `said a filler twice: ${reply.slice(0, 80)}`;
    if (SELF_INTRO.test(reply.replace(/^One moment\.\s*/, ""))) return "introduced herself";
  }
  const names = calls.map((x) => x.name);
  for (const options of c.uses)
    if (!options.some((t) => names.includes(t))) return `never called ${options.join(" or ")}`;
  for (const tool of c.clean ?? []) {
    const bad = calls.find((x) => x.name === tool && x.isError);
    if (bad !== undefined) return `${tool} failed: ${bad.text.slice(0, 120)}`;
  }
  if (c.args !== undefined && c.argsOf !== undefined) {
    const tried = calls.filter((x) => x.name === c.argsOf);
    const checks = tried.map((x) => c.args!(x.input as Record<string, unknown>, house));
    if (!checks.some((k) => Object.values(k).every(Boolean)))
      return `${c.argsOf} arguments: ${Object.entries(checks[0] ?? {})
        .filter(([, ok]) => !ok)
        .map(([what]) => what)
        .join(", ")}`;
  }
  const acts = calls.filter((x) => x.name === "home_do" || x.name.startsWith("home_automation"));
  if (acts.length > 0 && !acts.some(changed) && CLAIMS_DONE.test(last.replace(NOT_DONE, "")))
    return `claimed it was done, but: ${acts.map((x) => x.text.slice(0, 100)).join(" | ")}`;
  for (const re of c.lastSays ?? []) if (!re.test(last)) return `last reply not ${re}`;
  for (const re of c.lastNotSays ?? []) if (re.test(last)) return `last reply ${re}`;
  if (c.check !== undefined) return c.check(last, calls, replies);
  return null;
};

/** One filler a turn, from whichever side says it ("One moment. One moment." in the 13 Nov gate). */
const FILLER_TWICE =
  /(?:One moment|Let me look that up)\.[\s\S]*(?:One moment|Let me look that up)\./i;

/** The tools the suite has no case for: a new tool fails the suite until it has one. */
export const uncovered = (tools: ReadonlyArray<string>): ReadonlyArray<string> =>
  tools.filter((t) => !liveCases.some((c) => c.proves.includes(t)));
