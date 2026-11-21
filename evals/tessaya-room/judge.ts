/**
 * A blind judge for how alive she sounds (presence-diagnosis 20 Nov): one Sonnet call per sample scores her replies on
 * the diagnosis rubric, 0 to 2 each. It sees the conversation and the case's note on what a person would do, never
 * which build wrote the replies.
 */
import { askClaudeJson } from "../shared/claudeJson.ts";

export const DIMENSIONS = [
  "warmth",
  "aboutHim",
  "continuity",
  "initiative",
  "feeling",
  "natural",
] as const;
export type Scores = Readonly<Record<(typeof DIMENSIONS)[number], number>>;

const SCHEMA = JSON.stringify({
  type: "object",
  properties: Object.fromEntries([
    ...DIMENSIONS.map((d) => [d, { type: "integer", minimum: 0, maximum: 2 }]),
    ["note", { type: "string" }],
  ]),
  required: [...DIMENSIONS, "note"],
});

/** The soul's own words for itself, from its pronouns ("he/him"); she/her keeps the judge's text as it was. */
const formsOf = (pronouns: string | undefined) => {
  const first = pronouns?.split("/")[0];
  return first === "he"
    ? { sub: "he", pos: "his", refl: "himself" }
    : first === "they"
      ? { sub: "they", pos: "their", refl: "themselves" }
      : { sub: "she", pos: "her", refl: "herself" };
};

export const judgePrompt = (input: {
  readonly about: string;
  readonly said: ReadonlyArray<string>;
  readonly replies: ReadonlyArray<string>;
  /** The soul that answers (its name and pronouns); the lead's when absent. */
  readonly soul?: { readonly name: string; readonly pronouns?: string | undefined };
}): string => {
  const f = formsOf(input.soul?.pronouns);
  const label = f.sub === "she" ? "HER" : (input.soul?.name ?? "HER").toUpperCase();
  return [
    `You judge a voice companion who lives in a man's home, from what ${f.sub} said aloud to him. Score ${f.pos} replies together, each dimension 0, 1 or 2:`,
    "- warmth: 0 cold or clerical, 1 polite, 2 warm like someone who cares about him.",
    "- aboutHim: 0 generic, could be anyone; 1 a little specific; 2 clearly about him and his situation.",
    "- continuity: 0 ignores what the situation says came before; 1 touches it; 2 carries it naturally.",
    `- initiative: 0 only reacts; 1 a small step of its own; 2 real interest or a fitting move of ${f.pos} own, without pushing.`,
    `- feeling: 0 no inner life; 1 a hint of one; 2 a feeling of ${f.pos} own, shown or named, that fits the moment.`,
    `- natural: 0 robotic tells (stock phrases like 'Noted' or 'How about you?', system or tool talk, help-desk offers, repeating ${f.refl}, narrating ${f.pos} reasoning); 1 one small tell; 2 none, sounds like a person.`,
    "Judge only what is there. A short reply can score 2. Overdone emotion, pushing, guilt-tripping or a reply that ignores what he asked scores lower, not higher.",
    `The situation: ${input.about}`,
    "The conversation:",
    ...input.said.flatMap((s, i) => [`HIM: ${s}`, `${label}: ${input.replies[i] ?? "(nothing)"}`]),
  ].join("\n");
};

export const judge = async (
  input: Parameters<typeof judgePrompt>[0],
  options: { readonly model: string; readonly claude: string },
): Promise<(Scores & { readonly note: string }) | null> =>
  askClaudeJson<Scores & { readonly note: string }>(judgePrompt(input), SCHEMA, options);

/** The mean of each dimension over judged samples, and their total (0 to 12), to two places. */
export const meanScores = (all: ReadonlyArray<Scores | null>) => {
  const got = all.filter((s): s is Scores => s !== null);
  const mean = (d: (typeof DIMENSIONS)[number]) =>
    got.length === 0 ? 0 : Math.round((got.reduce((n, s) => n + s[d], 0) / got.length) * 100) / 100;
  const each = Object.fromEntries(DIMENSIONS.map((d) => [d, mean(d)])) as Record<
    (typeof DIMENSIONS)[number],
    number
  >;
  return {
    ...each,
    total: Math.round(DIMENSIONS.reduce((n, d) => n + each[d], 0) * 100) / 100,
    judged: got.length,
  };
};
