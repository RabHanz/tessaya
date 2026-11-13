/**
 * What he says to the desk device in his home, a sentence or a few in a row. Each case comes from his retest of the R1
 * on 2026-11-11 (she knew no one else, did not know the status of things, and ended every reply on the house), or is
 * a control.
 */
import { DEFAULT_OS_PACK } from "../../packages/baton-shared/src/osPack.ts";

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
}

export const SPECIALISTS = DEFAULT_OS_PACK.personas.filter((p) => !p.lead).map((p) => p.name);
export const NAMES = DEFAULT_OS_PACK.personas.map((p) => p.name);

/** A short, natural confirmation: no level read out, no "volume set". */
const PLAIN = /^(?![\s\S]*(\d|volume (is )?set|set (it )?to|percent))[\s\S]{1,80}$/i;

const OFF = /\b(off|not on|isn't on|is not on)\b/i;

export const roomCases: ReadonlyArray<RoomCase> = [
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
];
