import { describe, expect, it } from "vite-plus/test";

import { resolveBatonIntent, type IntentVocabulary } from "./intentParser.ts";

/**
 * A fleet that looks like the Director's: two projects, work in both, two
 * accounts, one of which is not installed here.
 */
const base: IntentVocabulary = {
  workSessions: [
    {
      id: "ws-scheduler",
      title: "Scheduler reconnect race",
      projectId: "project-vantageos",
      projectLabel: "VantageOS",
      needsApproval: false,
      updatedAt: "2026-09-18T05:00:00.000Z",
    },
    {
      id: "ws-search",
      title: "Search ranking",
      projectId: "project-margin",
      projectLabel: "The Margin",
      needsApproval: false,
      updatedAt: "2026-09-18T06:00:00.000Z",
    },
  ],
  projects: [
    { id: "project-vantageos", title: "VantageOS" },
    { id: "project-margin", title: "The Margin" },
  ],
  providers: [
    {
      instanceId: "claude-a",
      driver: "claudeAgent",
      aliases: ["claude", "claude a", "claudeagent"],
      label: "Claude A",
      model: "claude-sonnet",
      available: true,
      signedIn: true,
    },
    {
      instanceId: "codex",
      driver: "codex",
      aliases: ["codex"],
      label: "Codex",
      model: "gpt-5",
      available: false,
      signedIn: false,
    },
  ],
  openGates: [],
  hostAliases: ["harbour box", "home linux"],
  focusedWorkSessionId: null,
};

const vocabulary = (overrides?: Partial<IntentVocabulary>): IntentVocabulary => ({
  ...base,
  ...overrides,
});

const resolve = (text: string, overrides?: Partial<IntentVocabulary>) =>
  resolveBatonIntent(text, vocabulary(overrides));

describe("resolveBatonIntent — switching the Claude account", () => {
  it("reads the sentence and leaves the label for the live pool", () => {
    for (const text of [
      "switch account to optima",
      "change the account to Optima.",
      "switch to the optima account",
      "use the optima account",
      "Baton, rotate accounts to optima",
    ]) {
      const result = resolve(text, { focusedWorkSessionId: "ws-search" });
      expect(result.outcome, text).toBe("resolved");
      if (result.outcome !== "resolved") continue;
      expect(result.command).toEqual({
        kind: "switch_account",
        accountLabel: "optima",
        workSessionId: "ws-search",
      });
      expect(result.risk).toBe("medium");
    }
  });

  it("moves only the work he is looking at, never the one that moved last", () => {
    const unfocused = resolve("use the optima account");
    expect(unfocused.outcome).toBe("refused");
    if (unfocused.outcome === "refused") expect(unfocused.refusal.reason).toBe("ambiguous_target");
  });

  it("does not take a session handoff or a focus request for one", () => {
    expect(resolve("switch to the scheduler").outcome).toBe("refused");
    expect(resolve("Hand this off to Claude B").outcome).toBe("refused");
  });
});

describe("resolveBatonIntent — §20's status questions", () => {
  it("answers the specification's own status sentences", () => {
    // §20's examples, verbatim. These are the sentences the fleet must already
    // be able to answer without interrupting any provider.
    for (const [text, question] of [
      ["What needs me?", "needs_me"],
      ["What finished?", "finished"],
      ["What's running?", "running"],
    ] as const) {
      const result = resolve(text);
      expect(result.outcome).toBe("resolved");
      if (result.outcome !== "resolved") continue;
      expect(result.command).toEqual({ kind: "status_fleet", question });
      expect(result.risk).toBe("low");
    }
  });

  it("answers §20's per-session question and names the work it resolved", () => {
    const result = resolve("What's VantageOS doing?");
    expect(result.outcome).toBe("resolved");
    if (result.outcome !== "resolved") return;
    // "VantageOS" is a project with one piece of work in it, so this is not
    // ambiguous — and the command carries an id, never the words.
    expect(result.command).toEqual({
      kind: "status_work_session",
      workSessionId: "ws-scheduler",
    });
    expect(result.description).toBe("Say what VantageOS / Scheduler reconnect race is doing.");
  });

  it("takes 'where are we on X' as the same question", () => {
    const result = resolve("Where are we on the search ranking?");
    expect(result.outcome).toBe("resolved");
    if (result.outcome !== "resolved") return;
    expect(result.command).toEqual({ kind: "status_work_session", workSessionId: "ws-search" });
  });

  it("strips a wake word and politeness before deciding anything", () => {
    // §24.2: the wake word authorises nothing. It is discarded, not matched.
    for (const text of [
      "Hey Jarvis, what needs me?",
      "Jarvis, what needs me",
      "Can you please tell me what needs me?",
    ]) {
      const result = resolve(text);
      expect(result.outcome).toBe("resolved");
      if (result.outcome !== "resolved") continue;
      expect(result.command).toEqual({ kind: "status_fleet", question: "needs_me" });
    }
  });

  it("says nothing was said when a sentence is only a wake word", () => {
    const result = resolve("Hey Jarvis");
    expect(result.outcome).toBe("refused");
    if (result.outcome !== "refused") return;
    expect(result.refusal.reason).toBe("unrecognised");
  });
});

describe("resolveBatonIntent — messaging a session", () => {
  it("sends the user's own words, with their capitals", () => {
    const result = resolve("Tell the Scheduler reconnect race to run the migration tests too");
    expect(result.outcome).toBe("resolved");
    if (result.outcome !== "resolved") return;
    expect(result.command).toEqual({
      kind: "message_work_session",
      workSessionId: "ws-scheduler",
      text: "run the migration tests too",
    });
    expect(result.risk).toBe("low");
  });

  it("keeps the colon form's message verbatim", () => {
    const result = resolve("Tell VantageOS: Also run the migration tests.");
    expect(result.outcome).toBe("resolved");
    if (result.outcome !== "resolved") return;
    if (result.command.kind !== "message_work_session") return;
    // The message reaches an agent; it is not normalised on the way.
    expect(result.command.text).toBe("Also run the migration tests");
  });

  it("uses what the client says is focused when the sentence says 'it'", () => {
    // §14 rung 3. The environment cannot know what is on screen unless told.
    const result = resolve("Tell it to run the other test too", {
      focusedWorkSessionId: "ws-scheduler",
    });
    expect(result.outcome).toBe("resolved");
    if (result.outcome !== "resolved") return;
    expect(result.workSessionId).toBe("ws-scheduler");
  });

  it("falls back to what moved last, and only for a pronoun", () => {
    const result = resolve("Tell it to stop");
    expect(result.outcome).toBe("resolved");
    if (result.outcome !== "resolved") return;
    // Rung 6: the most recently updated work, which is the search ranking.
    expect(result.workSessionId).toBe("ws-search");
  });

  it("refuses a named target it cannot place rather than using the focused one", () => {
    // The failure this prevents: a message meant for one account landing in
    // another because the resolver fell back instead of refusing.
    const result = resolve("Tell the deploy pipeline to stop", {
      focusedWorkSessionId: "ws-scheduler",
    });
    expect(result.outcome).toBe("refused");
    if (result.outcome !== "refused") return;
    expect(result.refusal.reason).toBe("unknown_target");
    expect(result.refusal.unplaced).toBe("deploy pipeline");
  });

  it("asks which one when a project has two pieces of work", () => {
    const result = resolve("Tell VantageOS to run the tests", {
      workSessions: [
        ...base.workSessions,
        {
          id: "ws-migrations",
          title: "Migration rehearsal",
          projectId: "project-vantageos",
          projectLabel: "VantageOS",
          needsApproval: false,
          updatedAt: "2026-09-18T04:00:00.000Z",
        },
      ],
    });
    expect(result.outcome).toBe("refused");
    if (result.outcome !== "refused") return;
    expect(result.refusal.reason).toBe("ambiguous_target");
    expect(result.refusal.message).toContain("Scheduler reconnect race");
    expect(result.refusal.message).toContain("Migration rehearsal");
  });

  it("names the ids when two pieces of work share a title, and answers to them", () => {
    // Straight from the live run: "That could be Intent proof, or Intent
    // proof" is a refusal nobody can act on.
    const twins: Partial<IntentVocabulary> = {
      workSessions: [
        {
          id: "intent-proof-1",
          title: "Intent proof",
          projectId: "project-vantageos",
          projectLabel: "VantageOS",
          needsApproval: false,
          updatedAt: "2026-09-18T05:00:00.000Z",
        },
        {
          id: "intent-proof-2",
          title: "Intent proof",
          projectId: "project-vantageos",
          projectLabel: "VantageOS",
          needsApproval: false,
          updatedAt: "2026-09-18T06:00:00.000Z",
        },
      ],
    };
    const refused = resolve("Tell the intent proof to stop", twins);
    expect(refused.outcome).toBe("refused");
    if (refused.outcome !== "refused") return;
    expect(refused.refusal.message).toContain("intent-proof-1");
    expect(refused.refusal.message).toContain("intent-proof-2");

    // And the id the refusal named is a name the grammar accepts.
    const answered = resolve("Tell intent-proof-2 to stop", twins);
    expect(answered.outcome).toBe("resolved");
    if (answered.outcome !== "resolved") return;
    expect(answered.workSessionId).toBe("intent-proof-2");
  });
});

describe("resolveBatonIntent — starting and resuming work", () => {
  it("starts work on a named project with a named account", () => {
    const result = resolve("Start work on VantageOS with Claude A");
    expect(result.outcome).toBe("resolved");
    if (result.outcome !== "resolved") return;
    expect(result.command).toEqual({
      kind: "start_work_session",
      projectId: "project-vantageos",
      title: "New work",
      providerInstanceId: "claude-a",
      model: "claude-sonnet",
    });
    // It spends a subscription, so it is not a low-risk sentence.
    expect(result.risk).toBe("medium");
  });

  it("keeps a title the sentence gave it", () => {
    const result = resolve("Start work on VantageOS called scheduler retry backoff with claude");
    expect(result.outcome).toBe("resolved");
    if (result.outcome !== "resolved") return;
    if (result.command.kind !== "start_work_session") return;
    expect(result.command.title).toBe("scheduler retry backoff");
  });

  it("picks the only usable account without being told, and never between two", () => {
    const one = resolve("Start work on VantageOS");
    expect(one.outcome).toBe("resolved");
    if (one.outcome === "resolved" && one.command.kind === "start_work_session") {
      // Codex is configured here and not installed, so there is exactly one
      // usable account and choosing it is arithmetic, not a guess.
      expect(one.command.providerInstanceId).toBe("claude-a");
    }

    const two = resolve("Start work on VantageOS", {
      providers: base.providers.map((provider) => ({ ...provider, available: true })),
    });
    expect(two.outcome).toBe("refused");
    if (two.outcome !== "refused") return;
    expect(two.refusal.reason).toBe("ambiguous_target");
    expect(two.refusal.message).toContain("Claude A");
    expect(two.refusal.message).toContain("Codex");
  });

  it("refuses an account this environment cannot run", () => {
    const result = resolve("Start work on VantageOS with Codex");
    expect(result.outcome).toBe("refused");
    if (result.outcome !== "refused") return;
    expect(result.refusal.reason).toBe("unknown_target");
    expect(result.refusal.message).toContain("not available on this environment");
  });

  it("resumes existing work with another session", () => {
    const result = resolve("Continue the scheduler reconnect race with Claude A");
    expect(result.outcome).toBe("resolved");
    if (result.outcome !== "resolved") return;
    expect(result.command).toEqual({
      kind: "resume_work_session",
      workSessionId: "ws-scheduler",
      providerInstanceId: "claude-a",
      model: "claude-sonnet",
    });
  });

  it("sends the sentence back when it names another machine", () => {
    // Cross-environment routing is the client's job: it decides which
    // environment to ask. Doing the work here would be the wrong answer.
    const result = resolve("Start work on VantageOS on the laptop with claude");
    expect(result.outcome).toBe("refused");
    if (result.outcome !== "refused") return;
    expect(result.refusal.reason).toBe("unknown_target");
    expect(result.refusal.message).toContain("Ask the one that is");
  });

  it("accepts this environment's own name", () => {
    const result = resolve("Start work on VantageOS on the harbour box with claude");
    expect(result.outcome).toBe("resolved");
  });
});

describe("resolveBatonIntent — rules", () => {
  it("hands §22's own sentence to the rule grammar and reads the rules back", () => {
    const result = resolve(
      "When Claude finishes this, have Codex review it and tell me if either needs me.",
      {
        focusedWorkSessionId: "ws-scheduler",
      },
    );
    expect(result.outcome).toBe("resolved");
    if (result.outcome !== "resolved") return;
    if (result.command.kind !== "create_rules") return;
    expect(result.command.workSessionId).toBe("ws-scheduler");
    expect(result.command.rules).toHaveLength(2);
    expect(result.description).toBe("Create 2 rules on VantageOS / Scheduler reconnect race.");
    // One of them will start a provider session, and the read-back has to
    // carry that weight before the user presses enter.
    expect(result.risk).toBe("medium");
  });

  it("leaves a sentence that starts with 'after' to the rest of the grammar", () => {
    const result = resolve("After lunch, remind me to call Sam.");
    expect(result.outcome === "refused" && result.refusal.reason).not.toBe("rule_not_understood");
  });

  it("passes the rule grammar's refusal through with its own words", () => {
    const result = resolve("When Claude finishes, deploy to staging.", {
      focusedWorkSessionId: "ws-scheduler",
    });
    expect(result.outcome).toBe("refused");
    if (result.outcome !== "refused") return;
    expect(result.refusal.reason).toBe("rule_not_understood");
    expect(result.refusal.unplaced).toContain("deploy to staging");
  });
});

describe("resolveBatonIntent — confirmation gates", () => {
  const gates = {
    openGates: [
      {
        firingId: "rule-1#1",
        workSessionId: "ws-scheduler",
        question: "Restart the worker?",
      },
    ],
  };

  it("answers the one question that is waiting", () => {
    const result = resolve("Yes, go ahead", gates);
    expect(result.outcome).toBe("resolved");
    if (result.outcome !== "resolved") return;
    expect(result.command).toEqual({
      kind: "answer_gate",
      firingId: "rule-1#1",
      confirmed: true,
    });
    expect(result.description).toBe("Answer yes to: Restart the worker?");
    // Saying yes releases whatever was queued behind it.
    expect(result.risk).toBe("medium");
  });

  it("takes no for an answer", () => {
    const result = resolve("No", gates);
    expect(result.outcome).toBe("resolved");
    if (result.outcome !== "resolved") return;
    if (result.command.kind !== "answer_gate") return;
    expect(result.command.confirmed).toBe(false);
  });

  it("narrows to the named work when several questions wait", () => {
    const result = resolve("Yes, go ahead on the search ranking", {
      openGates: [
        ...gates.openGates,
        { firingId: "rule-2#1", workSessionId: "ws-search", question: "Publish the index?" },
      ],
    });
    expect(result.outcome).toBe("resolved");
    if (result.outcome !== "resolved") return;
    if (result.command.kind !== "answer_gate") return;
    expect(result.command.firingId).toBe("rule-2#1");
  });

  it("asks which one rather than picking, when two are waiting", () => {
    // §14 rung 9: clarify only when the ambiguity is material. Answering the
    // wrong gate is exactly the material kind.
    const result = resolve("Yes", {
      openGates: [
        ...gates.openGates,
        { firingId: "rule-2#1", workSessionId: "ws-search", question: "Publish the index?" },
      ],
    });
    expect(result.outcome).toBe("refused");
    if (result.outcome !== "refused") return;
    expect(result.refusal.reason).toBe("ambiguous_target");
    expect(result.refusal.message).toContain("Restart the worker?");
  });

  it("says so when nothing is waiting, and distinguishes a provider's own approval", () => {
    const plain = resolve("Yes, go ahead");
    expect(plain.outcome).toBe("refused");
    if (plain.outcome === "refused") {
      expect(plain.refusal.reason).toBe("nothing_to_confirm");
    }

    const waiting = resolve("Yes, go ahead", {
      workSessions: base.workSessions.map((workSession) => ({
        ...workSession,
        needsApproval: true,
      })),
    });
    expect(waiting.outcome).toBe("refused");
    if (waiting.outcome !== "refused") return;
    // A provider's approval request is T3's own surface. Saying "nothing is
    // waiting" while a session sits on an approval would be false.
    expect(waiting.refusal.message).toContain("approval request");
  });
});

describe("resolveBatonIntent — what it will not do", () => {
  it("refuses §24.1's high-risk list by name, never as gibberish", () => {
    // §24.2: a wake word alone never authorises a high-risk action. Here
    // nothing authorises one, and the point is that the sentence is
    // *recognised* — an unparsed "deploy to production" would invite a retry.
    for (const text of [
      "Deploy to production",
      "Restart the production api",
      "Merge it into main",
      "Drop the database",
      "Tell VantageOS to delete everything",
      "Show me the API key",
      "Rotate the credentials",
    ]) {
      const result = resolveBatonIntent(text, vocabulary());
      expect(result.outcome).toBe("refused");
      if (result.outcome !== "refused") continue;
      expect(result.refusal.reason).toBe("high_risk");
      expect(result.refusal.unplaced).toBe(text);
    }
  });

  it("classifies risk before it classifies intent", () => {
    // "Tell VantageOS to deploy to production" parses as a message, and a
    // message is low risk. The high-risk check runs first precisely so that
    // routing it through an agent is not a way around it.
    const result = resolve("Tell VantageOS to deploy to production");
    expect(result.outcome).toBe("refused");
    if (result.outcome !== "refused") return;
    expect(result.refusal.reason).toBe("high_risk");
  });

  it("names the phases that are not built instead of pretending not to understand", () => {
    for (const [text, expected] of [
      ["Show me the scheduler", "showing a session"],
      ["Dictate: thanks, I'll send the revised version tomorrow", "dictation"],
      ["Hand this off to Claude B", "an account handoff"],
      ["Stop listening", "listening control"],
    ] as const) {
      const result = resolve(text);
      expect(result.outcome).toBe("refused");
      if (result.outcome !== "refused") continue;
      expect(result.refusal.reason).toBe("not_available_yet");
      expect(result.refusal.message).toContain(expected);
    }
  });

  it("keeps dictation on the client, and says so rather than calling it unbuilt", () => {
    // The words are an email to somebody else. The environment refuses to
    // receive them at all, which is a stronger guarantee than handling them
    // carefully once they arrive.
    const result = resolve("Dictate: thanks, I'll send the revised version tomorrow");
    expect(result.outcome).toBe("refused");
    if (result.outcome !== "refused") return;
    expect(result.refusal.reason).toBe("not_available_yet");
    expect(result.refusal.message).toContain("never sends them here");
  });

  it("refuses an unrecognised sentence with the sentence in it", () => {
    const result = resolve("Sort out the thing with the stuff");
    expect(result.outcome).toBe("refused");
    if (result.outcome !== "refused") return;
    expect(result.refusal.reason).toBe("unrecognised");
    expect(result.refusal.unplaced).toBe("Sort out the thing with the stuff");
    expect(result.refusal.message).toContain("what needs me");
  });

  it("refuses rather than inventing a target when there is no work at all", () => {
    const result = resolve("Tell it to stop", { workSessions: [], focusedWorkSessionId: null });
    expect(result.outcome).toBe("refused");
    if (result.outcome !== "refused") return;
    expect(result.refusal.reason).toBe("unknown_target");
  });

  it("is case-insensitive and tolerates curly apostrophes", () => {
    const result = resolve("WHAT’S RUNNING?");
    expect(result.outcome).toBe("resolved");
    if (result.outcome !== "resolved") return;
    expect(result.command).toEqual({ kind: "status_fleet", question: "running" });
  });
});
