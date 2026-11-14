import { describe, expect, it } from "vite-plus/test";

import { formOverview, pendingAskQuestions } from "./FormQuestions.ts";

const ask = (id: string) =>
  JSON.stringify({
    message: {
      content: [
        {
          type: "tool_use",
          id,
          name: "AskUserQuestion",
          input: {
            questions: [
              {
                header: "CI account",
                question: "Which Claude cloud account should run it?",
                options: [
                  { label: "sablebox", description: "The only cloud login." },
                  { label: "Don't run it", description: "Skip." },
                ],
              },
              {
                header: "Merge 4416",
                question: "Merge #4416 if that's the only failure left?",
                options: [
                  { label: "Yes, merge", description: "" },
                  { label: "No, fix race first", description: "" },
                ],
              },
            ],
          },
        },
      ],
    },
  });

describe("a form the session is waiting on", () => {
  it("is read from the transcript with every tab, until a result answers it", () => {
    const waiting = pendingAskQuestions(`${ask("t1")}\n`);
    expect(waiting.map((q) => q.header)).toEqual(["CI account", "Merge 4416"]);
    const answered = `${ask("t1")}\n${JSON.stringify({ message: { content: [{ type: "tool_result", tool_use_id: "t1" }] } })}\n`;
    expect(pendingAskQuestions(answered)).toEqual([]);
  });
  it("is summarised for the card, and a single question needs no summary", () => {
    const overview = formOverview(pendingAskQuestions(ask("t1")));
    expect(overview).toContain("2 questions");
    expect(overview).toContain("2) Merge 4416: Merge #4416");
    expect(formOverview(pendingAskQuestions(ask("t1")).slice(0, 1))).toBe("");
  });
});
