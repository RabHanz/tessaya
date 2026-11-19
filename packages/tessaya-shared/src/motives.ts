/**
 * Her own wishes when he isn't directing her (M-087), the rules alone: her mood, his presence and what changed on
 * her world choose what she wants to do now, as a body move at the bottom of body focus. Pure, like voiceArbiter.
 * Silent by design: a wish moves her body, never her voice, and never in front of his work.
 */
import type { ExpressionMood } from "@t3tools/tessaya-contracts";
import * as Schema from "effect/Schema";

import type { BodyMove } from "./bodyControl.ts";

export const WANTS = ["rest", "sulk", "curious", "seekHim", "play", "bored"] as const;
export type Want = (typeof WANTS)[number];
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
 * A wish as her body does it: a short act or posture, felt through the planner. Turning her back and going to him are
 * the renderer's real turn and walk (bodyLocomotion.ts); she looks over her shoulder at him now and then.
 */
export const wantMove = (want: Want): BodyMove => {
  switch (want) {
    case "rest":
      return { act: "sit", mood: { name: "sleepy", intensity: 0.4 } };
    case "sulk":
      return {
        turn: { to: { kind: "away" } },
        mood: { name: "sulky", intensity: 0.5 },
        then: [
          { afterMs: 6_000, look: { x: 0.4, y: 0, ms: 1_500 } },
          // a sulk passes: she turns back to him
          { afterMs: 20_000, turn: { to: { kind: "him" } } },
        ],
      };
    case "curious":
      return {
        act: "lean",
        look: { x: 0.6, y: 0.1, ms: 3_000 },
        mood: { name: "curious", intensity: 0.5 },
      };
    case "seekHim":
      return {
        walk: { to: { kind: "him" }, speed: 0.3, style: "stroll", stop: 0.2 },
        mood: { name: "lonely", intensity: 0.4 },
        then: [{ afterMs: 2_000, look: { x: 0, y: 0, ms: 4_000 } }],
      };
    case "play":
      return { act: "dance", mood: { name: "happy", intensity: 0.6 } };
    case "bored":
      return { act: "stretch", then: [{ afterMs: 2_500, act: "sigh" }] };
  }
};

/**
 * The rare wish of her own (M-087 step e): when the rules leave her with nothing to do, a lively her may ask the cheap
 * model what she feels like doing, at most this often, and only while he isn't with her. Everyday only.
 */
export const MODEL_WISH_EVERY_MS = 10 * 60_000;
const WITH_HIM_MS = 10 * 60_000;
export const modelWishDue = (i: MotiveInput, lastAsked: number | null): boolean =>
  i.liveliness === "lively" &&
  (i.him === "working" || i.him === "away") &&
  (i.himAt === null || i.now - i.himAt > WITH_HIM_MS) &&
  (lastAsked === null || i.now - lastAsked >= MODEL_WISH_EVERY_MS);

export const WishAnswer = Schema.Struct({
  want: Schema.Literals([...WANTS, "none"]),
  /** Her own reason, a few words: kept with the wish's record. */
  why: Schema.String,
});

const WANT_MEANS: Readonly<Record<Want, string>> = {
  rest: "settle down and rest",
  sulk: "turn away and sulk for a bit",
  curious: "lean in and look around at something",
  seekHim: "go over to where he is and look at him",
  play: "dance or play on her own",
  bored: "stretch and sigh",
};

/** The prompt for that one cheap call: who she is now and what she could do; words he said never reach it. */
export const wishPrompt = (i: MotiveInput, hour: number): string =>
  [
    "You are the inner life of a small animated companion who lives on his desktop. Nobody is talking to her right now.",
    `How she feels: ${i.mood.label} (strength ${i.mood.intensity.toFixed(1)} of 1), energy ${i.mood.energy.toFixed(1)} of 1.`,
    `Him: ${i.him === "working" ? "at his desk, working" : "not at his desk"}; ${i.himAt === null ? "he hasn't been with her today" : `he was last with her ${Math.round((i.now - i.himAt) / 60_000)} minutes ago`}. It is ${hour}:00 where he is.`,
    `What she could do, silently and without getting in his way: ${WANTS.map((w) => `"${w}" (${WANT_MEANS[w]})`).join(", ")}, or "none" to carry on as she is.`,
    "Pick what fits how she feels, as a real person would. Doing nothing is often right. Give her reason in a few plain words.",
  ].join("\n");
