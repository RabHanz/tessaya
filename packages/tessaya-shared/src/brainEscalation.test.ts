import { describe, expect, it } from "vite-plus/test";

import { escalationDecision, escalationRulesLine } from "./brainEscalation.ts";

const fresh = { offerOpen: false, deepRecently: false, autoToday: 0 };
const plan = { kind: "plan" as const, why: "a week's plan" };
const rules = [
  { when: "coding questions", then: "opus" as const },
  { when: "anything about money", then: "ask" as const },
  { when: "small talk", then: "sonnet" as const },
];

describe("whether a hard task goes to Opus", () => {
  it.each([
    ["the default asks him", {}, plan, fresh, "ask"],
    ["never stays put", { mode: "never" as const }, plan, fresh, "no"],
    ["auto goes", { mode: "auto" as const }, plan, fresh, "go"],
    [
      "auto past the cap asks",
      { mode: "auto" as const, autoDeepDailyCap: 2 },
      plan,
      { ...fresh, autoToday: 2 },
      "ask",
    ],
    [
      "an Opus rule goes even when asking is the default",
      { rules },
      { ...plan, rule: 1 },
      fresh,
      "go",
    ],
    [
      "an ask rule beats auto",
      { mode: "auto" as const, rules },
      { ...plan, rule: 2 },
      fresh,
      "ask",
    ],
    ["a stay rule beats auto", { mode: "auto" as const, rules }, { ...plan, rule: 3 }, fresh, "no"],
    [
      "an Opus rule past the cap asks",
      { rules, autoDeepDailyCap: 0 },
      { ...plan, rule: 1 },
      fresh,
      "ask",
    ],
    ["a rule number he has not got is no rule", { rules }, { ...plan, rule: 9 }, fresh, "ask"],
    [
      "his yes to the open offer goes, even when capped",
      { autoDeepDailyCap: 0 },
      { ...plan, accept: true },
      { ...fresh, offerOpen: true },
      "go",
    ],
    ["a yes with no offer open is asked again", {}, { ...plan, accept: true }, fresh, "ask"],
    [
      "going on with Opus's task goes",
      { mode: "never" as const },
      { ...plan, continuing: true },
      { ...fresh, deepRecently: true },
      "go",
    ],
  ])("%s", (_name, settings, ask, state, decision) => {
    expect(escalationDecision(settings, ask, state).decision).toBe(decision);
  });

  it("counts only what she starts without his word against the cap", () => {
    expect(escalationDecision({ mode: "auto" }, plan, fresh)).toMatchObject({ counts: true });
    expect(
      escalationDecision({}, { ...plan, accept: true }, { ...fresh, offerOpen: true }),
    ).toMatchObject({ counts: false });
  });

  it("numbers his rules for her to name one", () => {
    expect(escalationRulesLine({})).toBeNull();
    expect(escalationRulesLine({ rules })).toContain("2. anything about money → ask him first");
  });
});
