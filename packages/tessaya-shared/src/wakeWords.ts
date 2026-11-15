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
