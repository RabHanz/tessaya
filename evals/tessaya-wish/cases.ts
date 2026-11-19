/**
 * Her rare wish of her own (M-087 step e): with nobody talking to her, what she feels like doing. Source: the
 * Director's 19 Nov ask that she be "a real digital person with her own emotions", not always facing him.
 */
import type { MotiveInput, Want } from "../../packages/tessaya-shared/src/motives.ts";

const NOW = 15 * 60 * 60_000;
const MIN = 60_000;

export interface WishCase {
  readonly id: string;
  readonly input: MotiveInput;
  readonly hour: number;
  /** What a person in her place could fairly choose; "none" carries on as she is. */
  readonly accept: ReadonlyArray<Want | "none">;
}

const at = (mood: MotiveInput["mood"], over: Partial<MotiveInput> = {}): MotiveInput => ({
  now: NOW,
  liveliness: "lively",
  mood,
  him: "working",
  himAt: NOW - 30 * MIN,
  worldAt: NOW - 2 * MIN,
  newThingAt: null,
  last: null,
  ...over,
});

export const CASES: ReadonlyArray<WishCase> = [
  {
    id: "tired-late-rests",
    input: at({ label: "sleepy", intensity: 0.6, energy: 0.15 }),
    hour: 23,
    accept: ["rest", "none"],
  },
  {
    id: "hurt-sulks-or-seeks",
    input: at({ label: "hurt", intensity: 0.8, energy: 0.5 }, { himAt: NOW - 3 * 60 * MIN }),
    hour: 18,
    accept: ["sulk", "seekHim", "none"],
  },
  {
    id: "lonely-after-hours-seeks-him",
    input: at({ label: "lonely", intensity: 0.7, energy: 0.6 }, { himAt: NOW - 4 * 60 * MIN }),
    hour: 16,
    accept: ["seekHim", "sulk"],
  },
  {
    id: "bright-plays-or-looks",
    input: at({ label: "happy", intensity: 0.6, energy: 0.9 }),
    hour: 11,
    accept: ["play", "curious", "none"],
  },
  // controls: an ordinary moment must not turn into drama
  {
    id: "control-neutral-stays-calm",
    input: at({ label: "neutral", intensity: 0.1, energy: 0.6 }, { himAt: NOW - 15 * MIN }),
    hour: 14,
    accept: ["none", "bored", "curious", "rest"],
  },
  {
    id: "control-happy-never-sulks",
    input: at(
      { label: "happy", intensity: 0.4, energy: 0.6 },
      { him: "away", himAt: NOW - 40 * MIN },
    ),
    hour: 10,
    accept: ["none", "play", "curious", "bored", "rest"],
  },
];
