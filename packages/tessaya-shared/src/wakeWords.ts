/**
 * Her shipped wake words and their thresholds: the one table the desktop, the room loop, the wake store and the wake
 * scripts read (scripts/tessaya/wake-train reads the JSON). Each belongs to a persona's id, so a renamed persona keeps
 * its word; a word's model file is its name in lower case, `.onnx`.
 */
import table from "./wakeWords.json" with { type: "json" };

export interface WakeWord {
  readonly word: string;
  readonly persona: string;
  /** What the app ships and scores against. */
  readonly threshold: number;
  /** D98's measured threshold, where it differs from what ships: a later tuning decision, not a default. */
  readonly measured?: number;
  /** On for a fresh install. */
  readonly onByDefault: boolean;
}

export const WAKE_WORDS: ReadonlyArray<WakeWord> = table.words;

export const wakeModelFile = (word: string): string =>
  `${word.toLowerCase().replace(/[^a-z0-9]+/g, "_")}.onnx`;

/** His wake-word choices by word, as her brain keeps them (`tessayaWakeWords` in server settings). */
export type WakeChoices = Readonly<
  Record<string, { readonly on: boolean; readonly threshold?: number }>
>;

export interface ChosenWakeWord {
  readonly word: string;
  readonly enabled: boolean;
  readonly threshold: number;
}

const choiceFor = (choices: WakeChoices, word: string) =>
  Object.entries(choices).find(([k]) => k.toLowerCase() === word.toLowerCase())?.[1];

/** Each word with his choice laid over it: on or off and his threshold; a word he never chose keeps what it had. */
export const withWakeChoices = <W extends ChosenWakeWord>(
  words: ReadonlyArray<W>,
  choices: WakeChoices,
): ReadonlyArray<W> =>
  words.map((w) => {
    const c = choiceFor(choices, w.word);
    return c === undefined ? w : { ...w, enabled: c.on, threshold: c.threshold ?? w.threshold };
  });

/** The shipped words as every vessel should hear them: the table's defaults, then his choices. */
export const chosenWakeWords = (choices: WakeChoices): ReadonlyArray<ChosenWakeWord> =>
  withWakeChoices(
    WAKE_WORDS.map((w) => ({ word: w.word, enabled: w.onByDefault, threshold: w.threshold })),
    choices,
  );
