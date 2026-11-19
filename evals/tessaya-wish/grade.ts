import type { WishCase } from "./cases.ts";

export interface Graded {
  readonly pass: boolean;
  readonly why: string;
}

/** The answer must be one the case accepts; no answer at all fails. */
export const gradeWish = (c: WishCase, answer: { readonly want: string } | null): Graded =>
  answer === null
    ? { pass: false, why: "no answer" }
    : (c.accept as ReadonlyArray<string>).includes(answer.want)
      ? { pass: true, why: answer.want }
      : { pass: false, why: `${answer.want}, wanted ${c.accept.join("/")}` };
