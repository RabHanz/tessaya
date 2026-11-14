// @effect-diagnostics preferSchemaOverJson:off
/** The questions of the AskUserQuestion form a session is waiting on, read from its transcript (exact text, every tab). */
export interface FormQuestion {
  readonly header: string;
  readonly question: string;
  readonly options: ReadonlyArray<{ readonly label: string; readonly description: string }>;
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** The newest AskUserQuestion with no tool result after it, or [] when none is pending. */
export const pendingAskQuestions = (transcriptTail: string): ReadonlyArray<FormQuestion> => {
  const pending = new Map<string, ReadonlyArray<FormQuestion>>();
  let newest: string | null = null;
  for (const line of transcriptTail.split("\n")) {
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const content = (record as { message?: { content?: unknown } } | null)?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as Array<Record<string, unknown>>) {
      if (block["type"] === "tool_result") pending.delete(text(block["tool_use_id"]));
      if (block["type"] === "tool_use" && block["name"] === "AskUserQuestion") {
        const questions = (block["input"] as { questions?: unknown } | undefined)?.questions;
        if (!Array.isArray(questions)) continue;
        const id = text(block["id"]);
        pending.set(
          id,
          (questions as Array<Record<string, unknown>>).map((q) => ({
            header: text(q["header"]),
            question: text(q["question"]),
            options: (Array.isArray(q["options"])
              ? (q["options"] as Array<Record<string, unknown>>)
              : []
            ).map((o) => ({ label: text(o["label"]), description: text(o["description"]) })),
          })),
        );
        newest = id;
      }
    }
  }
  return newest !== null && pending.has(newest) ? (pending.get(newest) ?? []) : [];
};

/** One line that tells the reader the other questions of the form, for the card's question text. */
export const formOverview = (questions: ReadonlyArray<FormQuestion>): string =>
  questions.length < 2
    ? ""
    : `This form has ${questions.length} questions: ${questions
        .map(
          (q, i) =>
            `${i + 1}) ${q.header !== "" ? `${q.header}: ` : ""}${q.question} [${q.options.map((o) => o.label).join(" / ")}]`,
        )
        .join(" ")} Answer them one at a time here; the form is submitted after the last.`;
