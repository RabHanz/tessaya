import { describe, expect, it } from "vite-plus/test";

import { parseOrchestrationSentence, type ProviderVocabulary } from "./ruleParser.ts";

const vocabulary: ProviderVocabulary = {
  byName: new Map([
    ["claude", "claudeAgent"],
    ["claude a", "claude-a"],
    ["claude b", "claude-b"],
    ["codex", "codex"],
  ]),
  modelFor: (instanceId) => (instanceId === "codex" ? "gpt-5" : "claude-sonnet"),
};

const parse = (sentence: string) => parseOrchestrationSentence(sentence, vocabulary);

describe("parseOrchestrationSentence", () => {
  it("parses the specification's own sentence into two sequenced rules", () => {
    // §29 Phase 9's exit criterion starts here: this exact sentence has to
    // become something inspectable.
    const result = parse(
      "When Claude finishes this, have Codex review it and tell me if either needs me.",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rules).toHaveLength(2);

    const [review, notify] = result.rules;
    expect(review?.trigger).toEqual({ kind: "on_done" });
    expect(review?.action.kind).toBe("start_provider_session");
    if (review?.action.kind === "start_provider_session") {
      expect(review.action.providerInstanceId).toBe("codex");
      expect(review.action.role).toBe("review");
      // A reviewer reads. It does not get to write without being asked.
      expect(review.action.runtimeMode).toBe("approval-required");
    }
    expect(review?.afterPrevious).toBe(false);

    // The second clause runs after the first, which is what makes each step
    // separately inspectable and separately disableable.
    expect(notify?.afterPrevious).toBe(true);
    expect(notify?.action.kind).toBe("notify");
    if (notify?.action.kind === "notify") {
      expect(notify.action.message).toBe("if either needs me");
    }
  });

  it("recognises the three triggers", () => {
    const done = parse("When Claude finishes, tell me it is done.");
    const failed = parse("If the build fails, tell me straight away.");
    const needs = parse("When it needs me, tell me.");
    expect(done.ok && done.rules[0]?.trigger).toEqual({ kind: "on_done" });
    expect(failed.ok && failed.rules[0]?.trigger).toEqual({ kind: "on_failed" });
    expect(needs.ok && needs.rules[0]?.trigger).toEqual({ kind: "on_needs_user" });
  });

  it("reads 'once' and 'as soon as' as the same triggers", () => {
    for (const sentence of [
      "Once Claude's done, have Codex review it.",
      "As soon as Claude is finished, have Codex review it.",
    ]) {
      const result = parse(sentence);
      expect(result.ok && result.rules[0]?.trigger).toEqual({ kind: "on_done" });
    }
    const failed = parse("Once the build fails, tell me.");
    expect(failed.ok && failed.rules[0]?.trigger).toEqual({ kind: "on_failed" });
  });

  it("parses the §22 return path", () => {
    const result = parse("When Codex finishes, send it back to Claude.");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rules[0]?.action).toEqual({
      kind: "message_active_implementation_session",
      prompt: "The review found blocking issues.",
      include: "review_findings",
    });
  });

  it("turns 'ask me first' into a confirmation gate rather than doing it", () => {
    const result = parse("When this finishes, ask me first.");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rules[0]?.action.kind).toBe("confirmation_gate");
  });

  it("refuses with the words it could not place, rather than building less", () => {
    // The failure mode this exists to prevent: quietly dropping half a
    // sentence and creating a rule that does not do what was asked.
    const result = parse("When Claude finishes, have Codex review it and deploy to production.");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.unplaced).toBe("deploy to production");
    expect(result.reason).toContain("none of it was created");
  });

  it("refuses a provider it does not know, and names the clause", () => {
    const result = parse("When Claude finishes, have Gemini review it.");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.unplaced).toContain("gemini");
  });

  it("refuses a sentence with no trigger, and says what a trigger looks like", () => {
    const result = parse("Have Codex review it.");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("No trigger found");
  });

  it("refuses a trigger with no action", () => {
    const result = parse("When Claude finishes.");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("not what to do");
  });

  it("refuses an empty instruction rather than returning an empty rule set", () => {
    const result = parse("   ");
    expect(result.ok).toBe(false);
  });

  it("ignores pure filler without treating it as unplaced", () => {
    const result = parse("When Claude finishes this, then have Codex review it, please.");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rules).toHaveLength(1);
  });

  it("keeps the user's own words as the rule's source", () => {
    const sentence = "When Claude finishes this, have Codex review it.";
    const result = parse(sentence);
    expect(result.source).toBe(sentence);
  });

  it("is case-insensitive and tolerates curly apostrophes", () => {
    const result = parse("WHEN CLAUDE FINISHES, HAVE CODEX REVIEW IT.");
    expect(result.ok).toBe(true);
  });
});
