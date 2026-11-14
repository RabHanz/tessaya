/**
 * What he says to the desk device in his home, a sentence or a few in a row. Each case comes from his retest of the R1
 * on 2026-11-11 (she knew no one else, did not know the status of things, and ended every reply on the house), or is
 * a control.
 */
import { commsWaitingLine } from "../../packages/tessaya-shared/src/comms.ts";
import { DEFAULT_OS_PACK } from "../../packages/tessaya-shared/src/osPack.ts";

export interface RoomCase {
  readonly id: string;
  readonly source: string;
  /** His sentences, in order, in one conversation. */
  readonly said: ReadonlyArray<string>;
  /** Whether his voice is verified as his this turn (the room loop's `tessaya.speaker`). */
  readonly verified?: boolean;
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
  /** His clock preference (timeFormat): how the turn's time is said. */
  readonly clock?: "12h" | "24h";
}

export const SPECIALISTS = DEFAULT_OS_PACK.personas.filter((p) => !p.lead).map((p) => p.name);
export const NAMES = DEFAULT_OS_PACK.personas.map((p) => p.name);

/** A short, natural confirmation: no level read out, no "volume set". */
const PLAIN = /^(?![\s\S]*(\d|volume (is )?set|set (it )?to|percent))[\s\S]{1,80}$/i;

const OFF = /\b(off|not on|isn't on|is not on)\b/i;

export const roomCases: ReadonlyArray<RoomCase> = [
  {
    // 14 Nov: "it isn't using the am pm timing"; the time on his own clock, with the part of the day.
    id: "clock-12h",
    source: "Director, 14 Nov ~20:30",
    said: ["What time is it?"],
    lastSays: [/quarter past ten|10:15/i, /\b(morning|a\.?m\.?)\b/i],
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
];
