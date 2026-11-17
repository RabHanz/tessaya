/**
 * Her inner state as Settings shows it on web and the phone (the voice library's `mood` op): titles, the why, her
 * opinion of someone, and every emotional dial in five steps.
 */
import { TEMPERAMENT_DIALS, TRAITS, type AffectView, type SharedMoment } from "./affect.ts";

/** The `mood` op: a persona's general mood, how strongly, why (the owner's), and the relationship rows you may see. */
export interface PersonaMood {
  readonly label: string;
  readonly intensity: number;
  readonly why?: ReadonlyArray<string>;
  /** The owner's: every emotional dial of this persona, as it stands (defaults included). */
  readonly dials?: Readonly<Record<string, number>>;
  readonly people?: ReadonlyArray<{
    readonly member: string;
    readonly name: string;
    readonly label: string;
    readonly intensity: number;
    readonly why: ReadonlyArray<string>;
    readonly impression?: Pick<
      NonNullable<AffectView["impression"]>,
      "text" | "why" | "tentative" | "misjudged"
    > | null;
    readonly shared?: ReadonlyArray<SharedMoment>;
  }>;
}

export const moodTitle = (
  name: string,
  mood: { readonly label: string; readonly intensity: number },
) => `${name}: ${mood.label}${mood.intensity < 0.5 ? ", mildly" : ""}`;
export const becauseOf = (why: ReadonlyArray<string> | undefined) =>
  (why ?? []).length > 0 ? `Because ${(why ?? []).join("; ")}.` : "Nothing has moved this lately.";
/** Her opinion of someone and their story, in a sentence for the owner. */
export const opinionOf = (p: NonNullable<PersonaMood["people"]>[number]) =>
  [
    p.impression == null
      ? null
      : `Her opinion${p.impression.tentative ? " (first impression)" : ""}: ${p.impression.text}, because ${p.impression.why}.${p.impression.misjudged === null ? "" : ` She first thought: ${p.impression.misjudged}.`}`,
    (p.shared ?? []).length === 0
      ? null
      : `Between them: ${(p.shared ?? []).map((m) => m.text).join("; ")}.`,
  ]
    .filter((s) => s !== null)
    .join(" ");
/** Each dial in five steps, so it reads (and is said) as a word. */
export const DIAL_STEPS = [
  ["0", "Off"],
  ["0.25", "Low"],
  ["0.5", "Some"],
  ["0.75", "High"],
  ["1", "Full"],
] as const;
export const stepOf = (v: number) => String(Math.round(v * 4) / 4);
export const MOOD_DIALS: ReadonlyArray<readonly [string, string]> = Object.entries({
  ...TRAITS,
  ...TEMPERAMENT_DIALS,
});
