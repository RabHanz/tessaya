import { SPEAKERS_PER_TURN, type Step } from "../../packages/tessaya-shared/src/groupTalk.ts";
import type { GroupCase } from "./cases.ts";

export interface Graded {
  readonly pass: boolean;
  readonly why: string;
}

/** One step: the speaker (or "end") must be one the case accepts. */
export const gradeStep = (c: GroupCase, step: Step): Graded => {
  const got = "next" in step ? step.next : "stop" in step ? "end" : "ask";
  return c.next?.includes(got) === true
    ? { pass: true, why: got }
    : { pass: false, why: `${got}, wanted ${c.next?.join("/") ?? "?"}` };
};

/** A whole turn: it must stop on its own, within the speaker budget, with at most one choice call per speaker. */
export const gradeBudget = (
  c: GroupCase,
  run: { readonly speakers: number; readonly calls: number; readonly stopped: string },
): Graded => {
  const cap = SPEAKERS_PER_TURN[c.group.mode];
  if (run.speakers > cap) return { pass: false, why: `${run.speakers} speakers > ${cap}` };
  if (run.calls > cap) return { pass: false, why: `${run.calls} choice calls > ${cap}` };
  if (run.speakers < 2) return { pass: false, why: `only ${run.speakers} spoke in a debate` };
  return { pass: true, why: `${run.speakers} spoke, ${run.calls} calls, stopped: ${run.stopped}` };
};
