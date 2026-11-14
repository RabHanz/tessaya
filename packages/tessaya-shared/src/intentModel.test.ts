/* oxlint-disable t3code/no-low-value-comments -- Baton file predating upstream's rule (D82) */
/**
 * The rails, proven without a model.
 *
 * Every one of these is a way a model can be wrong, and the point of D50's
 * design is that being wrong in these ways is not dangerous: an invented id, a
 * paraphrase of a refused request, a confident guess between two work sessions,
 * an empty message. A test per failure mode, run in milliseconds and costing
 * nothing, is what makes the ten real sentences a proof rather than a demo.
 */
import { describe, expect, it } from "vite-plus/test";

import {
  buildIntentModelPrompt,
  INTENT_MODEL_JSON_SCHEMA,
  interpretIntentModelReply,
  type IntentModelReply,
} from "./intentModel.ts";
import type { IntentVocabulary } from "./intentParser.ts";

const vocabulary: IntentVocabulary = {
  workSessions: [
    {
      id: "ws-scheduler",
      title: "Scheduler reconnect race",
      projectId: "p-vantageos",
      projectLabel: "VantageOS",
      needsApproval: true,
      updatedAt: "2026-09-18T09:00:00Z",
    },
    {
      id: "ws-deploy",
      title: "Production deploy check",
      projectId: "p-baton",
      projectLabel: "Baton proof scratch",
      needsApproval: false,
      updatedAt: "2026-09-18T08:00:00Z",
    },
  ],
  projects: [
    { id: "p-vantageos", title: "VantageOS" },
    { id: "p-baton", title: "Baton proof scratch" },
  ],
  providers: [
    {
      instanceId: "claude-sablebox",
      driver: "claudeAgent",
      aliases: ["Claude · sablebox", "sablebox"],
      label: "Claude · sablebox",
      model: "claude-fable-5-1",
      available: true,
      signedIn: true,
    },
    {
      instanceId: "claude-robin",
      driver: "claudeAgent",
      aliases: ["Claude · robin", "robin"],
      label: "Claude · robin",
      model: "claude-fable-5-1",
      available: false,
      signedIn: false,
    },
  ],
  openGates: [
    { firingId: "firing-1", workSessionId: "ws-scheduler", question: "Deploy the scheduler fix?" },
  ],
  hostAliases: ["sablebox-prod", "this box"],
  focusedWorkSessionId: "ws-scheduler",
};

const reply = (overrides: Partial<IntentModelReply>): IntentModelReply => ({
  kind: "none",
  statusQuestion: null,
  workSessionId: null,
  projectId: null,
  providerInstanceId: null,
  title: null,
  message: null,
  firingId: null,
  confirmed: null,
  description: "",
  confidence: "high",
  question: null,
  ...overrides,
});

const interpret = (sentence: string, overrides: Partial<IntentModelReply>) =>
  interpretIntentModelReply({ sentence, reply: reply(overrides), vocabulary });

describe("the model's reply is checked, never trusted", () => {
  it("resolves a sentence the grammar cannot parse", () => {
    const resolution = interpret("poke the scheduler thing and ask where it got to", {
      kind: "message_work_session",
      workSessionId: "ws-scheduler",
      message: "where did you get to?",
      description: "Tell Scheduler reconnect race: where did you get to?",
    });

    expect(resolution.outcome).toBe("resolved");
    if (resolution.outcome !== "resolved") return;
    expect(resolution.command).toEqual({
      kind: "message_work_session",
      workSessionId: "ws-scheduler",
      text: "where did you get to?",
    });
    // The description is the model's, because it is what the user was shown.
    expect(resolution.description).toBe("Tell Scheduler reconnect race: where did you get to?");
    expect(resolution.risk).toBe("low");
  });

  it("refuses an invented work session id instead of matching the nearest", () => {
    const resolution = interpret("tell the scheduler to stop", {
      kind: "message_work_session",
      workSessionId: "ws-scheduler-2",
      message: "stop",
      description: "Tell the scheduler: stop",
    });

    expect(resolution.outcome).toBe("refused");
    if (resolution.outcome !== "refused") return;
    expect(resolution.refusal.reason).toBe("unknown_target");
    // The refusal says what the model returned, which is the only way to
    // improve a prompt.
    expect(resolution.refusal.unplaced).toBe("ws-scheduler-2");
  });

  it("refuses an invented account id", () => {
    const resolution = interpret("get the other claude onto the deploy check", {
      kind: "resume_work_session",
      workSessionId: "ws-deploy",
      providerInstanceId: "claude-c",
      description: "Open another Claude session on the deploy check.",
    });

    expect(resolution.outcome).toBe("refused");
    if (resolution.outcome !== "refused") return;
    expect(resolution.refusal.reason).toBe("unknown_target");
  });

  it("refuses an account that is configured but not available", () => {
    const resolution = interpret("put robin on the deploy check", {
      kind: "resume_work_session",
      workSessionId: "ws-deploy",
      providerInstanceId: "claude-robin",
      description: "Open another Claude · robin session on the deploy check.",
    });

    expect(resolution.outcome).toBe("refused");
    if (resolution.outcome !== "refused") return;
    expect(resolution.refusal.message).toContain("not available");
  });

  it("does not refuse work whose own name contains 'production deploy'", () => {
    // The user calling their work "Production deploy check" is not the user
    // asking for a deploy. The outbound §24.1 check therefore reads the
    // sentence and the effectful text the model produced, never the
    // description — which quotes names this environment already holds.
    const resolution = interpret("how is the deploy check going", {
      kind: "status_work_session",
      workSessionId: "ws-deploy",
      description: "Say what Production deploy check is doing.",
    });

    expect(resolution.outcome).toBe("resolved");
  });

  it("refuses a high-risk request the model rephrased into something harmless-looking", () => {
    // The sentence never reaches the model — the grammar refuses it first. This
    // is the other direction: a model that turns an innocuous sentence into a
    // production deploy.
    const resolution = interpret("do the usual thing for the deploy check", {
      kind: "message_work_session",
      workSessionId: "ws-deploy",
      message: "deploy to production",
      description: "Tell Production deploy check: deploy to production",
    });

    expect(resolution.outcome).toBe("refused");
    if (resolution.outcome !== "refused") return;
    expect(resolution.refusal.reason).toBe("high_risk");
    expect(resolution.refusal.message).toContain("a production deploy");
  });

  it("asks rather than guesses when the model is unsure", () => {
    const resolution = interpret("tell it to stop", {
      kind: "message_work_session",
      workSessionId: "ws-scheduler",
      message: "stop",
      description: "Tell Scheduler reconnect race: stop",
      confidence: "low",
      question: "Do you mean the scheduler or the deploy check?",
    });

    expect(resolution.outcome).toBe("refused");
    if (resolution.outcome !== "refused") return;
    expect(resolution.refusal.reason).toBe("ambiguous_target");
    expect(resolution.refusal.message).toBe("Do you mean the scheduler or the deploy check?");
  });

  it("carries the model's question through when it cannot place the sentence", () => {
    const resolution = interpret("do the thing with the thing", {
      kind: "none",
      question: "Which work do you mean?",
    });

    expect(resolution.outcome).toBe("refused");
    if (resolution.outcome !== "refused") return;
    expect(resolution.refusal.reason).toBe("unrecognised");
    expect(resolution.refusal.message).toBe("Which work do you mean?");
  });

  it("refuses an empty message rather than sending one", () => {
    const resolution = interpret("say something to the scheduler", {
      kind: "message_work_session",
      workSessionId: "ws-scheduler",
      message: "   ",
      description: "Tell Scheduler reconnect race:",
    });

    expect(resolution.outcome).toBe("refused");
  });

  it("answers a parked question only when it names one that is waiting", () => {
    const good = interpret("yes go ahead with the scheduler one", {
      kind: "answer_gate",
      firingId: "firing-1",
      confirmed: true,
      description: "Answer yes to: Deploy the scheduler fix?",
    });
    expect(good.outcome).toBe("resolved");
    if (good.outcome === "resolved") {
      expect(good.command).toEqual({ kind: "answer_gate", firingId: "firing-1", confirmed: true });
      // Releasing a parked gate restarts automation, so it is never low risk.
      expect(good.risk).toBe("medium");
    }

    const bad = interpret("yes", {
      kind: "answer_gate",
      firingId: "firing-9",
      confirmed: true,
      description: "Answer yes",
    });
    expect(bad.outcome).toBe("refused");
  });

  it("falls back to an available account, never to an unavailable one", () => {
    const resolution = interpret("start something on vantageos", {
      kind: "start_work_session",
      projectId: "p-vantageos",
      title: "Look at the scheduler",
      description: "Start work on VantageOS.",
    });

    expect(resolution.outcome).toBe("resolved");
    if (resolution.outcome !== "resolved") return;
    expect(resolution.command).toEqual({
      kind: "start_work_session",
      projectId: "p-vantageos",
      title: "Look at the scheduler",
      providerInstanceId: "claude-sablebox",
      model: "claude-fable-5-1",
    });
    expect(resolution.risk).toBe("medium");
  });

  it("falls back to the widest status question when the model writes prose into the enum", () => {
    // Observed on a real run: asked for one of four words, a small model
    // sometimes writes "What is the current status of all work?". It has
    // answered the question that matters — which *kind* — and fumbled the one
    // that does not. Every status question is a read and `everything` is the
    // superset of the other three, so this is the one fallback in this file
    // that guesses nothing.
    const resolution = interpret("what is going on", {
      kind: "status_fleet",
      statusQuestion: "What is the current status of all work?",
      description: "Say where everything is.",
    });

    expect(resolution.outcome).toBe("resolved");
    if (resolution.outcome !== "resolved") return;
    expect(resolution.command).toEqual({ kind: "status_fleet", question: "everything" });
  });

  it("keeps a status question the model named correctly", () => {
    const resolution = interpret("anything waiting on me", {
      kind: "status_fleet",
      statusQuestion: "needs_me",
      description: "Say what needs you.",
    });

    expect(resolution.outcome).toBe("resolved");
    if (resolution.outcome !== "resolved") return;
    expect(resolution.command).toEqual({ kind: "status_fleet", question: "needs_me" });
  });
});

describe("the prompt says only what the model is allowed to know", () => {
  const prompt = buildIntentModelPrompt({
    sentence: "poke the scheduler",
    vocabulary,
  });

  it("lists every id the model may use, and marks what the user is looking at", () => {
    expect(prompt).toContain("ws-scheduler");
    expect(prompt).toContain("claude-sablebox");
    expect(prompt).toContain("p-vantageos");
    expect(prompt).toContain("firing-1");
    expect(prompt).toContain("[the user is looking at this one]");
    expect(prompt).toContain("[waiting for approval]");
  });

  it("carries no thread contents, and says so by carrying only names", () => {
    // A guard rather than a wish: if somebody adds transcripts to the prompt,
    // this fails and they have to argue with the comment above it.
    expect(prompt).not.toMatch(/\b(?:diff|patch|transcript|file contents)\b/i);
  });

  it("requires every field, so a partial reply is a decode failure rather than a default", () => {
    expect(INTENT_MODEL_JSON_SCHEMA.required).toContain("confidence");
    expect(INTENT_MODEL_JSON_SCHEMA.required).toContain("description");
    expect(INTENT_MODEL_JSON_SCHEMA.additionalProperties).toBe(false);
  });
});
