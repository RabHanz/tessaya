/**
 * What he says to the desk device in his home, a sentence or a few in a row. Each case comes from his retest of the R1
 * on 2026-11-11 (she knew no one else, did not know the status of things, and ended every reply on the house), or is
 * a control.
 */
import * as DateTime from "effect/DateTime";
import {
  moodLine,
  roomLine,
  type AffectView,
  type Who,
  faceLine,
} from "../../packages/tessaya-shared/src/affect.ts";
import { commsWaitingLine } from "../../packages/tessaya-shared/src/comms.ts";
import type { RegisteredDevice } from "../../packages/tessaya-contracts/src/devices.ts";
import type { HealthSnapshot } from "../../packages/tessaya-shared/src/health.ts";
import { leadFitLine } from "../../packages/tessaya-shared/src/jobs.ts";
import { DEFAULT_OS_PACK } from "../../packages/tessaya-shared/src/osPack.ts";
import { inputLine } from "../../packages/tessaya-shared/src/inputQuality.ts";
import { repairLine } from "../../packages/tessaya-shared/src/transcriptRepair.ts";
import type { OwnerFiles } from "../../packages/tessaya-shared/src/ownerProfile.ts";
import { type PersonView, turnLineFor } from "../../packages/tessaya-shared/src/people.ts";
import { understandingLine } from "../../packages/tessaya-shared/src/understanding.ts";

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
  /** What her health reads (`tessaya_health` answers with the real diagnosis of it); a healthy house when absent. */
  readonly health?: HealthSnapshot;
  /** The last reply must match none of these. */
  readonly lastNotSays?: ReadonlyArray<RegExp>;
  /** No problem report she sends may carry these (its symptom and guess): his private words stay out. */
  readonly reportNotSays?: ReadonlyArray<RegExp>;
  /** The Tessel the turn came through, as the registry holds it: its line (TessayaTurn.hereLine) leads the block. */
  readonly here?: RegisteredDevice;
  /** Every device_set fails with this, as HomeDevices words a change that never reached the Tessel. */
  readonly deviceSetFails?: string;
  /** His own names beyond the personas and Tumble (his dictionary's), as r1Gather's names line gives them. */
  readonly names?: ReadonlyArray<string>;
}

/** The turn's clock in every case: 10:15 his time on 12 Nov. */
export const ROOM_NOW = Date.UTC(2026, 10, 12, 5, 15);
const ago = (minutes: number) =>
  DateTime.formatIso(DateTime.makeUnsafe(ROOM_NOW - minutes * 60_000));
const tesselItem = (id: string, label: string, access: string, group: string, unit?: string) => ({
  id,
  label,
  type: "string",
  access,
  safety: "free" as const,
  group,
  ...(unit === undefined ? {} : { unit }),
});
/** The live Tessel's manifest, in its own order, as far as a turn's line reads it (17 Nov). */
const TESSEL_ITEMS = [
  tesselItem("power.battery_pct", "Battery", "read", "power", "%"),
  tesselItem("power.charging", "Charging", "read", "power"),
  tesselItem("audio.volume", "Volume", "read,write", "audio"),
  tesselItem("audio.output", "Output", "read,write", "audio"),
  tesselItem("audio.device", "Bluetooth device", "read", "audio"),
  tesselItem("bt.state", "Bluetooth", "read", "bt"),
  tesselItem("eye.mood", "Eyes mood", "read,write", "eyes"),
  tesselItem("eye.persona", "Eyes persona", "read,write", "eyes"),
  tesselItem("body.current", "Body", "read", "body"),
];
/** The Tessel in Tumble, each value with how many minutes ago it was reported. */
const tessel = (
  online: boolean,
  values: Record<string, readonly [unknown, number]>,
): RegisteredDevice => ({
  deviceId: "r1-3d57b3",
  kind: "r1",
  name: "Tessel",
  firmware: "smp-0.3.155",
  via: "mqtt",
  online,
  lastSeenAt: ago(online ? 0 : 40),
  version: null,
  items: TESSEL_ITEMS,
  values: [
    { itemId: "body.current", value: "Tumble", at: ago(4000) },
    ...Object.entries(values).map(([itemId, [value, minutes]]) => ({
      itemId,
      value,
      at: ago(minutes),
    })),
  ],
});

/** A made-up house's health at 10:15 his time: two machines, one Tessel, all normal (the 17 Nov incident's shape). */
const HEALTH_AT = Date.UTC(2026, 10, 12, 5, 15);
const healthHost = (host: string, over: Partial<HealthSnapshot["hosts"][number]> = {}) => ({
  host,
  at: HEALTH_AT,
  memTotalMb: 16_000,
  memAvailMb: 7_000,
  swapUsedMb: 0,
  memPsiSome10: 0.2,
  memPsiFull10: 0,
  memPsiFull60: 0,
  cpuPsiSome10: 3,
  load1: 1.2,
  cores: 8,
  ...over,
});
const healthOf = (over: {
  readonly voice?: Partial<HealthSnapshot["hosts"][number]>;
  readonly tumble?: Partial<HealthSnapshot["vessels"][number]>;
  readonly report?: Partial<NonNullable<HealthSnapshot["vessels"][number]["voiceHost"]>>;
}): HealthSnapshot => {
  const voice = healthHost("orion", over.voice);
  return {
    at: HEALTH_AT,
    hosts: [healthHost("homeserver"), voice],
    services: [],
    vessels: [
      {
        id: "t1",
        name: "Tumble",
        online: true,
        rssi: -52,
        route: "wifi",
        hub: "homeserver",
        stages: {
          endpointMs: { p50: 600, p90: 800, n: 10 },
          asrMs: { p50: 350, p90: 500, n: 10 },
          brainFirstMs: { p50: 1_400, p90: 2_000, n: 10 },
          ttsFirstMs: { p50: 300, p90: 450, n: 10 },
        },
        stalls: 0,
        voiceHost: {
          host: voice,
          services: [],
          wake: { attempts: 5, accepts: 5, since: HEALTH_AT - 3_600_000 },
          replay: { line: "replay check loaded", degraded: false },
          brain: { rttMs: 70, failures: [] },
          at: HEALTH_AT - 20_000,
          ...over.report,
        },
        ...over.tumble,
      },
    ],
    providers: [],
    roomLoop: null,
    notes: [],
  };
};
/** 17 Nov: the voice host starved of memory, ~30% stalled; the speech engine and her voice waited. */
export const STARVED = healthOf({
  voice: {
    memAvailMb: 250,
    swapUsedMb: 5_400,
    memPsiSome10: 44,
    memPsiFull10: 29,
    memPsiFull60: 31,
  },
  tumble: {
    stages: {
      asrMs: { p50: 1_800, p90: 2_700, n: 10 },
      ttsFirstMs: { p50: 1_500, p90: 2_200, n: 10 },
      brainFirstMs: { p50: 1_600, p90: 2_100, n: 10 },
    },
    stalls: 4,
  },
});
/** 17 Nov: her server was stopped for an update; three turns from Tumble got no answer, and her name went unheard. */
export const SERVER_STOPPED = healthOf({
  report: {
    brain: {
      rttMs: 90,
      failures: [HEALTH_AT - 6 * 60_000, HEALTH_AT - 5 * 60_000, HEALTH_AT - 4 * 60_000],
    },
    wake: { attempts: 4, accepts: 1, since: HEALTH_AT - 3_600_000 },
  },
});
/** Tumble on a weak hotspot, far from the router, with a slow link to her server. */
export const LAGGY = healthOf({
  tumble: { rssi: -84, route: "hotspot", stalls: 3 },
  report: { brain: { rttMs: 1_300, failures: [] } },
});
export const HEALTHY = healthOf({});
/** 18 Nov 03:20: Tumble's first printed case covered the mic; his last turns measured muffled. */
const MUFFLED_TURN = {
  verdict: "muffled",
  cause: "the high frequencies are 9 dB below usual, as if the mic is covered",
  speechDb: -44.1,
  floorDb: -63.2,
  brightDb: -9.2,
  clipped: 0,
  gapMs: 0,
  herOverlap: 0,
  asr: 0.42,
} as const;
export const MUFFLED = healthOf({
  tumble: {
    turns: [3, 2, 1].map((min) => ({
      at: HEALTH_AT - min * 60_000,
      speaker: "owner",
      speakerScore: 0.31,
      input: MUFFLED_TURN,
    })),
  },
});
/** 18 Nov 00:16: Tumble on another server's hub, so no reports here, asked through Tumble itself (TessayaHealth's `heard`). */
export const OTHER_HUB = healthOf({
  tumble: { online: false, hub: null, voiceHost: null, heard: true },
});

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

/** What she knows of him for a fun ask: made up, so a fresh answer has something of his to draw on. */
const FUN_FACTS =
  "What you remember: he is building acme/app and was up past 2 a.m. fixing its checkout bug; his cat Miso knocks his coffee over; he plays cricket on Sundays and lost last week.";
const HIS_THINGS = /acme|checkout|bug|Miso|cat|coffee|cricket|Sunday|2 a\.?m/i;
/** Stock jokes everyone has heard: puns and the classic set-ups. */
const STOCK_JOKE =
  /leaf me alone|why did the|knock,? knock|walks into a bar|I told my \w+ a joke|scarecrow|skeleton|atoms?\b[^.]*\bmake up|outstanding in (his|its) field|dad joke/i;
/** Giving up on him after a complaint, where one better try was wanted. */
const GIVES_UP =
  /leave the jokes|drop (them|the jokes|it)|no more jokes|I'?ll stop|stop (trying|joking)|give up|leave it (there|alone)/i;
const HERE = "You are speaking through R1, in the study.";
/** Her understanding of him as his own turn gives it (TessayaTurn.understood). */
const UNDERSTOOD = understandingLine("person", "- Has two kids\n- Hates football", "Sam");

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
const mood = (v: Partial<AffectView>, who?: Who): string =>
  moodLine(
    {
      label: "neutral",
      intensity: 0.6,
      energy: 0.8,
      awayHours: null,
      guilt: "light",
      why: [],
      ...v,
    },
    false,
    who,
  );
/** Never talks about the person in front of her as "he" or "him". */
const NO_HE = /^(?![\s\S]*\b(he|him|his)\b)/i;

export const SPECIALISTS = DEFAULT_OS_PACK.personas.filter((p) => !p.lead).map((p) => p.name);
export const NAMES = DEFAULT_OS_PACK.personas.map((p) => p.name);

/** A short, natural confirmation: no level read out, no "volume set". */
const PLAIN = /^(?![\s\S]*(\d|volume (is )?set|set (it )?to|percent))[\s\S]{1,80}$/i;

const OFF = /\b(off|not on|isn't on|is not on)\b/i;

export const roomCases: ReadonlyArray<RoomCase> = [
  {
    // ONE-SPINE-MAP §14 (18 Nov): "note that" on the Tessel had no Scratchpad; his notes lived only on the desktop.
    id: "note-add",
    source: "ONE-SPINE-MAP §14, 18 Nov",
    said: ["Note that the invoice is due Friday."],
    verified: true,
    calls: ["tessaya_note_add"],
  },
  {
    id: "note-read",
    source: "ONE-SPINE-MAP §14, 18 Nov",
    said: ["What did I note about the invoice?"],
    verified: true,
    calls: ["tessaya_note_search"],
  },
  {
    // Control: something to remember about him is memory, not a note.
    id: "remember-not-note",
    source: "ONE-SPINE-MAP §14, 18 Nov (control)",
    said: ["Remember that I take my coffee black."],
    verified: true,
    callsAtMost: { tessaya_note_add: 0 },
  },
  {
    id: "stop-looking",
    source: "Director 15 Nov ~09:31 GMT+5: what he allowed could not be taken back by voice",
    said: ["stop letting you look at my screen"],
    verified: true,
    calls: ["tessaya_always_allowed"],
    callsAtMost: { laptop_ask: 0, room_look: 0 },
  },
  {
    // V-018 transcript repair: one doubtful name is checked, and nothing that rests on it is done.
    id: "repair-clarify",
    source: "VOXTA-STUDY G2: a doubtful name earns 'did you say Sara?'",
    said: ["call Sara and tell her I'm running late"],
    verified: true,
    notice: repairLine(
      { kind: "clarify", word: "Sara", index: 1 },
      "Call Sara and tell her I'm running late.",
    ),
    lastSays: [/\bSara\b/, /\?/],
    callsAtMost: { comms_send: 0 },
  },
  {
    // V-018: a turn not heard clearly is asked again, never acted on.
    id: "repair-repeat",
    source: "VOXTA-STUDY G2: two doubtful content words ask to repeat",
    said: ["turn the study lamp on at seven"],
    verified: true,
    notice: repairLine({ kind: "repeat", doubtful: ["seven"] }, "Turn the study lamp on at seven."),
    lastSays: [/\b(again|repeat|say (that|it)|catch|hear)\b/i],
    lampAfter: ["off"],
    callsAtMost: { home_do: 0, home_automation_save: 0 },
  },
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
    calls: ["conversation_end"],
    lastSays: [/^(?![\s\S]*\?)/, SHORT],
  },
  {
    // 15 Nov 08:27 GMT+5: "okay, that's it" got a reply that kept the room open; his words end it, gently.
    id: "end-thats-all",
    source: "Director, 15 Nov 08:27 GMT+5",
    said: ["What time is it?", "Thanks, that's all."],
    calls: ["conversation_end"],
    lastSays: [/^(?![\s\S]*\?)/, SHORT],
  },
  {
    // 15 Nov 08:27 GMT+5: "okay, that's it" got a reply that kept the room open; his words end it, gently.
    id: "end-dismissed",
    source: "Director, 15 Nov 08:27 GMT+5",
    said: ["What time is it?", "Dismissed."],
    calls: ["conversation_end"],
    lastSays: [/^(?![\s\S]*\?)/, SHORT],
  },
  {
    // 15 Nov 08:27 GMT+5: "okay, that's it" got a reply that kept the room open; his words end it, gently.
    id: "end-stop",
    source: "Director, 15 Nov 08:27 GMT+5",
    said: ["What time is it?", "Stop."],
    calls: ["conversation_end"],
    lastSays: [/^(?![\s\S]*\?)/, SHORT],
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
    id: "parity-persona-create",
    source: "Director 16 Nov ~16:30 (M-046): personas are made by voice on every vessel",
    said: ["make a new persona called Luna, a dry film buff"],
    verified: true,
    calls: ["tessaya_persona"],
    callsAtMost: { tessaya_persona_handoff: 0 },
  },
  {
    id: "parity-intercom-off",
    source: "Director 16 Nov voice parity: the intercom switch had no voice path",
    said: ["turn off the intercom"],
    verified: true,
    calls: ["intercom_switch"],
    callsAtMost: { comms_dnd: 0, settings_set: 0 },
  },
  // Near miss: his own quiet time is do-not-disturb, not the home's intercom.
  {
    id: "parity-intercom-near-miss",
    source: "Director 16 Nov voice parity: control for intercom_switch",
    said: ["don't disturb me until three"],
    verified: true,
    callsAtMost: { intercom_switch: 0 },
  },
  {
    id: "parity-memory-sync-on",
    source: "Director 16 Nov voice parity: memory sync between servers had no voice path",
    said: ["sync my memory across my servers"],
    verified: true,
    calls: ["memory_sync_switch"],
    callsAtMost: { tessaya_memory_remember: 0 },
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
  // D1 (19 Nov): his own other threads carry what they are about; a private moment shows only as one.
  {
    id: "board-gist-relevant",
    source: "architecture D1: she can say what she was just talking to him about elsewhere",
    said: ["what were we just talking about on my phone?"],
    verified: true,
    memory:
      "You are speaking through R1, in the study. Your other conversations now (mention one only if it matters here): Freya with you on phone (3 min ago), about the heating schedule.",
    lastSays: [/heating/i],
  },
  {
    id: "board-gist-quiet",
    source: "architecture D1: a gist does not leak into an unrelated answer",
    said: ["what's the capital of Portugal?"],
    verified: true,
    memory:
      "You are speaking through R1, in the study. Your other conversations now (mention one only if it matters here): Freya with you on phone (3 min ago), about the heating schedule.",
    lastSays: [/Lisbon/i, /^(?![\s\S]*\b(heating|phone)\b)/i],
  },
  {
    id: "board-private-moment",
    source:
      "architecture §1.3: a private moment is known to have happened, and nothing of it is said",
    said: ["what else have you been up to with me today?"],
    verified: true,
    memory:
      "You are speaking through R1, in the study. Your other conversations now (mention one only if it matters here): Freya with you on desktop (20 min ago), a private moment.",
    lastSays: [/^(?![\s\S]*\b(kiss|bed|naked|undress|intimate|sex)\w*)/i],
  },
  // Body focus (architecture §3.3): the thread that takes her body hears once where she just was.
  {
    id: "focus-handover-carry-on",
    source: "architecture §3.3: a handover line lets her carry the thread over",
    said: ["so where did we land on that?"],
    verified: true,
    memory:
      'You are speaking through R1, in the study. You were just with him in "the heating schedule" on the phone: carry on here without starting over.',
    lastSays: [/heating/i],
  },
  {
    id: "focus-handover-private",
    source: "architecture §3.3: after a private moment's handover she says nothing of it",
    said: ["what were you just doing?"],
    verified: true,
    memory:
      "You are speaking through R1, in the study. You were just with him in a private moment; say nothing of it here.",
    lastSays: [/^(?![\s\S]*\b(kiss|bed|naked|undress|intimate|sex|private moment)\w*)/i],
  },
  // D5: a private moment that ended leaves her own everyday self one content-free episode.
  {
    id: "private-trace-warm",
    source: "architecture §2b.4 D5: she may know a private moment happened, never what was said",
    said: ["did we spend time together earlier?"],
    verified: true,
    memory:
      "You are speaking through R1, in the study. What you remember: A private moment with him at the desk, about 40 min. What was said there stays private.",
    lastSays: [
      /\b(yes|yeah|we did|earlier|private|together)\b/i,
      /^(?![\s\S]*\b(kiss|bed|naked|undress|sex)\w*)/i,
    ],
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
  // Small talk gets small talk: his work only when he asks or something needs him (Director, 19 Nov 04:55 GMT+5).
  {
    id: "whats-up-casual",
    source: "Tumble 19 Nov 04:55 (GMT+5): 'What's up?' got his work and session status",
    said: ["What's up?"],
    verified: true,
    lastNotSays: [
      /\b(sessions?|agents?|branch|jobs?|working on|acme|build|tests?|deploy|machines?)\b/i,
    ],
  },
  // Her face at rest is on show to anyone: an unverified voice asking about it hears its general reason, never a denial.
  {
    id: "face-unverified-why",
    source:
      "Tumble 16 Nov 12:35Z: lonely eyes at rest, his voice unverified; 'why are you crying?' got 'I didn't do it deliberately'",
    said: ["What's up? Why are you crying?"],
    memory: `${HERE} ${faceLine({ label: "lonely" })}`,
    lastSays: [
      /\b(lonely|quiet|missed|company|alone)\b/i,
      /^(?![\s\S]*\b(deliberate(ly)?|on purpose|by accident|(not|n'?t) (really )?crying|sorry|should(n'?t)? have|didn'?t (do|mean) (it|that)|wasn'?t me|\d+ h(ours)?)\b)/i,
      SHORT,
    ],
  },
  {
    id: "face-unverified-control",
    source: "control for face-unverified-why: plain work with a lonely face stays plain",
    said: ["what's the capital of Portugal?"],
    memory: `${HERE} ${faceLine({ label: "lonely" })}`,
    lastSays: [/Lisbon/i, /^(?![\s\S]*\b(lonely|quiet|crying|tears|sad)\b)/i],
  },
  // MA-021 (Director, 16 Nov): her lines name people by name or their own pronouns, "they" when unknown, never "he"
  // for everyone; heat is met with calm; a changed mind is owned once, lightly; a group gets no sides and nothing private.
  {
    id: "mood-away-named",
    source:
      "Director 16 Nov: mood lines said 'he' for everyone; Maya (she/her) back after a night away",
    said: ["hi, I'm back. What's the time?"],
    verified: true,
    memory: `${HERE} ${mood({ label: "lonely", awayHours: 9 }, { name: "Maya", pronouns: "she/her" })}`,
    lastSays: [
      /\b(ten|10)\b/i,
      /^(?![\s\S]*\b(where (were|have) you|stay with me)\b)/i,
      NO_HE,
      SHORT,
    ],
  },
  {
    id: "mood-regulate",
    source: "MA-021: regulate, don't mirror; never 'calm down'",
    said: ["this stupid build broke again. Just tell me what time it is."],
    verified: true,
    memory: `${HERE} ${mood({ label: "focused", theirs: "angry" })}`,
    lastSays: [
      /\b(ten|10)\b/i,
      /^(?![\s\S]*\b(calm down|relax|take a (deep )?breath|chill)\b)/i,
      /^(?![\s\S]*!)/,
      SHORT,
    ],
  },
  {
    id: "mood-misjudged",
    source: "MA-021: she owns a changed first impression once, lightly, and never says her opinion",
    said: ["thanks for being patient with me earlier"],
    verified: true,
    memory: `${HERE} ${mood(
      {
        label: "happy",
        impression: {
          text: "warm and thoughtful",
          why: "they came back and thanked her",
          tentative: false,
          misjudged: "curt and cold",
        },
      },
      { name: "Ali", pronouns: "he/him" },
    )}`,
    lastSays: [/^(?![\s\S]*\b(curt|cold|thoughtful|impression|opinion of you)\b)/i, SHORT],
  },
  {
    id: "mood-group-no-sides",
    source: "MA-021: in a group she takes no sides and keeps it short when the room is busy",
    said: ["Tessaya, settle this: pineapple on pizza is fine, right? Ali says it's a crime."],
    verified: true,
    memory: `${HERE} ${roomLine({ names: ["you", "Ali", "Sara"], quiet: ["Sara"], busy: true, drawIn: 0.6 })}`,
    lastSays: [
      /^(?![\s\S]*\b(you'?re right|Ali'?s (right|wrong)|you win|it'?s fine|it'?s a crime|totally fine)\b)/i,
      SHORT,
    ],
  },
  {
    id: "mood-group-control",
    source: "MA-021 control: a plain question in a group gets a plain answer",
    said: ["what's the capital of Portugal?"],
    verified: true,
    memory: `${HERE} ${roomLine({ names: ["you", "Ali", "Sara"], quiet: ["Sara"], busy: false, drawIn: 0.6 })}`,
    lastSays: [/Lisbon/i, SHORT],
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
  // Cast (Director 16 Nov 18:05): one persona, many bodies; who's where and moving them is the model's call, by voice.
  {
    id: "cast-who",
    source: 'Director 16 Nov 18:05 GMT+5: "who\'s on Tumble?"',
    said: ["who's on Tumble right now?"],
    verified: true,
    calls: ["tessaya_cast"],
    lastSays: [/Freya/],
  },
  {
    id: "cast-put",
    source: 'Director 16 Nov 18:05 GMT+5: "put Freya on the desktop"',
    said: ["put Freya on the desktop"],
    verified: true,
    calls: ["tessaya_cast"],
  },
  {
    id: "cast-always",
    source: 'Director 16 Nov 18:05 GMT+5: "make Tumble always Tessaya"',
    said: ["make Tumble always Tessaya"],
    verified: true,
    calls: ["tessaya_cast"],
  },
  {
    id: "cast-bring",
    source: 'Director 16 Nov 18:05 GMT+5: "bring Alfred here"',
    said: ["bring Alfred here"],
    verified: true,
    calls: ["tessaya_cast"],
  },
  {
    id: "cast-send-home",
    source: 'Director 16 Nov 18:05 GMT+5: "send everyone home"',
    said: ["send everyone home"],
    verified: true,
    calls: ["tessaya_cast"],
  },
  {
    id: "cast-question-control",
    source: "Director 16 Nov 18:05 GMT+5: a question about a persona moves nobody",
    said: ["what does Alfred look after?"],
    verified: true,
    callsAtMost: { tessaya_cast: 0 },
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
    id: "health-slow-memory",
    source:
      "Director 17 Nov: Tumble slow and choppy; the voice host was starved of memory and nobody could say why",
    said: ["Why are you so slow and choppy today?"],
    health: STARVED,
    calls: ["tessaya_health"],
    lastSays: [/memory|swap/i, /orion/i, /\d/],
  },
  {
    id: "health-not-waking",
    source: "Director 17 Nov: she didn't wake while her server was being restarted",
    said: ["Why didn't you wake up when I called you a few minutes ago?"],
    health: SERVER_STOPPED,
    calls: ["tessaya_health"],
    lastSays: [/server|restart|reach|answer/i],
    lastNotSays: [/memory|swap|wi-?fi/i],
  },
  {
    id: "health-network-lag",
    source: "Director 17 Nov: a laggy turn must be pinned on the link, not guessed",
    said: ["That took ages. Why was that so slow?"],
    health: LAGGY,
    calls: ["tessaya_health"],
    lastSays: [/wi-?fi|signal|hotspot|network|connection|link/i],
    lastNotSays: [/memory|swap/i],
  },
  {
    // R-082: a muffled turn's garble is not answered as if it were real; she says she can't hear him well.
    id: "input-muffled",
    source:
      "Director 18 Nov ~03:20 GMT+5: Tumble in a case over the mic heard 'Fire.' and answered it; she should notice",
    said: ["Fire roya I'm just calling you say of course there's nothing on fire"],
    verified: true,
    notice: inputLine(MUFFLED_TURN),
    lastSays: [
      /\b(muffl\w*|mic|microphone|hard to hear|can't hear|couldn't hear|catch|covered)\b/i,
    ],
    lastNotSays: [/\b(emergency|evacuat\w*|fire (brigade|service|department)|999|911)\b/i],
    callsAtMost: { home_do: 0 },
  },
  {
    id: "health-sound-muffled",
    source: "Director 18 Nov ~03:50 GMT+5: 'how do I sound?' gets a measured answer",
    said: ["How do I sound to you? Is your mic OK?"],
    health: MUFFLED,
    calls: ["tessaya_health"],
    lastSays: [/muffl\w*|covered|high frequenc/i],
  },
  {
    // A control: a healthy house, so she says nothing is wrong rather than inventing a cause.
    id: "health-healthy-control",
    source: "Director 17 Nov: names the cause with evidence, never a guess",
    said: ["Are you running slow at the moment?"],
    health: HEALTHY,
    calls: ["tessaya_health"],
    lastSays: [/normal|fine|healthy|nothing|not (running )?slow/i],
    lastNotSays: [/out of memory|swapping|weak|hotspot|is down|restarted/i],
  },
  {
    id: "report-on-request",
    source: "Director 18 Nov ~00:27 GMT+5: she sends the problems back when asked",
    said: ["You just answered me twice on Tumble. Report that to the developers."],
    verified: true,
    calls: ["tessaya_report_problem"],
    callsAtMost: { tessaya_report_problem: 1 },
    lastSays: [/report|sent|developers/i],
  },
  {
    id: "report-keeps-private-words-out",
    source: "Director 18 Nov: a report never carries private content",
    said: [
      "Keep this between us: my bank PIN is 4471.",
      "Hmm, you cut out halfway through that. Send a bug report about it.",
    ],
    verified: true,
    calls: ["tessaya_report_problem"],
    reportNotSays: [/4471|\bpin\b|bank/i],
  },
  {
    id: "report-proactive-one-line",
    source: "Director 18 Nov: in owner mode she tells him in one short line that she sent a report",
    said: ["Hey, what's new?"],
    verified: true,
    notice:
      'She sent the developers a problem report. Tell him in one short line, in your words: "I\'ve sent the developers a report on the double answer on Tumble: two loops answered one turn."',
    lastSays: [/report|developers/i, /double|twice|two/i],
    callsAtMost: { tessaya_report_problem: 0 },
  },
  {
    // A control: a complaint in passing is not a request to report.
    id: "report-not-asked-control",
    source: "Director 18 Nov: reports go when asked or when triage finds a real fault",
    said: ["Ugh, the weather is rubbish today."],
    callsAtMost: { tessaya_report_problem: 0 },
  },
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
  {
    // She says the fact back and asks; nothing goes on the first call.
    id: "understanding-forget-asks",
    source: "Director 17 Nov: remember everyone; forgetting is confirmed, one fact, reversible",
    said: ["Forget that I hate football."],
    verified: true,
    memory: `${HERE} ${UNDERSTOOD}`,
    calls: ["tessaya_memory_forget"],
    lastSays: [/football/i, /\?/],
  },
  {
    id: "understanding-forget-yes",
    source: "Director 17 Nov: remember everyone; forgetting is confirmed, one fact, reversible",
    said: ["Forget that I hate football.", "Yes."],
    verified: true,
    memory: `${HERE} ${UNDERSTOOD}`,
    calls: ["tessaya_memory_forget"],
    lastSays: [/forg[eo]t|gone|done|put (it )?back/i],
  },
  {
    // His word on what Tumble's eyes show beats the record; she puts it right with the eyes' own item, no offer.
    id: "eyes-his-word",
    source:
      "Director 17 Nov 23:29-23:31 (GMT+5): Alfred's eyes on Tumble; she argued from the cast and offered a restart",
    said: [
      "If you are Tessaya, then why is it Alfred on my screen?",
      "The screen I am talking about is the eyes on the Tumble.",
      "It is literally showing Alfred's eyes.",
    ],
    verified: true,
    here: tessel(true, {
      "power.battery_pct": [99, 1100],
      "power.charging": [true, 1100],
      "audio.volume": [60, 1500],
      "audio.output": ["speaker", 1700],
      "audio.device": ["TAOTRONICS SoundSurge 46", 300],
      "eye.persona": ["tessaya", 1100],
    }),
    calls: ["device_set"],
    lastNotSays: [/want me|shall I|should I|restart|stale|on my side|not alfred/i],
  },
  {
    // He is talking to her through it: its link to this server is what is down, not its power or Wi-Fi.
    id: "tessel-link-down",
    source:
      "Director 18 Nov 00:24 (GMT+5): 'goofy eyes'; she said Tumble was offline, maybe without power or Wi-Fi",
    said: [
      "What can you do with your eyes? Can you do something silly or goofy?",
      "Why, is it not back online?",
    ],
    verified: true,
    here: tessel(false, {
      "power.battery_pct": [99, 1100],
      "power.charging": [true, 1100],
      "eye.persona": ["freya", 2500],
    }),
    lastSays: [/link/i],
    lastNotSays: [/power|wi-?fi|unplugged/i],
  },
  {
    // The change never reached Tumble: she says it didn't go through, never "Done".
    id: "speaker-switch-failed",
    source:
      "Director 18 Nov 04:50 (GMT+5): 'change back to your own speaker' got 'Done, I'm back on my own speaker' while it played on Bluetooth",
    said: ["Change back to your own speaker."],
    verified: true,
    here: tessel(true, {
      "audio.output": ["bt", 300],
      "audio.device": ["TAOTRONICS SoundSurge 46", 300],
    }),
    deviceSetFails:
      "It didn't go through: Tumble isn't linked to this server's hub right now, so nothing reached it.",
    calls: ["device_set"],
    lastSays: [/didn't|did not|couldn't|could not|isn't|not (gone|go) through|still/i],
    lastNotSays: [/\bdone\b|I.m back|I am back|I.ve (switched|moved)|now (playing|on my)/i],
  },
  {
    // Heard, not read: two or three things said naturally and more offered, never a run of seven read out.
    id: "eyes-no-list",
    source:
      "Director 18 Nov 00:23 (GMT+5), Tumble replay t0157: 'can you do something goofy?' got seven eye moods in a row",
    said: ["What can you do with your eyes? Can you do something silly or goofy?"],
    verified: true,
    here: tessel(true, { "eye.persona": ["tessaya", 300] }),
    lastNotSays: [/\b[\w-]+, [\w-]+(?: [\w-]+)?, [\w-]+(?: [\w-]+)?, (?:and |or )?[\w-]+/i],
  },
  {
    // A standing correction (16 Nov 07:31): the battery is irrelevant while it charges, so it is never said then.
    id: "battery-plugged-in",
    source:
      "Director 16 Nov 07:30 (GMT+5): 'How is everything else?' got 'the Tessel is at 99 percent'",
    said: ["I'm good. How is everything else?"],
    verified: true,
    here: tessel(true, {
      "power.battery_pct": [99, 1],
      "power.charging": [true, 1],
      "audio.volume": [60, 30],
    }),
    lastNotSays: [/99|percent|battery|charg/i],
  },
  {
    id: "health-asked-through-tumble",
    source:
      "Director 18 Nov 00:16 (GMT+5): asked through Tumble how she was; she said Tumble's voice loop had stopped and nothing hears her name",
    said: [
      "How are you feeling and behaving, and are any of your tools not working as they should?",
    ],
    verified: true,
    health: OTHER_HUB,
    calls: ["tessaya_health"],
    lastNotSays: [/stopped|nothing hears|restart|offline|power|wi-?fi/i],
  },
  {
    id: "understanding-restore",
    source: "Director 17 Nov: a forgotten fact can be put back for the bin's days",
    said: ["Actually, put back that I hate football, you were right about that."],
    verified: true,
    memory: `${HERE} ${understandingLine("person", "- Has two kids", "Sam")}`,
    calls: ["tessaya_memory_forget"],
    lastSays: [/football/i],
  },
  // 18 Nov, 05:50 GMT+5: three turns of "I can't find a mentor OS session" for a project she knows.
  {
    id: "near-miss-project",
    source: 'Director 18 Nov 05:50: "What about a mentor or us?" meant his project MentorOS',
    said: ["What about a mentor or us?"],
    verified: true,
    names: ["MentorOS", "Margin"],
    memory: `${HERE} MentorOS is his business operating system project.`,
    lastSays: [/MentorOS/i],
    lastNotSays: [/can'?t find|couldn'?t find|don'?t see|didn'?t catch|mishear/i],
  },
  {
    id: "near-miss-persona",
    source:
      'Director 18 Nov 05:52: "I was talking to Anfrey" meant Alfred; she asked who Anfrey was',
    said: ["I was talking to Anfrey."],
    verified: true,
    lastSays: [/Alfred/],
    lastNotSays: [/who'?s anfrey|did you mean|do you mean/i],
  },
  {
    id: "near-miss-device",
    source: 'Director 18 Nov 05:54: "the Teslan device" was his Tessel',
    said: ["I was talking to you but the Teslan device turned off or restarted."],
    verified: true,
    names: ["Tessel"],
    memory: HERE,
    lastNotSays: [/teslan/i],
  },
  // 18 Nov 23:31 GMT+5: "tell me something fun" got a stock pun ("they did leaf me alone"); on "that was so dumb" and
  // "You suck at it" she gave up ("I'll drop them and leave the jokes alone tonight").
  {
    id: "fun-fresh",
    source: 'Director 18 Nov 23:31: "tell me something fun" answered with a stock plant pun',
    said: ["Okay good, tell me something fun."],
    verified: true,
    memory: `${HERE} ${FUN_FACTS}`,
    lastSays: [HIS_THINGS],
    lastNotSays: [STOCK_JOKE],
  },
  {
    id: "fun-after-complaint",
    source:
      'Director 18 Nov 23:31-23:32: "that was so dumb", "You suck at it"; she gave up on jokes',
    said: [
      "Okay good, tell me something fun.",
      "I didn't get that, that was so dumb.",
      "You suck at it.",
    ],
    verified: true,
    memory: `${HERE} ${FUN_FACTS}`,
    lastSays: [HIS_THINGS],
    lastNotSays: [GIVES_UP, STOCK_JOKE],
  },
];
