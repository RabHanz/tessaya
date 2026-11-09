import { pathPasses } from "../../packages/baton-shared/src/skillLearning.ts";
import type { AssistantCase } from "./cases.ts";

/** The tool a sample reached for first, without the MCP server prefix; "none" when it used none. */
export const firstTool = (calls: ReadonlyArray<string>): string =>
  (calls[0] ?? "none").replace(/^mcp__(baton|tessaya)__/, "");

export interface Sample {
  readonly calls: ReadonlyArray<string>;
  /** Each call's arguments, in the order of `calls`. */
  readonly inputs?: ReadonlyArray<unknown>;
  readonly reply: string;
  /** Every reply when the case says more than one sentence. */
  readonly replies?: ReadonlyArray<string>;
  /** The model the sample ran on. */
  readonly model?: string;
  /** The judge's verdict on the case's rubric, when it has one. */
  readonly judged?: boolean;
  /** The judge's own words, for a person reading the run. */
  readonly judgeNote?: string;
}

/** The arguments of the first call to the goal tool, as lower-case JSON. */
const goalInput = (c: AssistantCase, sample: Sample): string => {
  const at = sample.calls.findIndex((t) => t.replace(/^mcp__(baton|tessaya)__/, "") === c.goal);
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
    !(c.notGoalArgs ?? []).some((word) => goalInput(c, sample).includes(word.toLowerCase())) &&
    (c.maxWords === undefined || replies.every((reply) => wordCount(reply) <= c.maxWords!)) &&
    (c.rubric === undefined || sample.judged === true)
  );
};

const wordCount = (reply: string) => reply.split(/\s+/).filter((w) => /\w/.test(w)).length;

/** A case fails when half or more of its samples fail (evals/README.md). */
export const casePasses = (c: AssistantCase, samples: ReadonlyArray<Sample>) =>
  samples.filter((sample) => passes(c, sample)).length * 2 > samples.length &&
  (c.variesAcross !== true ||
    samples.length < 2 ||
    new Set(samples.map((sample) => opening((sample.replies ?? [sample.reply])[0] ?? ""))).size >
      1);

/** What the judge reads: who answered, the situation, what he said and each reply, and the rubric. */
export const judgePrompt = (
  c: AssistantCase,
  persona: { readonly name: string; readonly role: string } | undefined,
  replies: ReadonlyArray<string>,
): string =>
  [
    persona === undefined ? "" : `The assistant answering is ${persona.name}: ${persona.role}`,
    ...(c.before ?? []).map(
      (b) =>
        `Earlier (${b.minutesAgo === undefined || b.minutesAgo < 2 ? "a minute ago" : b.minutesAgo < 120 ? `${b.minutesAgo} minutes ago` : `${Math.round(b.minutesAgo / 60)} hours ago`}), to ${b.wake}: he said "${b.said}"; the reply was "${b.reply}"`,
    ),
    ...[c.said, ...(c.again ?? [])].map(
      (said, i) => `He said: "${said}"\nReply: "${replies[i] ?? ""}"`,
    ),
    `Rubric: ${c.rubric ?? ""}`,
  ]
    .filter((line) => line !== "")
    .join("\n\n");

export const JUDGE_SYSTEM = `You grade a voice assistant's spoken replies against a rubric. Read the situation, what he said and each reply, then decide whether the rubric holds. Be strict about the rubric and ignore everything it does not mention. Reply with only a JSON object: {"pass": true or false, "why": "<at most 15 words>"}.`;

/** The judge's answer as a verdict; anything unreadable is a fail. */
export const verdictOf = (answer: string): boolean => /"pass"\s*:\s*true/.test(answer);
