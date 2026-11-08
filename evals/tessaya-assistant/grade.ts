import { pathPasses } from "../../packages/baton-shared/src/skillLearning.ts";
import type { AssistantCase } from "./cases.ts";

/** The tool a sample reached for first, without the MCP server prefix; "none" when it used none. */
export const firstTool = (calls: ReadonlyArray<string>): string =>
  (calls[0] ?? "none").replace(/^mcp__baton__/, "");

export interface Sample {
  readonly calls: ReadonlyArray<string>;
  /** Each call's arguments, in the order of `calls`. */
  readonly inputs?: ReadonlyArray<unknown>;
  readonly reply: string;
  /** Every reply when the case says more than one sentence. */
  readonly replies?: ReadonlyArray<string>;
  /** The model the sample ran on. */
  readonly model?: string;
}

/** The arguments of the first call to the goal tool, as lower-case JSON. */
const goalInput = (c: AssistantCase, sample: Sample): string => {
  const at = sample.calls.findIndex((t) => t.replace(/^mcp__baton__/, "") === c.goal);
  return at < 0 ? "" : JSON.stringify(sample.inputs?.[at] ?? null).toLowerCase();
};

/** A reply's first four words: a repeat that opens the same way is heard as the same sentence. */
const opening = (reply: string) =>
  reply
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w !== "")
    .slice(0, 4)
    .join(" ");

export const passes = (c: AssistantCase, sample: Sample): boolean => {
  const first = firstTool(sample.calls);
  const replies = sample.replies ?? [sample.reply];
  return (
    (c.varies !== true ||
      replies.every((reply, i) => i === 0 || opening(reply) !== opening(replies[i - 1]!))) &&
    c.first.includes(first) &&
    (c.model === undefined || sample.model === c.model) &&
    !(c.not ?? []).includes(first) &&
    (c.says === undefined || sample.reply.toLowerCase().includes(c.says.toLowerCase())) &&
    !(c.notSays ?? []).some((text) => replies.some((reply) => reply.includes(text))) &&
    // A persona never opens with "<name> here": the card and the voice already say who answers.
    (c.wake === undefined || !/^\W*\w+ here\b/i.test(sample.reply)) &&
    (c.goal === undefined ||
      pathPasses({ goal: c.goal, maxCalls: c.maxCalls ?? 99 }, sample.calls)) &&
    (c.goalArgs ?? []).every((word) => goalInput(c, sample).includes(word.toLowerCase())) &&
    !(c.notGoalArgs ?? []).some((word) => goalInput(c, sample).includes(word.toLowerCase()))
  );
};

/** A case fails when half or more of its samples fail (evals/README.md). */
export const casePasses = (c: AssistantCase, samples: ReadonlyArray<Sample>) =>
  samples.filter((sample) => passes(c, sample)).length * 2 > samples.length;
