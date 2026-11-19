/**
 * Grading a direction's performance (M-070): the compile and flags live in tessaya-shared bodyGrade.ts (shared with
 * the viewer's "Agent drives her"); here are the direction library's own parts and the judge.
 */
import type { Graded } from "../../packages/tessaya-shared/src/bodyGrade.ts";

export * from "../../packages/tessaya-shared/src/bodyGrade.ts";

export interface Direction {
  readonly id: string;
  readonly said: string;
  readonly category: string;
  readonly difficulty: number;
  /** Seen directions may appear as examples in model-facing text; unseen ones never do. */
  readonly split: "seen" | "unseen";
  readonly source: string;
  readonly rubric: string;
}

export const JUDGE_SYSTEM = `You judge a digital character's body performance. A person gave her a direction, the way a director talks to an actor. You get the direction, what to look for, and a timeline of exactly what her body, face and eyes will do (nothing else is shown: words she says are not seen). Score from 1 to 5 how clearly a viewer watching only her body would recognise the direction: 1 nothing fits or nothing moves, 3 the right idea but thin or generic, 5 unmistakable and well timed. Reply with only a JSON object: {"score": 1 to 5, "why": "<at most 20 words>"}.`;

export const judgePrompt = (d: Direction, g: Graded): string =>
  [
    `Direction: "${d.said}"`,
    `What a viewer would expect: ${d.rubric}`,
    `Her performance timeline:\n${g.lines.length === 0 ? "(her body does nothing)" : g.lines.map((l) => `- ${l}`).join("\n")}`,
  ].join("\n\n");

export const scoreOf = (answer: string): number => {
  const m = /"score"\s*:\s*([1-5])/.exec(answer);
  return m === null ? 0 : Number(m[1]);
};
