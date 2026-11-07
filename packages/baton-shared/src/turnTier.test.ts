import { describe, expect, it } from "vite-plus/test";

import {
  AUTOMATIC,
  TIER_CARRY_MS,
  chooseTurnBrain,
  createTierMemory,
  manualLabel,
  modelCommand,
  tierBrains,
  tierOfSentence,
} from "./turnTier.ts";

const opus = { model: "opus", effort: "medium" };
const sonnet = { model: "sonnet", effort: "medium" };

describe("which model answers a chat turn", () => {
  it.each([
    ["What time is it?", "fast"],
    ["what needs me?", "fast"],
    ["look, what needs me today?", "fast"],
    ["is anything stuck?", "fast"],
    ["what's the capital of Peru?", "fast"],
    ["thanks", "fast"],
    ["Can you tell me what's on my screen?", "default"],
    ["remind me to check the deploy in an hour", "default"],
    ["tell the build session to rerun the tests", "default"],
    ["dictation apps, which one's best?", "default"],
    ["turn on word wrap in notepad for me", "deep"],
    ["take on a job: tidy the README in the shop project", "deep"],
    ["the shop README job is agreed: give the copy to marketing", "deep"],
    ["what did your standing jobs do today?", "fast"],
    ["type hello world into notepad and save it", "deep"],
    ["should I move the launch to Friday?", "deep"],
    // An action said with a fast question is still an action, with tools: never the fast model.
    ["what needs me? approve the first one", "default"],
    ["what's the time, remind me at five to call mum", "default"],
    ["how much is in the account, transfer it", "default"],
    ["is the build green? merge it", "default"],
    ["roll back the deploy", "default"],
    // 0.1.73: a "then" that opens the sentence joins it to the last turn; it is one act, not a chain.
    ["Then start dictating.", "default"],
    ["open notepad then type hello", "deep"],
  ])("%s -> %s", (said, tier) => {
    expect(tierOfSentence(said).tier).toBe(tier);
  });

  it("never runs above the persona's model, and keeps a model it does not know", () => {
    expect(chooseTurnBrain("what time is it", opus)).toMatchObject({
      tier: "fast",
      brain: { model: "haiku", effort: "low" },
    });
    expect(chooseTurnBrain("what's on my screen", opus).brain).toEqual(sonnet);
    expect(chooseTurnBrain("plan my week", opus).brain).toEqual(opus);
    expect(chooseTurnBrain("plan my week", sonnet)).toMatchObject({
      tier: "default",
      brain: sonnet,
    });
    const custom = { model: "claude-custom-1", effort: "high" };
    expect(chooseTurnBrain("what time is it", custom).brain).toEqual(custom);
  });

  it("carries out a yes on the model that asked for it", () => {
    expect(chooseTurnBrain("yes, go ahead", opus, "deep").brain).toEqual(opus);
    expect(chooseTurnBrain("yes, go ahead", opus).tier).toBe("fast");
    expect(chooseTurnBrain("what time is it", opus, "deep").tier).toBe("fast");
    // A yes after a quick answer may start real work: never carried on the fast model.
    expect(chooseTurnBrain("yes, go ahead", opus, "fast").tier).toBe("default");
  });

  it("warms every model a persona's turns can land on, the likeliest first", () => {
    expect(tierBrains(opus).map((b) => b.model)).toEqual(["sonnet", "haiku", "opus"]);
    expect(tierBrains(opus, AUTOMATIC, "deep").map((b) => b.model)).toEqual([
      "opus",
      "haiku",
      "sonnet",
    ]);
    expect(tierBrains(sonnet)).toEqual([sonnet, { model: "haiku", effort: "low" }]);
    expect(tierBrains(opus, { model: "opus", effort: "high" })).toEqual([
      { model: "opus", effort: "high" },
    ]);
  });

  it("carries a yes from when the last answer settled, not from when it began", () => {
    let now = 0;
    const memory = createTierMemory(() => now);
    // A plan that took five minutes to write: "go ahead" a minute after it ends still answers it.
    now = 5 * 60_000;
    memory.settled("deep");
    now += 60_000;
    expect(chooseTurnBrain("go ahead", opus, memory.previous()).brain).toEqual(opus);
    now += TIER_CARRY_MS;
    expect(memory.previous()).toBeNull();
    // A paired device's turn is not his: his next yes does not carry its tier.
    memory.settled("deep", true);
    expect(memory.previous()).toBeNull();
  });
});

describe("his own choice of model and effort", () => {
  it.each([
    ["use Opus", { model: "opus", effort: null }],
    ["switch to sonnet please", { model: "sonnet", effort: null }],
    ["think harder", { model: "opus", effort: "high" }],
    ["go faster", { model: "haiku", effort: "low" }],
    ["back to normal", AUTOMATIC],
    ["use opus to plan my week", null],
    ["what is opus", null],
    ["faster", null],
    ["quicker", null],
    ["think it through", null],
  ])("%s", (said, choice) => {
    expect(modelCommand(said, AUTOMATIC)).toEqual(choice);
  });

  it("never lets a paired device or an agent change his model", () => {
    expect(modelCommand("use opus", AUTOMATIC, true)).toBeNull();
  });

  it("keeps the other half of the choice: a named model keeps his effort, harder keeps his model", () => {
    expect(modelCommand("use sonnet", { model: "opus", effort: "high" })).toEqual({
      model: "sonnet",
      effort: "high",
    });
    expect(modelCommand("think harder", { model: "sonnet", effort: null })).toEqual({
      model: "sonnet",
      effort: "high",
    });
  });

  it("overrides the rules and the persona's model until he resets it", () => {
    expect(
      chooseTurnBrain("what time is it", sonnet, null, { model: "opus", effort: null }),
    ).toMatchObject({
      brain: { model: "opus", effort: "medium" },
      why: "his choice (Opus)",
    });
    expect(
      chooseTurnBrain("plan my week", opus, null, { model: null, effort: "high" }).brain,
    ).toEqual({
      model: "opus",
      effort: "high",
    });
    expect(chooseTurnBrain("what time is it", opus, null, AUTOMATIC).brain.model).toBe("haiku");
    expect(manualLabel({ model: "opus", effort: "high" })).toBe("Opus, high effort");
    expect(manualLabel({ model: null, effort: "low" })).toBe("Low effort");
  });
});
