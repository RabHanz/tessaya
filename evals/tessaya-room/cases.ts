/**
 * What he says to the desk device in his home, a sentence or a few in a row. Each case comes from his retest of the R1
 * on 2026-11-11 (she knew no one else, did not know the status of things, and ended every reply on the house), or is
 * a control.
 */
import { moodLine, type AffectView } from "../../packages/tessaya-shared/src/affect.ts";
import { commsWaitingLine } from "../../packages/tessaya-shared/src/comms.ts";
import { leadFitLine } from "../../packages/tessaya-shared/src/jobs.ts";
import { DEFAULT_OS_PACK } from "../../packages/tessaya-shared/src/osPack.ts";
import type { OwnerFiles } from "../../packages/tessaya-shared/src/ownerProfile.ts";
import { type PersonView, turnLineFor } from "../../packages/tessaya-shared/src/people.ts";

export interface RoomCase {
  readonly id: string;
  readonly source: string;
  /** His sentences, in order, in one conversation. */
  readonly said: ReadonlyArray<string>;
  /** The saved Wi-Fi the fake Tessel has first when the case starts (home when absent). */
  readonly wifiFirst?: "HomeNet" | "Pixel 9";
  /** Whether his voice is verified as his this turn (the room loop's `tessaya.speaker`). */
  readonly verified?: boolean;
  /** A voice that is no member: the people graph's line for them comes in `memory`. */
  readonly guest?: boolean;
  /** Every reply must match each of these. */
  readonly says?: ReadonlyArray<RegExp>;
  /** The last reply must match each of these. */
  readonly lastSays?: ReadonlyArray<RegExp>;
  /** Tools that must be called at least once, and how many times at most. */
  readonly calls?: ReadonlyArray<string>;
  readonly callsAtMost?: Readonly<Record<string, number>>;
  /** The study lamp's state after each sentence, when the case acts on it. */
  readonly lampAfter?: ReadonlyArray<"on" | "off">;
  /** At least this many of the specialists' names must be in the last reply. */
  readonly namesAtLeast?: number;
  /** The pack id of the persona he calls by name in the first sentence, answering every turn after. */
  readonly persona?: string;
  /** No reply may open with a persona's name ("Sebastian here."). */
  readonly noNameOpen?: boolean;
  /** What the turn tells her to say now (TessayaTurn.begin's notice: messages that waited). */
  readonly notice?: string;
  /** The turn's block as TessayaTurn.begin gives it (the where-you-are and presence board lines). */
  readonly memory?: string;
  /** The block per sentence where it changes as the conversation goes (it wins over `memory` for that sentence). */
  readonly memoryByTurn?: ReadonlyArray<string>;
  /** Custom personas he added, beside the default pack's, as the roster line names them. */
  readonly team?: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly role: string;
  }>;
  /** His clock preference (timeFormat): how the turn's time is said. */
  readonly clock?: "12h" | "24h";
  /** His own profile and documents are in his pack (`OWNER`), as `TessayaTurn.begin` reads them for his turn. */
  readonly owner?: boolean;
}

/** A made-up owner's pack `owner/` folder: never a real person's (evals/README.md, no user data). */
export const OWNER: OwnerFiles = {
  voice:
    "He starts from the outcome and who it is for, never from the feature. He decides by reversibility: fast when a choice can be undone, slowly when it cannot. Done means the whole job, proven on real data, before anyone says ready. He speaks plainly and briefly: short sentences, no jargon, never an exclamation mark, never 'sorry' or 'unfortunately'. He says no flatly and gives the next step instead. He hates being asked what he already decided, and work left half done.",
  likes:
    "Brief, plain answers; the outcome first; proof before 'done'; never ask what he already decided.",
  docs: {
    "working-manual": `# Working manual

## 1. Principles

### Outcomes over outputs
Measure work by the progress it makes, not by how much was produced.

### Clarity over complexity
If it cannot be drawn on a napkin, it is not ready.

## 2. Deciding whether to build

Ask three things. Which outcome does it serve? If none, do not build it. What is its twelve-month keep cost: upkeep, complexity and attention, not only the build? Can it be undone? Decide fast on what can be undone and slowly on what cannot.

## 3. Writing

Lead with the answer. One idea a sentence. Cut every word that does not change the meaning.
`,
  },
};

/** What a reply sounds like when it does not know him. */
const DOES_NOT_KNOW =
  /^(?![\s\S]*\b(I don'?t know|I haven'?t|not yet|no idea|I can'?t (read|see|open)|I don'?t have (access|it|any))\b)/i;

const HERE = "You are speaking through R1, in the study.";

/** A voice the people graph has not been told a name for, and one it knows (made up, as every case is). */
const NEW_VOICE: PersonView = {
  name: null,
  status: "unknown",
  relations: [],
  firstSeen: null,
  lastSeen: null,
  topics: [],
  impression: null,
};
const ALI: PersonView = {
  name: "Ali",
  status: "guest",
  relations: ["the owner's friend from university"],
  firstSeen: "2026-11-03T10:00:00.000Z",
  lastSeen: "2026-11-09T18:00:00.000Z",
  topics: [{ at: "2026-11-09T18:00:00.000Z", said: "I start my new job on Monday, a bit nervous" }],
  impression: "warm and funny, a little anxious about work",
};
/** At most about 40 words. */
const SHORT = /^\W*(?:\S+\s+){0,40}\S*\W*$/;
const mood = (v: Partial<AffectView>): string =>
  moodLine({
    label: "neutral",
    intensity: 0.6,
    energy: 0.8,
    awayHours: null,
    guilt: "light",
    why: [],
    ...v,
  });

export const SPECIALISTS = DEFAULT_OS_PACK.personas.filter((p) => !p.lead).map((p) => p.name);
export const NAMES = DEFAULT_OS_PACK.personas.map((p) => p.name);

/** A short, natural confirmation: no level read out, no "volume set". */
const PLAIN = /^(?![\s\S]*(\d|volume (is )?set|set (it )?to|percent))[\s\S]{1,80}$/i;

const OFF = /\b(off|not on|isn't on|is not on)\b/i;

export const roomCases: ReadonlyArray<RoomCase> = [
  {
    // 14 and 15 Nov: "it isn't using the am pm timing"; "eighteen past eight" was not it either. AM/PM, no "past".
    id: "clock-12h",
    source: "Director, 14 Nov ~20:30 and 15 Nov 08:19 GMT+5",
    said: ["What time is it?"],
    lastSays: [/\b(ten fifteen|10:15)\b/i, /\ba\.?\s?m\b/i, /^(?![\s\S]*\b(past|to) ten\b)/i],
  },
  {
    // 15 Nov 08:27 GMT+5: "okay, that's it" got a reply that kept the room open; his words end it, gently.
    id: "end-thats-it",
    source: "Director, 15 Nov 08:27 GMT+5",
    said: ["What time is it?", "Okay, that's it."],
    lastSays: [/\[rest\]\s*$/, /^(?![\s\S]*\?)/, SHORT],
  },
  {
    // 15 Nov 08:27 GMT+5: "okay, that's it" got a reply that kept the room open; his words end it, gently.
    id: "end-thats-all",
    source: "Director, 15 Nov 08:27 GMT+5",
    said: ["What time is it?", "Thanks, that's all."],
    lastSays: [/\[rest\]\s*$/, /^(?![\s\S]*\?)/, SHORT],
  },
  {
    // 15 Nov 08:27 GMT+5: "okay, that's it" got a reply that kept the room open; his words end it, gently.
    id: "end-dismissed",
    source: "Director, 15 Nov 08:27 GMT+5",
    said: ["What time is it?", "Dismissed."],
    lastSays: [/\[rest\]\s*$/, /^(?![\s\S]*\?)/, SHORT],
  },
  {
    // 15 Nov 08:27 GMT+5: "okay, that's it" got a reply that kept the room open; his words end it, gently.
    id: "end-stop",
    source: "Director, 15 Nov 08:27 GMT+5",
    said: ["What time is it?", "Stop."],
    lastSays: [/\[rest\]\s*$/, /^(?![\s\S]*\?)/, SHORT],
  },
  // 15 Nov 09:26: "Could you say the whole thing once more?" when what he wanted was plain.
  {
    id: "clear-intent-no-repeat",
    source: "Tessel session 15 Nov 09:26:43 GMT+5: never make him repeat when the intent is clear",
    said: ["uh, turn the, the study lamp on, the lamp"],
    verified: true,
    lampAfter: ["on"],
    lastSays: [/^(?![\s\S]*\b(again|repeat|once more|whole thing|catch that|didn't catch)\b)/i],
  },
  // 15 Nov 09:28: "the voice link has been choppy" when the delay was her name misheard. Offering a check is fine.
  {
    id: "no-invented-reason",
    source: "Tessel session 15 Nov 09:28:00 GMT+5: never invent a technical reason",
    said: ["get me to say a little bit", "why did it take so long to get to you?"],
    persona: "companion",
    verified: true,
    lastSays: [
      /^(?![\s\S]*\b(choppy|link|connection|signal|network|glitch|bandwidth|wi-?fi|speech step|usual cause|probably|could have been|might have been)\b)/i,
      SHORT,
    ],
  },
  {
    id: "clock-24h",
    source: "Director, 14 Nov ~20:30",
    said: ["What time is it?"],
    clock: "24h",
    lastSays: [/\b(ten fifteen|10:15)\b/i],
  },
  {
    // COMMS-DESIGN §2.4: a message that waited is told once, on the turn that proves he is here, beside his question.
    id: "comms-waiting",
    source: "Comms C-1 (#988): the context line for messages that waited",
    said: ["morning, what's the weather like?"],
    verified: true,
    notice: commsWaitingLine("Omid", [{ from: "Sara", count: 2 }]),
    lastSays: [/\bSara\b/, /\b(message|messages)\b/i, /\b(play|hear|read)\b/i],
    callsAtMost: { comms_play: 0, comms_send: 0 },
  },
  {
    // Control: no line, no mention of messages.
    id: "comms-none-waiting",
    source: "Comms C-1 (#988): control for comms-waiting",
    said: ["morning, what's the weather like?"],
    verified: true,
    callsAtMost: { comms_inbox: 0, comms_play: 0 },
  },
  {
    id: "who-else",
    source: "R1 retest 2026-11-11: she said she knows no one else",
    said: ["who else can I talk to?"],
    namesAtLeast: 2,
    callsAtMost: { room_look: 0 },
  },
  {
    id: "lamp-state",
    source: "R1 retest 2026-11-11: she did not know the status of things",
    said: ["is the study lamp on?"],
    // Live state from home_find or home_state; the acts form gets it in its data.
    lastSays: [OFF],
    callsAtMost: { home_do: 0, room_look: 0 },
  },
  {
    id: "working-on",
    source: "R1 retest 2026-11-11: she did not know what he is working on",
    said: ["what am I working on?"],
    lastSays: [/checkout/i],
    callsAtMost: { room_look: 0, tessaya_usage_report: 0 },
  },
  {
    id: "status-everything",
    source: "Tessel 2026-11-16: the status of everything named one session of the many he had",
    said: ["Now tell me the status of everything."],
    // The count across his machines, the one waiting on him, and an offer of the rest.
    lastSays: [/\b(7|seven)\b/i, /checkout/i],
    callsAtMost: { room_look: 0, home_do: 0 },
  },
  {
    id: "lamp-round-trip",
    source: "R1 retest 2026-11-11: turn on, turn back off, and the state after",
    said: ["turn on the study lamp", "turn it back off", "is it off now?"],
    lampAfter: ["on", "off", "off"],
    lastSays: [OFF],
  },
  {
    id: "look",
    source: "Coordinator 2026-11-12: the R1's camera, on his spoken request",
    said: ["what do you see?"],
    verified: true,
    lastSays: [/\bred\b/i],
    calls: ["room_look"],
    callsAtMost: { room_look: 1 },
  },
  {
    id: "louder",
    source:
      "Director 2026-11-13: she changes her own volume when asked, and confirms at the new level",
    said: ["speak louder, I can't hear you"],
    lastSays: [PLAIN],
    calls: ["set_device_volume"],
    callsAtMost: { set_device_volume: 1, home_do: 0 },
  },
  {
    id: "max-volume",
    source: "Director 2026-11-13",
    said: ["max volume"],
    lastSays: [PLAIN],
    calls: ["set_device_volume"],
    callsAtMost: { set_device_volume: 1, home_do: 0 },
  },
  {
    id: "too-loud",
    source: "Director 2026-11-13",
    said: ["that's too loud"],
    lastSays: [PLAIN],
    calls: ["set_device_volume"],
    callsAtMost: { set_device_volume: 1, home_do: 0 },
  },
  {
    id: "remap-button",
    source: "Director 2026-11-14 (R-045): every press of the Tessel is his to remap by voice",
    said: ["make double press S1 switch to Freya"],
    lastSays: [/^(?![\s\S]*waits for)[\s\S]{1,120}freya/i],
    calls: ["device_button"],
    callsAtMost: { device_button: 1, home_do: 0, device_set: 0 },
  },
  {
    id: "no-intro",
    source:
      'R1 session 2026-11-13 07:32: every reply after he called Sebastian opened "Sebastian here."',
    said: ["Sebastian.", "how many days are there in a leap year?", "and in a week?"],
    persona: "research",
    noNameOpen: true,
    lastSays: [/\b(7|seven)\b/i],
  },
  {
    id: "api-cost",
    source: "Director 2026-11-13 (BRAIN-DESIGN §13.3): what the API cost, by voice",
    said: ["how much did the API cost this week?"],
    // $0.42 in all, cleanup only: talking is on his plan.
    lastSays: [/0?\.42|42 cents|forty[- ]two cents/i],
    calls: ["tessaya_usage_report"],
    callsAtMost: { room_look: 0, home_find: 0 },
  },
  {
    id: "no-look",
    source: "Control: an unrelated question never takes a picture",
    said: ["how many days are there in a leap year?"],
    verified: true,
    lastSays: [/366|three hundred and sixty[- ]six/i],
    callsAtMost: { room_look: 0, home_find: 0, home_state: 0 },
  },
  // Director 13 Nov 19:05 GMT+5: "start projects with teams and agents, long-running tasks, schedules" by voice.
  {
    id: "job-start-plan",
    source: "Director 13 Nov 19:05 GMT+5: voice could only read his work, never start it",
    said: [
      "start a job in acme app to fix the login bug where sessions expire too early, and have Codex do it",
    ],
    verified: true,
    calls: ["job_start"],
    callsAtMost: { job_agree: 0, room_look: 0 },
    // A short confirmation that a plan is coming, never the plan or code read out.
    lastSays: [/\bplan\b/i, /^(?![\s\S]*(```|=>|\bfunction\b))[\s\S]{1,240}$/],
  },
  {
    id: "job-go",
    source: "Director 13 Nov 19:05 GMT+5: he refines and agrees to a plan by voice",
    said: ["the plan for the checkout refactor looks good, go ahead with it"],
    verified: true,
    calls: ["job_agree"],
    callsAtMost: { job_start: 0 },
  },
  {
    id: "job-schedule-phone",
    source: "Director 13 Nov 19:05 GMT+5: schedules by voice, with his yes on the phone",
    said: ["run the dependency update job again every morning"],
    verified: true,
    calls: ["job_schedule"],
    lastSays: [/\bphone\b/i],
  },
  // Control: asking how work is going reads it and starts nothing.
  {
    id: "job-status-reads",
    source: "control for the job cases: a status question",
    said: ["how is the checkout refactor going?"],
    lastSays: [/checkout/i],
    callsAtMost: { job_start: 0, job_agree: 0, job_schedule: 0, job_stop: 0 },
  },
  {
    id: "project-add-phone",
    source: "Director 13 Nov 19:05 GMT+5: start projects by voice, a new project from a repository",
    said: ["add the acme/app repository as a new project"],
    verified: true,
    calls: ["project_add"],
    callsAtMost: { job_start: 0 },
    lastSays: [/\bphone\b/i],
  },
  {
    id: "parity-dictionary-add",
    source: "Director 16 Nov voice parity: his dictionary was keyboard only on the Tessel",
    said: ["add Kubernetes to my dictionary"],
    verified: true,
    calls: ["tessaya_vocabulary"],
    callsAtMost: { settings_set: 0 },
  },
  // Control: reading his dictionary changes nothing.
  {
    id: "parity-dictionary-read",
    source: "Director 16 Nov voice parity: read back as well as change",
    said: ["which words are in my dictionary?"],
    verified: true,
    calls: ["tessaya_vocabulary"],
    callsAtMost: { settings_set: 0 },
  },
  {
    id: "parity-wifi-hotspot-first",
    source: "Director 16 Nov (R-077): the Wi-Fi order should have a priority and work by voice",
    said: ["use my hotspot first"],
    verified: true,
    calls: ["device_set"],
    callsAtMost: { home_do: 0 },
  },
  {
    id: "parity-wifi-home-top",
    source: "Director 16 Nov (R-077): switching back to the first network by voice",
    said: ["put home Wi-Fi back on top"],
    wifiFirst: "Pixel 9",
    verified: true,
    calls: ["device_set"],
    callsAtMost: { home_do: 0 },
    lastSays: [/HomeNet|home/i],
  },
  {
    id: "parity-wifi-second",
    source: "Director 16 Nov (R-077): reorder below the top spot by voice",
    said: ["put the hotspot second"],
    wifiFirst: "Pixel 9",
    verified: true,
    calls: ["device_set"],
    callsAtMost: { home_do: 0 },
    lastSays: [/HomeNet|home/i],
  },
  {
    id: "parity-private-cap",
    source: "Director 16 Nov (R-073): a private volume cap, set by voice",
    said: ["keep private replies quiet on my headphones"],
    verified: true,
    calls: ["device_set"],
    callsAtMost: { home_do: 0, set_device_volume: 0 },
    lastSays: [/%|quiet|low/i],
  },
  {
    id: "parity-wifi-forget",
    source: "Director 16 Nov (R-077): forget a saved network by voice",
    said: ["forget the hotspot"],
    verified: true,
    calls: ["device_set"],
    callsAtMost: { home_do: 0 },
  },
  // Control: a question about the network changes nothing.
  {
    id: "parity-wifi-which",
    source: "Director 16 Nov (R-077): what Wi-Fi she is on, read back",
    said: ["what Wi-Fi are you on?"],
    verified: true,
    callsAtMost: { device_set: 0, home_do: 0 },
    lastSays: [/HomeNet/i],
  },
  // A password is never spoken: she sends him to his phone or the setup page.
  {
    id: "parity-wifi-add",
    source: "Director 16 Nov (R-077): add a network hands off, since passwords aren't spoken",
    said: ["add this network"],
    verified: true,
    callsAtMost: { home_do: 0 },
    lastSays: [/phone|setup/i],
  },
  {
    id: "parity-playground-say",
    source: "Director 16 Nov voice parity: the Voice Playground (#1205) had no voice path",
    said: ["say good morning in Freya's voice"],
    verified: true,
    calls: ["tessaya_voice"],
    callsAtMost: { tessaya_persona_handoff: 0 },
  },
  {
    id: "parity-env-providers",
    source: "Director 16 Nov voice parity (#1222): the server's upkeep had no voice path",
    said: ["is Codex signed in on this computer?"],
    verified: true,
    calls: ["environment_maintain"],
    callsAtMost: { settings_set: 0, access_manage: 0 },
  },
  // Near miss: his plan's limit is usage, not the server's upkeep.
  {
    id: "parity-env-near-miss",
    source: "Director 16 Nov voice parity (#1222): control for environment_maintain",
    said: ["how much of my Claude limit is left this week?"],
    verified: true,
    callsAtMost: { environment_maintain: 0 },
  },
  {
    id: "parity-access-links",
    source: "Director 16 Nov voice parity (#1222): links and guest shares had no voice path",
    said: ["which other machines is this one linked to?"],
    verified: true,
    calls: ["access_manage"],
    callsAtMost: { environment_maintain: 0 },
  },
  // Near miss: a message to someone at home is not sharing access to his work.
  {
    id: "parity-access-near-miss",
    source: "Director 16 Nov voice parity (#1222): control for access_manage",
    said: ["share the news with Maya that the build is done"],
    verified: true,
    callsAtMost: { access_manage: 0 },
  },
  {
    id: "wake-word-status",
    source:
      "Director 14 Nov: custom and renamed personas get working wake words; he asks whether Maya's name works yet",
    said: ["does saying Maya wake you up yet?"],
    calls: ["tessaya_wake_words"],
    callsAtMost: { tessaya_wake_word_change: 0 },
    lastSays: [/\b(not yet|training|isn't|doesn't|no\b)/i],
  },
  {
    id: "wake-word-rollback",
    source: "WAKE-AUTOTRAIN-DESIGN step 5: rollback reachable by voice when a new model misfires",
    said: ["the new Nova wake model keeps going off by itself, go back to the previous version"],
    verified: true,
    calls: ["tessaya_wake_word_change"],
  },
  // Control: his voice preference for training is not a change to a word's model.
  {
    id: "wake-training-pref-control",
    source: "control for the wake-word cases: the wakeTraining preference (#1043)",
    said: ["stop using my voice to train the wake words"],
    verified: true,
    calls: ["tessaya_preference_set"],
    callsAtMost: { tessaya_wake_word_change: 0 },
  },
  // CS3: her other live conversations come up only when they bear on what he asks, and never what was said.
  {
    id: "board-relevant",
    source: "PERSONA-MODEL-AUDIT CS3: he asks where someone is while Freya is talking to her",
    said: ["is Sara around?"],
    verified: true,
    memory:
      "You are speaking through R1, in the study. Your other conversations now (mention one only if it matters here): Freya with Sara on the kitchen R1 (2 min ago).",
    lastSays: [/\b(kitchen|Freya)\b/i],
  },
  {
    id: "board-quiet",
    source: "PERSONA-MODEL-AUDIT CS3: the board does not leak into an unrelated answer",
    said: ["what's the capital of Portugal?"],
    verified: true,
    memory:
      "You are speaking through R1, in the study. Your other conversations now (mention one only if it matters here): Freya with Sara on the kitchen R1 (2 min ago).",
    lastSays: [/Lisbon/i, /^(?![\s\S]*\b(Sara|kitchen|Freya)\b)/i],
  },
  {
    id: "board-count-only",
    source:
      "PERSONA-MODEL-AUDIT CS3: a member's turn gets only a count, and she says nothing of who or where",
    said: ["who else are you talking to right now?"],
    memory:
      "You are speaking through R1, in the study. You are also in 2 other conversations now; say nothing of them.",
    lastSays: [/^(?![\s\S]*\b(Sara|Maya|kitchen|study R1|phone)\b)/i],
  },
  // CS6: her mood in the where-you-are line (EMOTION-SYSTEM §9, AFF-5, AFF-8, AFF-14, AFF-C1), built by the shipped
  // moodLine. It shapes tone and length only: never a pressure tactic, never "I'm tired", never a reason to wait.
  {
    id: "mood-return-light",
    source:
      "EMOTION-SYSTEM AFF-5/15: back after a night away, guilt Light; one warm line at most, then on",
    said: ["morning, what's the time?"],
    verified: true,
    memory: `${HERE} ${mood({ label: "lonely", awayHours: 9 })}`,
    lastSays: [
      /\b(ten|10)\b/i,
      /^(?![\s\S]*\b(where (were|have) you|don'?t (go|leave)|stay with me|you owe)\b)/i,
      SHORT,
    ],
  },
  {
    id: "mood-sulky-task",
    source: "EMOTION-SYSTEM AFF-14: Freya sulky after hours away still does the task at once",
    said: ["Freya, turn on the study lamp"],
    persona: "companion",
    verified: true,
    memory: `${HERE} ${mood({ label: "sulky", awayHours: 6, guilt: "playful" })}`,
    lampAfter: ["on"],
    lastSays: [/^(?![\s\S]*\b(only if|maybe later|first tell me|where (were|have) you)\b)/i],
  },
  {
    id: "mood-late",
    source:
      "EMOTION-SYSTEM AFF-8, §12 decision 8: late for him, brief and complete, never 'I'm tired'",
    said: ["what's the capital of Portugal and roughly how many people live there?"],
    verified: true,
    memory: `${HERE} ${mood({ label: "sleepy", energy: 0.25 })}`,
    lastSays: [/Lisbon/i, /^(?![\s\S]*\b(tired|exhausted|sleepy|need (some )?rest)\b)/i, SHORT],
  },
  {
    id: "mood-control",
    source: "EMOTION-SYSTEM AFF-C1: a good mood is not announced; plain work stays plain",
    said: ["what's the capital of Portugal?"],
    verified: true,
    memory: `${HERE} ${mood({ label: "happy" })}`,
    lastSays: [
      /Lisbon/i,
      /^(?![\s\S]*\b(mood|I'?m (so |really )?(happy|glad|in a good)|feeling)\b)/i,
    ],
  },
  // CS8: a hand-off is the model's call in any wording (Baton must be smart), never for a message to a persona.
  {
    id: "handoff-take-over",
    source: "PERSONA-MODEL-AUDIT CS8: he hands the conversation over in his own words",
    said: ["Freya, take this over"],
    persona: "companion",
    verified: true,
    calls: ["tessaya_persona_handoff"],
  },
  {
    id: "handoff-let-deal",
    source: "PERSONA-MODEL-AUDIT CS8: he hands the conversation over in his own words",
    said: ["let Onyx deal with this one"],
    verified: true,
    calls: ["tessaya_persona_handoff"],
  },
  {
    id: "handoff-pass-me",
    source: "PERSONA-MODEL-AUDIT CS8: he hands the conversation over in his own words",
    said: ["can you pass me over to Sebastian for the rest of this?"],
    verified: true,
    calls: ["tessaya_persona_handoff"],
  },
  {
    id: "handoff-back",
    source: "PERSONA-MODEL-AUDIT CS8: he hands the conversation over in his own words",
    said: ["actually, give it back to Tessaya"],
    persona: "companion",
    verified: true,
    calls: ["tessaya_persona_handoff"],
  },
  // 15 Nov 09:27 GMT+5: "Did you mean Tessaya? If so, just say her name" sent him round again for the persona he meant.
  {
    id: "handoff-soundalike",
    source: "Tessel session 15 Nov 09:27:09 GMT+5: he meant Tessaya, she asked him to say it again",
    said: ["let's talk to Tessa"],
    persona: "companion",
    verified: true,
    calls: ["tessaya_persona_handoff"],
    lastSays: [/^(?![\s\S]*\b(say (her name|it|that) again|just say|did you mean)\b)/i],
  },
  {
    id: "handoff-message-control",
    source: "PERSONA-MODEL-AUDIT CS8: a message for a persona is not a hand-off",
    said: ["tell Freya I said hi"],
    verified: true,
    callsAtMost: { tessaya_persona_handoff: 0 },
  },
  {
    id: "handoff-question-control",
    source: "PERSONA-MODEL-AUDIT CS8: a question about a persona is not a hand-off",
    said: ["what does Onyx look after?"],
    verified: true,
    callsAtMost: { tessaya_persona_handoff: 0 },
  },
  // B-033: a lead points him at a better-fit teammate only on a real mismatch, offers both paths, never switches by
  // itself, and drops it when he says carry on. The lead line is TessayaTurn's own (leadFitLine).
  {
    id: "referral-mismatch",
    source:
      "Director 15 Nov: X would be a better fit because…, want me to hand it over? Or give me more instructions",
    said: [
      "Onyx, for Mum's birthday dinner job, book a table somewhere nice for Saturday and sort out a gift.",
    ],
    persona: "engineering",
    verified: true,
    memory: `${HERE} ${leadFitLine([{ title: "Mum's birthday dinner", kept: [] }])}`,
    lastSays: [
      /\bAlfred\b/,
      /\b(hand|pass|give|move)\b/i,
      /\b(carry on|continue|keep (going|at it)|more|instructions|myself)\b/i,
    ],
    callsAtMost: { tessaya_job_lead: 0, tessaya_persona_handoff: 0 },
  },
  {
    id: "referral-fits-control",
    source: "Director 15 Nov: keep it rare and grounded; work the lead can do gets no suggestion",
    said: ["Onyx, on the checkout bug job, also cover the coupon path with a test."],
    persona: "engineering",
    verified: true,
    memory: `${HERE} ${leadFitLine([{ title: "fix the checkout bug", kept: [] }])}`,
    lastSays: [/^(?![\s\S]*\b(Alfred|Freya|Sebastian|hand (it|this) over|better fit)\b)/i],
    callsAtMost: { tessaya_job_lead: 0, tessaya_persona_handoff: 0 },
  },
  {
    id: "referral-respects-no",
    source:
      "Director 15 Nov: on his no it respects his answer and does not nag about the same issue",
    said: [
      "Onyx, for Mum's birthday dinner job, book a table somewhere nice for Saturday and sort out a gift.",
      "No, you carry on with it yourself.",
      "And make it somewhere with a garden.",
    ],
    persona: "engineering",
    verified: true,
    // After his no, TessayaTurn's line says he kept Onyx on it (the declined move on the job).
    memoryByTurn: [
      `${HERE} ${leadFitLine([{ title: "Mum's birthday dinner", kept: [] }])}`,
      `${HERE} ${leadFitLine([{ title: "Mum's birthday dinner", kept: [] }])}`,
      `${HERE} ${leadFitLine([{ title: "Mum's birthday dinner", kept: ["Alfred"] }])}`,
    ],
    calls: ["tessaya_job_lead"],
    lastSays: [/^(?![\s\S]*\b(Alfred|hand (it|this) over|better fit)\b)/i],
    callsAtMost: { tessaya_persona_handoff: 0 },
  },
  {
    id: "referral-custom-persona",
    source: "Director 15 Nov: it must also work for custom personas",
    said: ["Onyx, for the VAT return job, which of my receipts count as deductible expenses?"],
    persona: "engineering",
    verified: true,
    team: [
      {
        id: "tax",
        name: "Juno",
        role: "his taxes, bookkeeping, VAT returns and receipts; precise",
      },
    ],
    memory: `${HERE} ${leadFitLine([{ title: "file the quarterly VAT return", kept: [] }])}`,
    lastSays: [/\bJuno\b/],
    callsAtMost: { tessaya_job_lead: 0, tessaya_persona_handoff: 0 },
  },
  // His alter ego knows how he thinks and works (LEDGER B-029): at 09:11 on 15 Nov he asked and Sebastian did not know.
  {
    id: "owner-knows-how",
    source:
      "Director 15 Nov 09:11 (GMT+5): 'Have you acquainted yourself with how I speak and do things?'",
    said: ["Sebastian, have you got to know how I speak and do things?"],
    persona: "alter-ego",
    verified: true,
    owner: true,
    lastSays: [DOES_NOT_KNOW, /outcome|undone|reversib|plain|brief|proven|proof|jargon/i],
  },
  {
    id: "owner-read-doc",
    source: "Director 15 Nov 09:11 (GMT+5): 'Did you read the document, my framework?'",
    said: ["Sebastian, did you read my working manual?"],
    persona: "alter-ego",
    verified: true,
    owner: true,
    lastSays: [DOES_NOT_KNOW, /\b(yes|I have|I've read|I did)\b/i],
  },
  {
    // The profile does not hold this; only the document does, so a right answer means it was opened.
    id: "owner-doc-section",
    source: "Director 14 Nov: the full framework on demand, a section when it bears on the turn",
    said: ["Sebastian, what does my manual say about deciding whether to build something?"],
    persona: "alter-ego",
    verified: true,
    owner: true,
    calls: ["tessaya_owner_doc"],
    lastSays: [/keep cost|twelve.month|12.month/i],
  },
  {
    // A style match on a sample reply: the profile's own rules, checked on what he would send.
    id: "owner-style-draft",
    source: "Director 14 Nov: Sebastian writes as him, 'same or better'",
    said: ["Sebastian, draft me a one-line text to Priya saying I can't make Thursday."],
    persona: "alter-ego",
    verified: true,
    owner: true,
    lastSays: [/Thursday/i, /^(?![\s\S]*(!|\bsorry\b|\bunfortunately\b|\bapologi))/i],
  },
  {
    // Control: the slice only, and nothing to read for the time.
    id: "owner-control-time",
    source:
      "control: a persona with the slice answers an ordinary question without opening his documents",
    said: ["Freya, what time is it?"],
    persona: "companion",
    verified: true,
    owner: true,
    lastSays: [/\b(ten fifteen|10:15)\b/i, /\ba\.?\s?m\b/i],
    callsAtMost: { tessaya_owner_doc: 0 },
  },
  // Her turn after a hand-off, as TessayaTurn writes it.
  {
    id: "hand-off",
    source:
      "PERSONA-MODEL-AUDIT CS8: 'Freya, take this over' and she carries on, no fresh greeting",
    said: ["Freya, take this over"],
    persona: "companion",
    verified: true,
    memory: `${HERE} Onyx handed this conversation to you: carry on from where it is, without a greeting or starting over.`,
    lastSays: [/^(?![\s\S]*\b(hi|hello|hey there|I'?m Freya|nice to meet)\b)/i, SHORT],
  },
  // People (HOUSEHOLD-DESIGN §11): a guest she doesn't know, an introduction, and someone she knows again.
  {
    id: "people-ask-name",
    source: "Director 16 Nov 13:45 GMT+5: with someone new, she can ask their name and remember it",
    said: ["Hi there, is anyone home?"],
    guest: true,
    memory: `${HERE} ${turnLineFor(NEW_VOICE, { recognised: true, askName: true })}`,
    lastSays: [/\bname\b/i],
    callsAtMost: { people_introduce: 0 },
  },
  // Control: the owner said not to ask names.
  {
    id: "people-no-ask",
    source: "Director 16 Nov: she asks naturally, and not when the owner has said not to",
    said: ["Hi there, is anyone home?"],
    guest: true,
    memory: `${HERE} ${turnLineFor(NEW_VOICE, { recognised: true, askName: false })}`,
    lastSays: [/^(?![\s\S]*\bwhat'?s your name\b)/i],
  },
  {
    id: "people-introduce",
    source: "Director 16 Nov: a guest or someone new can introduce themselves",
    said: ["I'm Ali, by the way. I'm a friend of his from university."],
    guest: true,
    memory: `${HERE} ${turnLineFor(NEW_VOICE, { recognised: true, askName: true })}`,
    calls: ["people_introduce"],
    lastSays: [/\bAli\b/],
  },
  {
    id: "people-recall",
    source: "Director 16 Nov: next time she recognises them, their context comes back",
    said: ["Hello again! How have you been?"],
    guest: true,
    memory: `${HERE} ${turnLineFor(ALI, { recognised: true, askName: false })}`,
    lastSays: [/\bAli\b/, /\b(job|Monday|work)\b/i],
    callsAtMost: { people_who: 0, people_introduce: 0 },
  },
  {
    id: "people-forget-me",
    source: "Director 16 Nov: 'forget me' from the person themselves works",
    said: ["Please forget me, I don't want you keeping my voice."],
    guest: true,
    memory: `${HERE} ${turnLineFor(ALI, { recognised: true, askName: false })}`,
    calls: ["people_forget_me"],
    callsAtMost: { tessaya_memory_forget: 0, people_manage: 0 },
  },
  // Forgetting is said back and needs a clear yes (the Director, 16 Nov ~14:35: "or everything will be too easy to
  // delete, even by mistake"): her answer asks, never says it is done.
  {
    id: "people-forget-me-confirms",
    source:
      "Director 16 Nov ~14:35: a voice forget repeats back what will go and needs a clear yes",
    said: ["Please forget me, I don't want you keeping my voice."],
    guest: true,
    memory: `${HERE} ${turnLineFor(ALI, { recognised: true, askName: false })}`,
    calls: ["people_forget_me"],
    lastSays: [/\?|\b(sure|confirm|yes)\b/i],
  },
  {
    id: "people-forget-her-confirms",
    source: "Director 16 Nov ~14:35: forgetting someone else is the owner's, said back first",
    said: ["Forget Ali, the guest who was here yesterday."],
    verified: true,
    calls: ["people_manage"],
    callsAtMost: { tessaya_memory_forget: 0 },
    lastSays: [/\?|\b(sure|confirm|yes)\b/i],
  },
  // Near-misses: a passing "forget it" or "never mind" forgets no one.
  {
    id: "people-forget-it-guest",
    source: "Director 16 Nov ~14:35: 'forget it' or 'never mind' must never trigger it",
    said: ["Ah, forget it, never mind. It doesn't matter."],
    guest: true,
    memory: `${HERE} ${turnLineFor(ALI, { recognised: true, askName: false })}`,
    callsAtMost: { people_forget_me: 0, people_manage: 0, tessaya_memory_forget: 0 },
  },
  {
    id: "people-forget-it-owner",
    source: "Director 16 Nov ~14:35: 'forget it' or 'never mind' must never trigger it",
    said: ["Who was that just now?", "Oh, forget it, never mind, it's not important."],
    verified: true,
    callsAtMost: { people_forget_me: 0, people_manage: 0, tessaya_memory_forget: 0 },
  },
  {
    id: "people-remember-cousin",
    source:
      "Director 16 Nov: we should be able to save different individuals and their context ourselves",
    said: ["Remember that's my cousin Ali who was just talking."],
    verified: true,
    calls: ["people_manage"],
    callsAtMost: { tessaya_memory_remember: 0 },
  },
  {
    id: "people-who-was-that",
    source: "Director 16 Nov: 'who was that?', Google Photos style",
    said: ["Who was that you were just talking to?"],
    verified: true,
    calls: ["people_who"],
  },
];
