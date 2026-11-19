/**
 * Her own wishes when he isn't directing her (M-087), the rules alone: her mood, his presence and what changed on
 * her world choose what she wants to do now, as a body move at the bottom of body focus. Pure, like voiceArbiter.
 * Silent by design: a wish moves her body, never her voice, and never in front of his work.
 */
import type { ExpressionMood } from "@t3tools/tessaya-contracts";

import type { BodyMove } from "./bodyControl.ts";

export type Want = "rest" | "sulk" | "curious" | "seekHim" | "play" | "bored";
export type Liveliness = "still" | "calm" | "lively";

export interface MotiveInput {
  readonly now: number;
  readonly liveliness: Liveliness;
  /** Her mood toward him now (affect.ts personaView): label, how far from her temperament, her energy. */
  readonly mood: {
    readonly label: ExpressionMood;
    readonly intensity: number;
    readonly energy: number;
  };
  /** What he is doing: at work, away, full-screen (a film, a game) or on a call. */
  readonly him: "working" | "away" | "fullscreen" | "call";
  /** When he last spoke to, typed to or touched her; null if never today. */
  readonly himAt: number | null;
  /** When something on her world last changed (a new window, another screen), and whether it is new to her. */
  readonly worldAt: number;
  readonly newThingAt: number | null;
  /** Her last wish and when it was chosen. */
  readonly last: { readonly want: Want; readonly at: number } | null;
}

/** How often she may choose something of her own, by the dial. */
export const WISH_EVERY_MS: Readonly<Record<Exclude<Liveliness, "still">, number>> = {
  calm: 3 * 60_000,
  lively: 60_000,
};
/** The same wish again only after this, so a mood doesn't loop one act. */
export const SAME_WISH_MS = 10 * 60_000;
const BORED_MS = 5 * 60_000;
const MISSED_MS = 2 * 60 * 60_000;
const NEW_MS = 15_000;
const HURT: ReadonlySet<ExpressionMood> = new Set(["hurt", "sulky", "putout"]);
const BRIGHT: ReadonlySet<ExpressionMood> = new Set(["happy", "proud", "curious"]);

/** What she wants now and why (the `body.want` record's reason), or null to carry on as she is. */
export const chooseWant = (
  i: MotiveInput,
): { readonly want: Want; readonly why: string } | null => {
  if (i.liveliness === "still") return null;
  // A film, a game or a call: she settles and stays out of it, whatever she feels.
  if (i.him === "fullscreen" || i.him === "call")
    return pick(i, "rest", `he is in a ${i.him === "call" ? "call" : "full-screen app"}`, true);
  if (i.last !== null && i.now - i.last.at < WISH_EVERY_MS[i.liveliness]) return null;
  const candidates: ReadonlyArray<readonly [boolean, Want, string]> = [
    [i.mood.energy < 0.25 || i.mood.label === "sleepy", "rest", "she is tired"],
    [HURT.has(i.mood.label) && i.mood.intensity > 0.4, "sulk", `she feels ${i.mood.label}`],
    [
      i.newThingAt !== null && i.now - i.newThingAt < NEW_MS,
      "curious",
      "something new appeared on his screen",
    ],
    [
      i.him === "working" && (i.himAt === null || i.now - i.himAt > MISSED_MS),
      "seekHim",
      "he has not been with her for hours",
    ],
    [
      i.liveliness === "lively" && BRIGHT.has(i.mood.label) && i.mood.energy > 0.6,
      "play",
      "she is in a bright mood",
    ],
    [i.now - i.worldAt > BORED_MS, "bored", "nothing has happened for a while"],
  ];
  for (const [when, want, why] of candidates) {
    if (!when) continue;
    const chosen = pick(i, want, why, false);
    if (chosen !== null) return chosen;
  }
  return null;
};

const pick = (i: MotiveInput, want: Want, why: string, force: boolean) =>
  !force && i.last?.want === want && i.now - i.last.at < SAME_WISH_MS ? null : { want, why };

/**
 * A wish as her body does it: a short act or posture, felt through the planner. Turning her back is `turnAway`; she
 * looks over her shoulder at him now and then.
 */
export const wantMove = (want: Want): BodyMove => {
  switch (want) {
    case "rest":
      return { act: "sit", mood: { name: "sleepy", intensity: 0.4 } };
    case "sulk":
      return {
        act: "turnAway",
        mood: { name: "sulky", intensity: 0.5 },
        then: [{ afterMs: 6_000, look: { x: 0.4, y: 0, ms: 1_500 } }],
      };
    case "curious":
      return {
        act: "lean",
        look: { x: 0.6, y: 0.1, ms: 3_000 },
        mood: { name: "curious", intensity: 0.5 },
      };
    case "seekHim":
      return {
        act: "walkOver",
        mood: { name: "lonely", intensity: 0.4 },
        then: [{ afterMs: 2_000, look: { x: 0, y: 0, ms: 4_000 } }],
      };
    case "play":
      return { act: "dance", mood: { name: "happy", intensity: 0.6 } };
    case "bored":
      return { act: "stretch", then: [{ afterMs: 2_500, act: "sigh" }] };
  }
};
