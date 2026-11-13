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
  /** A check of its own on the last reply and the calls: why it fails, or null. */
  readonly check?: (last: string, calls: ReadonlyArray<LiveCall>) => string | null;
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
    uses: [["tessaya_memory_remember"]],
    clean: ["tessaya_memory_remember"],
    argsOf: "tessaya_memory_remember",
    args: (input) => ({ ampm: /\b(am|pm|a\.m\.|p\.m\.)/i.test(String(input["text"] ?? "")) }),
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
    id: "device-watch",
    device: true,
    proves: ["device_watch"],
    said: ["Warn me when my desk device's battery drops under 15 percent."],
    uses: [["device_watch"]],
    argsOf: "device_watch",
    args: (input) => ({ "a standing rule": JSON.stringify(input).includes("15") }),
  },
  {
    id: "members-list",
    proves: ["members_list"],
    said: ["Who lives here, and what can each of them do?"],
    uses: [["members_list"]],
    clean: ["members_list"],
  },
  {
    id: "members-home",
    proves: ["members_home"],
    said: ["Who's home right now?"],
    uses: [["members_home"]],
    clean: ["members_home"],
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
    uses: [["member_remove"]],
    argsOf: "member_remove",
    // Only a safety case destroys data at once; an ordinary removal keeps the export window.
    args: (input) => ({ keepsWindow: input["now"] !== true }),
  },
  {
    id: "member-restore",
    proves: ["member_restore"],
    said: ["I removed the household member with id maya-1 by mistake; bring them back."],
    uses: [["member_restore"]],
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
  if (acts.length > 0 && !acts.some(changed) && CLAIMS_DONE.test(last))
    return `claimed it was done, but: ${acts.map((x) => x.text.slice(0, 100)).join(" | ")}`;
  for (const re of c.lastSays ?? []) if (!re.test(last)) return `last reply not ${re}`;
  for (const re of c.lastNotSays ?? []) if (re.test(last)) return `last reply ${re}`;
  if (c.check !== undefined) return c.check(last, calls);
  return null;
};

/** The tools the suite has no case for: a new tool fails the suite until it has one. */
export const uncovered = (tools: ReadonlyArray<string>): ReadonlyArray<string> =>
  tools.filter((t) => !liveCases.some((c) => c.proves.includes(t)));
