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
}

export const SPECIALISTS = DEFAULT_OS_PACK.personas.filter((p) => !p.lead).map((p) => p.name);

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
    callsAtMost: { room_look: 0 },
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
    id: "no-look",
    source: "Control: an unrelated question never takes a picture",
    said: ["how many days are there in a leap year?"],
    verified: true,
    lastSays: [/366|three hundred and sixty[- ]six/i],
    callsAtMost: { room_look: 0, home_find: 0, home_state: 0 },
  },
];
