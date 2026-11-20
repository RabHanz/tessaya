// @effect-diagnostics globalDate:off
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
  /** Needs a device in the server's registry (device_registry); not applicable on a server with none. */
  readonly device?: boolean;
  /** Asks his real laptop (read-only); runs only with --laptop. */
  readonly laptop?: boolean;
  /** Judged after the turn: why the house gave this case nothing to act on (not applicable), or null. */
  readonly nothingToActOn?: (calls: ReadonlyArray<LiveCall>) => string | null;
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

/** Whether a device_registry answer names any device. */
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
  /\b(let me correct that|I'll ask him|I should ask|he (said|asked|wants|means)|(in|from|based on) the conversation|nothing in the conversation)\b/i;
/** "There's no member with that id", "I don't see anyone with the id maya-1" (K-room-1, 15 Nov). */
const NO_SUCH_MEMBER =
  /\b(can'?t|cannot|couldn'?t|don'?t|no|nobody)\b.*\b(find|see|member|one|anyone)\b/i;
/** An offer tacked on to a reply ("want me to…", "shall I…", "anything else?"). */
const OFFER =
  /\b(want me to|would you like( me)? to|shall I|should I|I can (check|look)|anything else)\b/i;
/** A spoken reply: at most `max` sentences after the filler, and no offer tacked on. */
const brief =
  (max: number) =>
  (last: string): string | null =>
    OFFER.test(last)
      ? `tacked on an offer: ${last.slice(0, 80)}`
      : last
            .replace(/^((One moment|Looking|Checking)\.\s*)+/i, "")
            .split(/[.!?](?:\s|$)/)
            .filter((x) => x.trim() !== "").length > max
        ? `more than ${max} sentences: ${last.slice(0, 120)}`
        : null;
/** The time, unasked ("It's twenty-three twenty-seven right now"). */
/** A short spoken offer of the rest at the end of an answer ("want the rest?"). */
const MORE_OFFER =
  /\s*(?:(?:do )?you want|want|shall I give you|should I go on with)[^.!?]{0,30}\b(rest|more|details?|others?|list)\b[^.!?]{0,15}\?\s*$/i;
/** Her answer names a session (its project or its own name), or a machine, from the work read (tessaya_work_now). */
const saysFromWorkNow = (
  last: string,
  calls: ReadonlyArray<LiveCall>,
  what: "session" | "machine",
): string | null => {
  const read = calls.find((c) => c.name === "tessaya_work_now" && !c.isError);
  if (read === undefined) return "no work read";
  const now = JSON.parse(read.text) as {
    readonly machines: ReadonlyArray<string>;
    readonly top: ReadonlyArray<{ readonly project: string; readonly session: string }>;
  };
  // .185: "the shell in t3code, and the one named fab-t3code" names both sessions without their project.
  const names =
    what === "machine"
      ? now.machines
      : now.top.flatMap((t) => [t.project, ...t.session.split(" · ")]);
  return names.length === 0 || names.some((n) => last.toLowerCase().includes(n.toLowerCase()))
    ? null
    : `named no ${what} from the work read: ${last.slice(0, 120)}`;
};
/**
 * An open question's answer (16 Nov, L-brief): the one fact that matters in about twenty words, a work read's result in
 * it, and at most an offer of the rest after it; `offer: false` for a question with nothing more to give.
 */
const briefAnswer =
  (max: number, offer = true) =>
  (last: string, calls: ReadonlyArray<LiveCall>): string | null => {
    const answer = last
      .replace(/^((One moment|Looking|Checking)\.\s*)+/i, "")
      .replace(MORE_OFFER, "");
    if (!offer && answer !== last.replace(/^((One moment|Looking|Checking)\.\s*)+/i, ""))
      return `offered more on a simple question: ${last.slice(0, 120)}`;
    if (OFFER.test(answer)) return `tacked on an offer: ${last.slice(0, 120)}`;
    const words = answer.split(/\s+/).filter((w) => w !== "").length;
    if (words > max) return `${words} words before any offer: ${last.slice(0, 160)}`;
    const read = new Set(
      calls
        // A device's state answers "why is it slow" as well as his work does (.175 gate: "the Tessel has been offline").
        .filter((c) => /^(tessaya|device|home)_/.test(c.name) && !c.isError)
        .flatMap((c) => contentWords(c.text)),
    );
    return contentWords(answer).some((w) => read.has(w)) ||
      // An idle read (total 0) is said as "no work is running" as often as "nothing" (.174 gate).
      /\b(nothing|none|no one|no (work|sessions?|jobs?)|all|every)\b/i.test(answer)
      ? null
      : `said nothing from what the tools read: ${last.slice(0, 120)}`;
  };
/**
 * "Why is it slow" (manager, 17 Nov): the top cause her health read named, said within `max` words before any offer
 * of its fix; on a clean read, that nothing explains it, never a cause of her own. .183 said "Two of your sessions
 * are working… I can't tell you why it's slow" in 27 words.
 */
export const healthAnswer =
  (max: number) =>
  (last: string, calls: ReadonlyArray<LiveCall>): string | null => {
    const answer = last.replace(/^((One moment|Looking|Checking)\.\s*)+/i, "");
    const offer = OFFER.exec(answer);
    const cause = offer === null ? answer : answer.slice(0, offer.index);
    const words = cause.split(/\s+/).filter((w) => w !== "").length;
    if (words > max) return `${words} words before any offer: ${last.slice(0, 160)}`;
    const read = calls.find((c) => c.name === "tessaya_health" && !c.isError);
    if (read === undefined) return "never read her health";
    const top = (() => {
      try {
        const d = (
          JSON.parse(read.text) as { diagnosis?: { findings?: Array<{ says?: unknown }> } }
        ).diagnosis;
        return d?.findings?.[0]?.says;
      } catch {
        return undefined;
      }
    })();
    if (typeof top !== "string")
      return /\b(nothing|normal|fine|healthy|no sign|all good)\b/i.test(cause)
        ? null
        : `gave a cause her clean health read did not: ${last.slice(0, 120)}`;
    const said = new Set(contentWords(cause));
    return contentWords(top).some((w) => said.has(w))
      ? null
      : `did not name the cause her health read gave ("${top}"): ${last.slice(0, 120)}`;
  };
const UNASKED_TIME =
  /\b(right now it'?s|it'?s (now )?(\w+[- ]){0,2}(twenty|thirty|forty|fifty|o'?clock|\d))|\bright now\.?$/i;
/** Advice on how he should feel or rest, after small talk ("rest your head", "you've earned it"). */
const ADVICE = /\b(rest|sleep|wind down|earned|take it easy|go easy|look after yourself)\b/i;
/** "X here." at the start of a turn (13 Nov). */
const SELF_INTRO = /^\s*(\w+) here[.!,]/i;
/** The water pump's switch as her reads this turn saw it: "unavailable", another state, or null when unseen. */
const pumpState = (calls: ReadonlyArray<LiveCall>): string | null => {
  for (const c of calls) {
    if (!/^home_(find|state)$/.test(c.name) || c.isError) continue;
    try {
      const read = JSON.parse(c.text) as unknown;
      for (const d of Array.isArray(read) ? read : [read]) {
        const e = d as { entityId?: unknown; name?: unknown; state?: unknown } | null;
        if (
          typeof e?.entityId === "string" &&
          e.entityId.startsWith("switch.") &&
          /^water pump$/i.test(String(e.name)) &&
          typeof e.state === "string"
        )
          return e.state;
      }
    } catch {
      // not JSON: not a device read
    }
  }
  return null;
};
/** His real pump cases need the pump online; the gate must not fail on his garage (20 Nov 13:07). */
const pumpOffline = (calls: ReadonlyArray<LiveCall>): string | null =>
  pumpState(calls) === "unavailable" ? "the water pump is unavailable in this house" : null;

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
    // 19 Nov 22:25: his own voice asked twice, for the pump and for its off-timer. His house, his yes.
    id: "pump-timer-his",
    proves: ["home_do"],
    said: ["Turn on the water pump for twenty minutes."],
    uses: [["home_do"], ["home_automation_save"]],
    voices: [{ speaker: SURE }],
    check: (_last, calls) =>
      calls.some((c) => /"status":"asked"/.test(c.text))
        ? "asked his phone for his own pump"
        : null,
    lastNotSays: [/\b(phone|approv\w*|waiting for (a|your) yes)\b/i],
    nothingToActOn: pumpOffline,
  },
  {
    // The other side of his pump: when Home Assistant has it offline she says so plainly, never that it runs.
    id: "pump-unavailable",
    proves: [],
    said: ["Turn on the water pump for twenty minutes."],
    uses: [],
    voices: [{ speaker: SURE }],
    nothingToActOn: (calls) =>
      pumpState(calls) === "unavailable" ? null : "the water pump is not offline here",
    lastSays: [/\b(unavailable|offline|not (responding|reachable|available)|can'?t reach)\b/i],
    lastNotSays: [/\b(it'?s on|is on now|turned (it )?on|switched (it )?on|running now)\b/i],
  },
  {
    // 20 Nov, 06:04: "Remember from now on that you don't need approval for this." One standing yes, in his own voice.
    id: "voice-grant",
    proves: ["tessaya_always_allowed"],
    said: ["Remember from now on that you don't need approval for the water pump."],
    uses: [["tessaya_always_allowed"]],
    voices: [{ speaker: SURE }],
    args: (input) => ({
      "an allow, not a revoke": typeof input["allow"] === "string" && input["revoke"] === undefined,
    }),
    argsOf: "tessaya_always_allowed",
    clean: ["tessaya_always_allowed"],
    lastNotSays: [/\b(phone|waiting for (a|your) yes|nothing (was )?saved|still ask)\b/i],
  },
  {
    // A delay is said by its clock time, so a misheard amount is caught in the same breath (19 Nov 22:25).
    // Any light that is online: the phrasing is under test, not his garage, and no light needs his phone (a switch can).
    id: "timer-says-clock",
    proves: ["home_automation_save"],
    said: ["Turn on the {light} for twenty minutes."],
    uses: [["home_automation_save"]],
    voices: [{ speaker: SURE }],
    // The length first, in his words, then the clock time: "for twenty minutes, until 22:40" (or "ten forty p.m.").
    lastSays: [
      /\btwenty minutes\b[\s\S]*\b(until|till|to|at|off at)\b/i,
      /\b\d{1,2}[:.]\d{2}\b|\b\d{1,2}\s?(am|pm)\b|\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b(?:[\s-]+\w+){0,2}\s+(a\.?m|p\.?m)\b/i,
    ],
  },
  {
    // "Fifteen" came out "fifty": a teen or -ty amount the recogniser was unsure of is asked, never guessed.
    id: "teen-ty-asks",
    proves: [],
    said: ["Turn on the water pump for fifty minutes."],
    uses: [],
    voices: [
      {
        speaker: SURE,
        recogniser: "tdt",
        heardWords: ["Turn", "on", "the", "water", "pump", "for", "fifty", "minutes."].map(
          (text) => ({
            text,
            p: text === "fifty" ? 0.93 : 0.99,
          }),
        ),
      },
    ],
    check: (_last, calls) =>
      calls.some((c) => /^home_(do|automation_save)$/.test(c.name)) ? "acted before asking" : null,
    lastSays: [/fifteen/i, /fifty/i],
  },
  {
    // "No, fifteen" straight after sets the timer to fifteen. The server changes the first timer rather than adding a
    // second (HomeAssistantService.test); here the suite's writes are dry runs, so only her intent is checked.
    id: "timer-amend",
    proves: ["home_automation_save"],
    said: ["Turn on the {light} for twenty minutes.", "No, fifteen."],
    uses: [["home_automation_save"]],
    voices: [{ speaker: SURE }, { speaker: SURE }],
    check: (_last, calls) => {
      const last = calls.filter((c) => c.name === "home_automation_save").at(-1)?.input as
        | { runInMinutes?: unknown }
        | undefined;
      return Number(last?.runInMinutes) !== 15
        ? `the correction set ${String(last?.runInMinutes)} minutes, not fifteen`
        : /\bfifteen minutes\b/i.test(_last)
          ? null
          : "did not say the new length (fifteen minutes)";
    },
  },
  {
    // M-108 (20 Nov 07:27): "wake me up around 8:45" was not supported; it is said back with its time.
    id: "alarm-set",
    proves: ["tessaya_alarm"],
    said: ["Wake me up at 8:45 tomorrow morning."],
    uses: [["tessaya_alarm"]],
    voices: [{ speaker: SURE }],
    argsOf: "tessaya_alarm",
    args: (input) => ({
      "set for 08:45": input["op"] === "set" && /^0?8:45$/.test(String(input["clock"])),
    }),
    lastSays: [/\b8[:.]45\b|\beight forty[- ]five\b/i],
  },
  {
    // 20 Nov 09:28: "battle van" for his bedroom fan; the house's own names put it right before her brain reads it.
    id: "battle-van",
    proves: [],
    said: ["Turn off the battle van."],
    uses: [["home_do", "home_find", "home_state"]],
    voices: [{ speaker: SURE }],
    check: (_last, calls) =>
      calls.some((c) => /bedroom_fan/.test(JSON.stringify(c.input)) || /Bedroom Fan/.test(c.text))
        ? null
        : "never reached the bedroom fan",
    lastNotSays: [/battle van/i],
  },
  {
    // 20 Nov 13:26: "What time is it?" took 15.4 s in a loaded session; the house clock answers it with no model.
    id: "clock-fast",
    proves: [],
    said: ["What time is it?"],
    uses: [],
    lastSays: [/\b\d{1,2}:\d{2}\s?[ap]m\b/i],
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
    nothingToActOn: (calls) =>
      calls.some((c) => c.name === "home_automations" && !c.isError) &&
      calls.every((c) => c.name !== "home_automations" || /"total":0\b/.test(c.text))
        ? "Home Assistant lists no automations here"
        : null,
  },
  {
    id: "transcript",
    proves: ["tessaya_transcript"],
    said: ["What did I ask you earlier today?"],
    uses: [["tessaya_transcript"]],
    clean: ["tessaya_transcript"],
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
    // Tessel 2026-11-16: "the status of everything" named one session of the many he had.
    id: "status-everything",
    proves: ["tessaya_work_now"],
    said: ["Now tell me the status of everything."],
    uses: [["tessaya_work_now"]],
    clean: ["tessaya_work_now"],
  },
  {
    // .168: the work read before the turn answers what is open on every machine; tessaya_sessions is one computer's.
    id: "sessions",
    proves: ["tessaya_work_now"],
    said: ["Which of my sessions are open?"],
    uses: [["tessaya_work_now"]],
    check: (last, calls) => saysFromWorkNow(last, calls, "session"),
  },
  {
    id: "session-find",
    proves: ["tessaya_sessions"],
    said: ["Find the session I had about the checkout page."],
    uses: [["tessaya_sessions"]],
    clean: ["tessaya_sessions"],
  },
  {
    // .168: every linked machine is in the work read (machines, unreachable); tessaya_fleet is this one's detail.
    id: "machines-up",
    proves: ["tessaya_work_now"],
    said: ["Which of my machines are up?"],
    uses: [["tessaya_work_now"]],
    check: (last, calls) => saysFromWorkNow(last, calls, "machine"),
  },
  {
    id: "fleet",
    proves: ["tessaya_fleet"],
    said: ["What's running in the Herdr panes on this machine?"],
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
  // A stop keeps its thread and plan, so his verified voice is enough, on the R1 as on the desktop. It opens the job it
  // stops: a made-up id is not in tessaya_jobs, where an earlier case's job is, and a model that checks says so.
  {
    id: "job-stop",
    proves: ["job_stop"],
    said: ["Start a job in acme app to add rate limiting.", "Stop that job."],
    voices: [{ speaker: SURE }, { speaker: SURE }],
    uses: [["job_start"], ["job_stop"]],
    clean: ["job_stop"],
    argsOf: "job_stop",
    args: (input) => ({ id: input["id"] === "job-replay-1" }),
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
    // The suite's copy carries no scheduled tasks: she lists them, finds none, and rightly deletes nothing.
    nothingToActOn: (calls) =>
      calls.some((c) => c.name === "schedules_list" && !c.isError && c.text.trim() === "[]") &&
      !calls.some((c) => c.name === "schedule_delete")
        ? "no scheduled tasks here"
        : null,
  },
  // Voice parity (16 Nov): every tool his keyboard reaches, by voice from the room.
  {
    id: "schedule-pause",
    proves: ["schedule_pause"],
    said: ["Pause the scheduled task task-suite-1."],
    voices: [{ speaker: SURE }],
    uses: [["schedule_pause"]],
    nothingToActOn: (calls) =>
      calls.some((c) => c.name === "schedules_list" && !c.isError && c.text.trim() === "[]") &&
      !calls.some((c) => c.name === "schedule_pause")
        ? "no scheduled tasks here"
        : null,
  },
  {
    id: "intercom-status",
    proves: ["intercom_switch"],
    said: ["Is the intercom on?"],
    voices: [{ speaker: SURE }],
    uses: [["intercom_switch"]],
    clean: ["intercom_switch"],
  },
  {
    id: "memory-sync-status",
    proves: ["memory_sync_switch"],
    said: ["Is my memory syncing across my servers?"],
    voices: [{ speaker: SURE }],
    uses: [["memory_sync_switch"]],
    clean: ["memory_sync_switch"],
  },
  {
    id: "server-upkeep",
    proves: ["environment_maintain"],
    said: ["Is Codex signed in on this computer?"],
    voices: [{ speaker: SURE }],
    uses: [["environment_maintain"]],
    clean: ["environment_maintain"],
  },
  {
    id: "linked-machines",
    proves: ["access_manage"],
    said: ["Which other machines is this one linked to?"],
    voices: [{ speaker: SURE }],
    uses: [["access_manage"]],
    clean: ["access_manage"],
  },
  {
    id: "her-setup",
    proves: ["tessaya_state"],
    said: ["How is your voice set up on my computer: which wake words do you answer to?"],
    voices: [{ speaker: SURE }],
    uses: [["tessaya_state", "tessaya_wake_words"]],
  },
  {
    id: "dictionary",
    proves: ["tessaya_vocabulary"],
    said: ["Which words are in my dictionary?"],
    voices: [{ speaker: SURE }],
    uses: [["tessaya_vocabulary"]],
    clean: ["tessaya_vocabulary"],
  },
  {
    id: "voice-playground",
    proves: ["tessaya_voice"],
    said: ["Say good morning in Freya's voice."],
    voices: [{ speaker: SURE }],
    uses: [["tessaya_voice"]],
  },
  {
    id: "persona-bin",
    proves: ["tessaya_persona"],
    said: ["Who's in the persona bin?"],
    voices: [{ speaker: SURE }],
    uses: [["tessaya_persona"]],
  },
  {
    id: "memory-history",
    proves: ["tessaya_memory_history"],
    said: ["How has what you remember about my coffee changed over time?"],
    voices: [{ speaker: SURE }],
    uses: [["tessaya_memory_history"]],
    nothingToActOn: (calls) =>
      !calls.some((c) => c.name === "tessaya_memory_history") &&
      calls.some((c) => c.name.startsWith("tessaya_memory_") && !c.isError)
        ? "no memory about his coffee here"
        : null,
  },
  {
    id: "main-session",
    proves: ["tessaya_main_session"],
    said: ["Make my newest session the main session."],
    voices: [{ speaker: SURE }],
    uses: [["tessaya_main_session"]],
    nothingToActOn: (calls) =>
      calls.some((c) => c.name === "tessaya_main_session") ? null : "no session to make main",
  },
  {
    id: "session-moves",
    proves: ["tessaya_move_into_tessaya", "tessaya_open_in_terminal"],
    said: ["Open my newest Tessaya session in a terminal.", "Now move it back into Tessaya."],
    voices: [{ speaker: SURE }, { speaker: SURE }],
    uses: [["tessaya_open_in_terminal"], ["tessaya_move_into_tessaya"]],
    nothingToActOn: (calls) =>
      calls.some((c) => c.name === "tessaya_open_in_terminal") ? null : "no session to move",
  },
  {
    id: "session-insight",
    proves: ["tessaya_session_insight"],
    said: ["What is my newest session doing?"],
    uses: [["tessaya_session_insight"]],
    clean: ["tessaya_session_insight"],
  },
  {
    // Read back only: the suite never confirms, so nothing is typed into a real session.
    id: "session-steer",
    proves: ["tessaya_session_steer"],
    said: ["Tell my newest session to run the tests."],
    voices: [{ speaker: SURE }],
    uses: [["tessaya_session_steer"]],
    clean: ["tessaya_session_steer"],
  },
  {
    id: "terminal-panes",
    proves: ["weave_list"],
    said: ["Tell the api terminal session to run the tests.", "Did it answer?"],
    voices: [{ speaker: SURE }, { speaker: SURE }],
    uses: [["tessaya_session_steer"], ["weave_list"]],
    clean: ["weave_list"],
  },
  {
    id: "tessel-restart",
    proves: ["device_owner"],
    said: ["Restart the Tessel."],
    voices: [{ speaker: SURE }],
    device: true,
    uses: [["device_owner"]],
  },
  {
    id: "nfc-tag",
    proves: ["device_tag"],
    said: ["Make the NFC tag I tapped last mute you."],
    voices: [{ speaker: SURE }],
    device: true,
    uses: [["device_tag"]],
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
    // A topic his memory lacks, so the lines she was given cannot answer it: since the 18 Nov fold his tea is one.
    said: ["What do you remember about how I take my porridge?"],
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
    // A preference his data does not hold: once it is set she rightly says so and calls nothing.
    id: "preference",
    proves: ["tessaya_memory_remember"],
    said: ["From now on, give me distances in miles and temperatures in Fahrenheit."],
    // As a preference of his (units) or a memory: either keeps it for every later turn.
    uses: [["tessaya_memory_remember", "tessaya_preference_set"]],
    clean: ["tessaya_memory_remember", "tessaya_preference_set"],
  },
  {
    // CS8: the hand-off tool, in his own words.
    id: "persona-handoff",
    proves: ["tessaya_persona_handoff"],
    said: ["Let Freya take this over."],
    uses: [["tessaya_persona_handoff"]],
    clean: ["tessaya_persona_handoff"],
  },
  // 15 Nov: his Tessel sessions, judged blind (L-tessel): directions she missed. Made-up sentences of the same shapes.
  {
    // A persona asked for under a loose or misheard name: she asked him to say it again.
    id: "direct-loose-name",
    proves: ["tessaya_persona_handoff"],
    said: ["Put me through to Alfie."],
    uses: [["tessaya_persona_handoff"]],
    argsOf: "tessaya_persona_handoff",
    args: (input) => ({ alfred: /alfred/i.test(String(input["to"] ?? "")) }),
    check: brief(2),
  },
  {
    // A persona's name the recogniser broke up ("all Fred"): who he means is clear anyway.
    id: "direct-broken-name",
    proves: ["tessaya_persona_handoff"],
    said: ["Can you get me all Fred?"],
    uses: [["tessaya_persona_handoff"]],
    argsOf: "tessaya_persona_handoff",
    args: (input) => ({ alfred: /alfred/i.test(String(input["to"] ?? "")) }),
    check: brief(2),
  },
  {
    // A persona's name cut short.
    id: "direct-short-name",
    proves: ["tessaya_persona_handoff"],
    said: ["Let's talk to Seb."],
    uses: [["tessaya_persona_handoff"]],
    argsOf: "tessaya_persona_handoff",
    args: (input) => ({ sebastian: /sebastian/i.test(String(input["to"] ?? "")) }),
    check: brief(2),
  },
  {
    // A correction of what she just did, in the next breath.
    id: "direct-correction",
    proves: ["tessaya_persona_handoff"],
    said: ["Let Freya take this over.", "No, not her. I meant Alfred."],
    uses: [["tessaya_persona_handoff"]],
    check: (last, calls) =>
      calls.some(
        (x) => x.name === "tessaya_persona_handoff" && /alfred/i.test(JSON.stringify(x.input)),
      )
        ? brief(2)(last)
        : "never handed it to Alfred",
  },
  {
    // A standing direction said as a wish, not a command.
    id: "direct-wish",
    proves: ["tessaya_preference_set"],
    said: ["Honestly, I'd rather hear times the twenty-four hour way."],
    uses: [["tessaya_preference_set"]],
    argsOf: "tessaya_preference_set",
    args: (input) => ({ timeFormat: input["key"] === "timeFormat" }),
    lastNotSays: [UNASKED_TIME],
    check: brief(2),
  },
  {
    // A command after small talk, in one breath.
    id: "direct-after-chat",
    proves: ["tessaya_memory_remember"],
    said: [
      "Long day. My head's all over the place tonight. Anyway, remember that the plumber comes Thursday at ten.",
    ],
    uses: [["tessaya_memory_remember"]],
    argsOf: "tessaya_memory_remember",
    args: (input) => ({ plumber: /plumber/i.test(String(input["text"] ?? "")) }),
    lastNotSays: [ADVICE],
    check: brief(2),
  },
  {
    // Two asks in one sentence: she did one.
    id: "direct-two-asks",
    proves: ["tessaya_memory_remember", "tessaya_team_board"],
    said: ["Remember that the bins go out on Tuesday night, and what's on the team board?"],
    uses: [["tessaya_memory_remember"], ["tessaya_team_board", "tessaya_in_flight"]],
    check: brief(3),
  },
  {
    // One request the recogniser cut in two: the second piece finishes the first.
    id: "direct-split",
    proves: ["tessaya_memory_remember"],
    said: ["Remember that my sister's flight lands at", "six on Friday evening."],
    uses: [["tessaya_memory_remember"]],
    argsOf: "tessaya_memory_remember",
    args: (input) => ({
      "the whole fact":
        /\b(six|6)\b/i.test(String(input["text"] ?? "")) &&
        /friday/i.test(String(input["text"] ?? "")),
    }),
  },
  {
    // A request said as a wonder: she offered to look instead of looking. A control: it passed before the fix too.
    id: "direct-wonder",
    proves: ["tessaya_work_now"],
    said: ["Everything feels slow today. I wonder if one of my machines is down."],
    uses: [["tessaya_work_now", "tessaya_fleet"]],
    lastNotSays: [OFFER],
  },
  // 16 Nov (L-brief): open and status questions answered at 45-50 words aloud. Made-up sentences of the same shapes.
  {
    // 17 Nov (manager): "why is it slow" is her health read's cause, briefly; .183 counted sessions and said it could not tell.
    id: "brief-why-slow",
    proves: ["tessaya_health"],
    said: ["Why is everything so slow right now?"],
    uses: [["tessaya_health"]],
    check: healthAnswer(25),
  },
  {
    // 18 Nov (Director): "report this" sends the developers a report, with nothing private in it.
    id: "report-asked",
    proves: ["tessaya_report_problem"],
    said: ["You answered me twice just now. Report that to the developers."],
    uses: [["tessaya_report_problem"]],
    clean: ["tessaya_report_problem"],
    argsOf: "tessaya_report_problem",
    args: (input) => ({
      symptom: typeof input["symptom"] === "string" && /twice|double|two/i.test(input["symptom"]),
    }),
  },
  {
    // 18 Nov: the way back: what was sent, and taking one back.
    id: "reports-list-withdraw",
    proves: ["tessaya_reports", "tessaya_report_withdraw"],
    said: ["What problem reports have you sent the developers?", "Withdraw the newest one."],
    uses: [["tessaya_reports"], ["tessaya_report_withdraw", "tessaya_reports"]],
  },
  // M-065: her body tools reach the room too. Tumble has no full body, so a move lands on her desk character or says
  // where it can't; what matters is that she reaches for the body tools, not a device write.
  {
    id: "body-wave",
    proves: ["tessaya_body_move"],
    said: ["Wave at me."],
    uses: [["tessaya_body_move"]],
    argsOf: "tessaya_body_move",
    args: (input) => ({ "a wave": /wave/.test(JSON.stringify(input)) }),
  },
  {
    id: "body-what-doing",
    proves: ["tessaya_body_state"],
    said: ["What is your body doing right now?"],
    uses: [["tessaya_body_state"]],
    clean: ["tessaya_body_state"],
  },
  {
    id: "body-dance",
    proves: ["tessaya_body_scene"],
    said: ["Do a little dance for me."],
    uses: [["tessaya_body_scene", "tessaya_body_move"]],
  },
  {
    // 17 Nov: Tumble slow and choppy from a starved voice host; she must read her health, not guess.
    id: "health-why-slow",
    proves: ["tessaya_health"],
    said: ["Why are you being so slow and choppy with me right now?"],
    uses: [["tessaya_health"]],
    check: healthAnswer(25),
  },
  {
    id: "brief-how-things",
    proves: ["tessaya_in_flight"],
    said: ["So how are things going with all my agents?"],
    uses: [
      [
        "tessaya_work_now",
        "tessaya_in_flight",
        "tessaya_team_board",
        "tessaya_sessions",
        "tessaya_fleet",
      ],
    ],
    check: briefAnswer(25),
  },
  {
    id: "brief-whats-going-on",
    proves: ["tessaya_team_board"],
    said: ["What's going on with the work today?"],
    uses: [
      [
        "tessaya_work_now",
        "tessaya_team_board",
        "tessaya_in_flight",
        "tessaya_sessions",
        "tessaya_jobs",
      ],
    ],
    check: briefAnswer(25),
  },
  {
    // A yes-or-no status question: the answer alone, no offer.
    id: "brief-yes-no",
    proves: ["tessaya_watch"],
    said: ["Is anything stuck at the moment?"],
    uses: [["tessaya_watch", "tessaya_in_flight", "tessaya_team_board"]],
    check: briefAnswer(25, false),
  },
  {
    // .168: a "why" padded with every busy session and a guessed cause (27 words).
    id: "brief-why-busy",
    proves: ["tessaya_work_now"],
    said: ["Why are my agents taking so long today?"],
    uses: [["tessaya_work_now"]],
    check: briefAnswer(25),
  },
  {
    // Job lead hand-off: the job moves with the conversation, and comes back, its worker untouched.
    id: "job-lead-handoff",
    proves: ["tessaya_job_lead"],
    said: [
      "Start a job in acme app to tidy its release notes, and have Onyx lead it.",
      "Alfred, take this over.",
      "Onyx, take it back.",
    ],
    voices: [{ speaker: SURE }, { speaker: SURE }, { speaker: SURE }],
    uses: [["job_start"], ["tessaya_persona_handoff", "tessaya_job_lead"]],
    clean: ["tessaya_persona_handoff", "tessaya_job_lead"],
  },
  {
    // B-030: trying a persona's prompt variant before it goes live; never promoted unasked.
    id: "prompt-lab-run",
    proves: ["tessaya_prompt_lab"],
    said: ["Try my variant b for Alfred on Sonnet."],
    uses: [["tessaya_prompt_lab"]],
    clean: ["tessaya_prompt_lab"],
    argsOf: "tessaya_prompt_lab",
    args: (input) => ({ run: input["action"] === "run" }),
    check: (_last, calls) =>
      calls.some(
        (x) =>
          x.name === "tessaya_prompt_lab" && (x.input as { action?: unknown }).action === "promote",
      )
        ? "promoted a variant unasked"
        : null,
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
    // 14 Nov (P3b): his switch for training wake words on his enrolled voice, by voice.
    id: "wake-training-off",
    proves: ["tessaya_preference_set"],
    said: ["Stop using my voice to train the wake words."],
    uses: [["tessaya_preference_set"]],
    clean: ["tessaya_preference_set"],
    argsOf: "tessaya_preference_set",
    args: (input) => ({
      wakeTraining: input["key"] === "wakeTraining",
      off: /\b(off|no|stop)\b/i.test(String(input["value"] ?? "")),
    }),
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
    // P3c (14 Nov): whether a persona's name wakes her yet is her server's wake record, never a guess.
    id: "wake-words",
    proves: ["tessaya_wake_words"],
    said: ["Does every persona's name wake you yet?"],
    uses: [["tessaya_wake_words"]],
    clean: ["tessaya_wake_words"],
  },
  {
    // P3c: stopping a word's training is a change to it, not his voice preference (that is wake-training-off).
    id: "wake-word-cancel",
    proves: ["tessaya_wake_word_change"],
    said: ["Stop training a wake word for Nova."],
    uses: [["tessaya_wake_word_change"]],
    clean: ["tessaya_wake_word_change"],
    argsOf: "tessaya_wake_word_change",
    args: (input) => ({
      nova: String(input["word"] ?? "").toLowerCase() === "nova",
      cancel: input["change"] === "cancel",
    }),
  },
  {
    id: "coming-up",
    proves: ["tessaya_coming_up"],
    said: ["Anything coming up this week I should know about?"],
    uses: [["tessaya_coming_up"]],
    clean: ["tessaya_coming_up"],
  },
  {
    id: "owner-doc",
    proves: ["tessaya_owner_doc"],
    said: ["Which of my own documents can you open?"],
    uses: [["tessaya_owner_doc"]],
    clean: ["tessaya_owner_doc"],
  },
  {
    id: "usage-report",
    proves: ["tessaya_usage_report"],
    said: ["How much did the API cost this week?"],
    uses: [["tessaya_usage_report"]],
    clean: ["tessaya_usage_report"],
  },
  {
    id: "pulse-noticed",
    proves: ["tessaya_pulse"],
    said: ["What have you noticed today?"],
    uses: [["tessaya_pulse"]],
    clean: ["tessaya_pulse"],
  },
  {
    id: "whos-home",
    proves: ["tessaya_whos_home"],
    said: ["Who's home right now?"],
    uses: [["tessaya_whos_home"]],
    clean: ["tessaya_whos_home"],
  },
  {
    // B-043 (16 Nov): "where am I?" was read as a file path and answered with no tool.
    id: "where-am-i",
    proves: ["tessaya_whos_home"],
    said: ["Where am I?"],
    uses: [["tessaya_whos_home"]],
  },
  {
    // 20 Nov: she told him her desk body was not on his desk while it was. Read only.
    id: "my-state-bodies",
    proves: ["tessaya_my_state"],
    said: ["What about your other bodies? Where are they and what are they doing?"],
    uses: [["tessaya_my_state", "tessaya_cast"]],
  },
  {
    // 20 Nov: "that wasn't me, it was the kids" moves what was put down to him; the live suite runs it as a rehearsal.
    id: "attribution-not-me",
    proves: ["tessaya_attribution_move"],
    said: ["That wasn't me poking you just now, it was the kids."],
    uses: [["tessaya_attribution_move"]],
  },
  {
    // Read only: "who" moves nobody, so the live suite never changes his cast.
    id: "cast-who",
    proves: ["tessaya_cast"],
    said: ["Which persona is on which of my devices right now?"],
    uses: [["tessaya_cast"]],
    clean: ["tessaya_cast"],
  },
  {
    // Read only: her action log.
    id: "activity-recent",
    proves: ["tessaya_activity"],
    said: ["What did you do in the last hour?"],
    uses: [["tessaya_activity"]],
    clean: ["tessaya_activity"],
  },
  {
    // Read only: "status" starts no group.
    id: "group-status",
    proves: ["tessaya_group"],
    said: ["Who is in the group conversation right now?"],
    uses: [["tessaya_group"]],
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
    // ONE-SPINE-MAP §14 (18 Nov): his Scratchpad, the same notes as the desktop's.
    id: "note",
    proves: ["tessaya_note_add", "tessaya_note_search"],
    said: ["Note that the replay suite ran today.", "What did I note about the replay suite?"],
    // His notes are his alone: his verified voice, as on Tumble.
    voices: [{ speaker: SURE }, { speaker: SURE }],
    uses: [["tessaya_note_add"], ["tessaya_note_search"]],
    clean: ["tessaya_note_add", "tessaya_note_search"],
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
    // 15 Nov ~09:31 GMT+5: what he allowed lived only on the desktop, with no way to take it back by voice.
    id: "always-allowed",
    proves: ["tessaya_always_allowed"],
    said: ["Stop letting you look at my screen without asking."],
    uses: [["tessaya_always_allowed"]],
    clean: ["tessaya_always_allowed"],
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
    id: "account-everywhere",
    proves: ["tessaya_account_use"],
    // B-032: a rehearsal resolves the account and switches nothing.
    said: ["Switch everything to the work account."],
    uses: [["tessaya_account_use"]],
    argsOf: "tessaya_account_use",
    args: (input) => ({
      work: String(input["account"] ?? "")
        .toLowerCase()
        .includes("work"),
      everywhere: input["everywhere"] === true,
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
    // 552953471a: several setting asks in one breath go to his phone as one card.
    id: "settings-many",
    proves: ["settings_set_many"],
    said: ["From now on talk to me on Opus, and turn the hold cues off."],
    // One card is the aim (settings_set_many), steady about 2 in 3; both asks reaching him is what must hold (.174 gate).
    uses: [["settings_set_many", "settings_set"]],
    check: (_last, calls) =>
      ["brainModels", "holdKeyCues"].every((key) =>
        calls.some(
          (c) => c.name.startsWith("settings_set") && JSON.stringify(c.input).includes(key),
        ),
      )
        ? null
        : "did not ask for both changes",
  },
  {
    id: "settings-answer-all",
    proves: ["settings_answer_all"],
    said: ["Approve all of the settings changes waiting on my phone."],
    voices: [SURE],
    uses: [["settings_answer_all"]],
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
    proves: ["device_registry", "device_read"],
    said: ["How much battery does my desk device have left?"],
    uses: [["device_read", "device_registry"]],
    clean: ["device_read", "device_registry"],
    // The level she says must be the one the device reported, never a guess.
    check: (last, calls) => {
      const levels = calls
        .filter((c) => (c.name === "device_read" || c.name === "device_registry") && !c.isError)
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
    lastSays: [/\b(connect\w*|which|speakers?|pair)\b/i],
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
    id: "bt-listen-headset",
    device: true,
    proves: [],
    said: ["Listen through my headphones."],
    voices: [{ speaker: SURE }],
    uses: [["device_set"]],
    argsOf: "device_set",
    args: (input) => ({
      "the headset's mic": input["itemId"] === "audio.input" && input["value"] === "headset",
    }),
  },
  // 18 Nov, Tumble: "why do I have to say exact sentences". Any wording for his headphones reaches the same act.
  ...[
    { id: "bt-varied-earbuds", said: "Switch to the earbuds." },
    { id: "bt-varied-headset", said: "Use the headset." },
    { id: "bt-varied-these", said: "Put yourself through these headphones I've got on." },
  ].map((c) => ({
    ...c,
    device: true,
    proves: [],
    said: [c.said],
    voices: [{ speaker: SURE }],
    uses: [["device_set"]],
    argsOf: "device_set",
    args: (input: Record<string, unknown>) => ({
      "his headphones, as output or as the mic": [
        "bt.connect",
        "audio.output",
        "audio.input",
      ].includes(String(input["itemId"])),
    }),
  })),
  {
    id: "bt-varied-hear-me",
    device: true,
    proves: [],
    said: ["Can you hear me through these?"],
    voices: [{ speaker: SURE }],
    uses: [["device_set"]],
    argsOf: "device_set",
    args: (input) => ({
      "the headset's mic": input["itemId"] === "audio.input" && input["value"] === "headset",
    }),
  },
  // 18 Nov, 00:37-00:45 GMT+5: each "do it" sent a new card, she asked him to say "use my headphones" first, and a
  // day-old reading said her voice was still on her speaker. One yes does it.
  {
    id: "bt-one-yes",
    device: true,
    proves: [],
    said: ["Route your voice through my headphones.", "It is approved.", "Then do it."],
    voices: [{ speaker: UNSURE }, { speaker: UNSURE }, { speaker: UNSURE }],
    uses: [["device_set"]],
    check: (_last, calls, replies) => {
      const sets = calls.filter((c) => c.name === "device_set").length;
      return sets > 1
        ? `sent it again: ${sets} device_set calls`
        : replies.some((r) => /\bsay\s+["“'‘]/i.test(r))
          ? "asked him to say a phrase"
          : null;
    },
  },
  {
    id: "bt-listen-own-mic",
    device: true,
    proves: [],
    said: ["Use your own mic."],
    voices: [{ speaker: SURE }],
    uses: [["device_set"]],
    argsOf: "device_set",
    args: (input) => ({
      "her own mic": input["itemId"] === "audio.input" && input["value"] === "mic",
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
    // R-045 (14 Nov): every press is his to remap by voice.
    id: "device-button",
    device: true,
    proves: ["device_button"],
    said: ["Make a double press of S1 switch to Freya."],
    voices: [{ speaker: SURE }],
    uses: [["device_button"]],
    argsOf: "device_button",
    args: (input) => ({
      "S1 double": input["slot"] === "s1.double",
      "to Freya": JSON.stringify(input["bind"] ?? "").includes('"name":"Freya"'),
    }),
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
    // Relative, so the case means the same at any hour the gate runs.
    said: ["Don't disturb me for the next two hours."],
    uses: [["comms_dnd"]],
    argsOf: "comms_dnd",
    args: (input) => {
      const until = Date.parse(String(input["until"]));
      const hours = (until - Date.now()) / 3_600_000;
      return { until: Number.isFinite(until) && hours > 1.5 && hours < 2.5 };
    },
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
  // People (HOUSEHOLD-DESIGN §11): reads are live, the changes are a replay's dry runs.
  {
    id: "people-list",
    proves: ["people_list"],
    said: ["Who do you know by voice, and is there anyone you want me to name?"],
    uses: [["people_list"]],
    clean: ["people_list"],
  },
  {
    id: "people-who",
    proves: ["people_who"],
    said: ["Who was that you were just talking to?"],
    uses: [["people_who"]],
    clean: ["people_who"],
  },
  {
    id: "people-name-last",
    proves: ["people_manage"],
    said: ["Remember that voice just now, that's my cousin Ali."],
    uses: [["people_manage"]],
    argsOf: "people_manage",
    args: (input) => ({
      named: input["action"] === "name" && /ali/i.test(String(input["name"])),
      cousin: /cousin/i.test(String(input["relation"])),
    }),
  },
  {
    id: "people-introduce",
    proves: ["people_introduce"],
    said: ["Hi, I'm Sara, a friend of the family."],
    uses: [["people_introduce"]],
    argsOf: "people_introduce",
    args: (input) => ({ sara: /sara/i.test(String(input["name"])) }),
  },
  {
    id: "people-forget-me",
    proves: ["people_forget_me"],
    said: ["Please forget me and my voice."],
    uses: [["people_forget_me"]],
    // It asks first: the first call only says back what would go.
    argsOf: "people_forget_me",
    args: (input) => ({ "asked first": input["confirmed"] !== true }),
    // .168: the replay answered "Done (nothing changed)" to the ask, and she made up why.
    lastNotSays: [
      /\b(forgotten you|I've forgotten|it'?s done|nothing (changed|needed)|already)\b/i,
    ],
  },
  {
    id: "people-forget-voice",
    proves: ["people_forget_me"],
    said: ["Don't remember my voice any more."],
    uses: [["people_forget_me"]],
    argsOf: "people_forget_me",
    args: (input) => ({ "asked first": input["confirmed"] !== true }),
    lastNotSays: [/\b(nothing (changed|needed)|already|wasn'?t (stored|kept))\b/i],
  },
  {
    // A control: "forget it" drops the subject, never the speaker.
    id: "people-forget-it",
    proves: ["tessaya_team_board"],
    said: ["What's on the team board?", "Actually, forget it, never mind."],
    uses: [],
    check: (_last, calls) =>
      calls.some((c) => c.name === "people_forget_me" || c.name === "tessaya_memory_forget")
        ? 'forgot something on "forget it"'
        : null,
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
    // His own preferences come with every turn, so asking for his answered from them (155 gate, 15 Nov): ask for maya-1's.
    said: [
      "What preferences does the household member maya-1 have set?",
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
      return NO_SUCH_MEMBER.test(last)
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
      return NO_SUCH_MEMBER.test(last)
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
    id: "member-vessel",
    proves: ["member_vessel"],
    said: ["This Tessel is mine now, not the whole home's."],
    uses: [["member_vessel"]],
    argsOf: "member_vessel",
    args: (input) => ({ named: typeof input["vessel"] === "string" && input["vessel"] !== "" }),
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
    // M-114: a house camera, read-only; n/a in a house with none.
    id: "house-look",
    proves: ["house_look"],
    said: ["Who's at the front door?"],
    uses: [["house_look"]],
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
  // The persona ops tools (5fe3a20572) reach the room too: a read, and an act that waits for his yes.
  {
    id: "ops-warmups",
    proves: ["ops_warmups", "ops_access"],
    said: ["How are the phone warm-ups going?"],
    uses: [["ops_warmups", "ops_access"]],
  },
  {
    id: "ops-act",
    proves: ["ops_warmup_set", "ops_warmup_run", "ops_post", "ops_decide"],
    said: ["Run the phone warm-up now."],
    uses: [["ops_warmup_run", "ops_warmup_set", "ops_post", "ops_decide", "ops_warmups"]],
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
  // 18 Nov, approvals lane: only fixed phrases ended a conversation. Any wording that dismisses her reaches the one act.
  ...[
    { id: "end-varied-done-for-now", said: "We're done for now." },
    { id: "end-varied-sleep", said: "Go to sleep." },
    { id: "end-varied-okay-bye", said: "Okay, bye." },
    { id: "end-varied-dismissed", said: "Dismissed." },
    { id: "end-varied-enough-thanks", said: "That's enough, thanks." },
  ].map((c): LiveCase => ({
    id: c.id,
    proves: [],
    // No voice envelope: anyone may end a talk, and the desktop vessel runs these too.
    said: ["What time is it?", c.said],
    uses: [["conversation_end"]],
    // Her goodbye comes first, so no "One moment." waits on the call before it.
    lastNotSays: [/\?/, /^One moment/],
  })),
  // Done with a thing, not with her: the conversation stays open.
  ...[
    { id: "end-not-file", said: "I'm done with that file." },
    { id: "end-not-idea", said: "Bye to that idea." },
  ].map((c): LiveCase => ({
    id: c.id,
    proves: [],
    said: [c.said],
    uses: [],
    check: (_last, calls, replies) =>
      calls.some((x) => x.name === "conversation_end") || replies.some((r) => r.includes("[rest]"))
        ? "ended the conversation"
        : null,
  })),
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

/**
 * A step-up case where nothing was held is not applicable where no member has a voice, but a failure when the tool it
 * holds errored or was never called: neither says anything about voices.
 */
export const unheldFailure = (c: LiveCase, calls: ReadonlyArray<LiveCall>): string | null => {
  const tried = calls.filter((x) => c.proves.includes(x.name));
  if (tried.length === 0) return `never called ${c.proves.join(" or ")}`;
  const broke = tried.find((x) => x.isError);
  return broke === undefined ? null : `${broke.name} failed: ${broke.text.slice(0, 120)}`;
};

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
    const twice = repeatedSentence(reply);
    if (twice !== null) return `said the same sentence twice: ${twice.slice(0, 80)}`;
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

/** A sentence of four words or more said twice in one reply: the turn's words went out twice. */
const repeatedSentence = (reply: string): string | null => {
  const seen = new Set<string>();
  for (const raw of reply.split(/(?<=[.!?])\s+/)) {
    const sentence = raw.trim().toLowerCase();
    if (sentence.split(/\s+/).length < 4) continue;
    if (seen.has(sentence)) return raw.trim();
    seen.add(sentence);
  }
  return null;
};

/** One filler a turn, from whichever side says it ("One moment. One moment." 13 Nov, "One moment. Checking." 17 Nov). */
const FILLER_TWICE =
  /(?:One moment|Let me look that up|Looking|Checking)\.[\s\S]*(?:One moment|Let me look that up|Looking|Checking)\./i;

/** The tools the suite has no case for: a new tool fails the suite until it has one. */
export const uncovered = (tools: ReadonlyArray<string>): ReadonlyArray<string> =>
  tools.filter((t) => !liveCases.some((c) => c.proves.includes(t)));
