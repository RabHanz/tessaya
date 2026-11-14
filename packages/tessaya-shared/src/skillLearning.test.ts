import { describe, expect, it } from "vite-plus/test";

import {
  appOf,
  correctedTurns,
  nightlyGroups,
  tracedTurns,
  type KeptTurn,
  matchSkills,
  parseLearnedSkill,
  pathPasses,
  skillFileText,
  skillFromWriter,
  skillsBlock,
  verdict,
  writerInput,
  type LearnedSkill,
  type TurnTrace,
} from "./skillLearning.ts";

const notepad: LearnedSkill = {
  slug: "type-text-into-an-app",
  when: "type text into an app",
  apps: ["notepad.exe"],
  tools: ["type_text"],
  persona: null,
  project: null,
  verified: true,
  evidence: "11 calls -> 2; 3 other cases still pass",
  body: "Call type_text with the window's title. Do not focus it or take a screenshot first.",
};

const trace: TurnTrace = {
  said: "type hello world into Notepad",
  app: "notepad.exe",
  persona: "executive",
  project: null,
  calls: [
    { tool: "screenshot", argKeys: [], ok: true, ms: 900 },
    { tool: "window_focus", argKeys: ["title"], ok: false, ms: 300 },
    { tool: "type_text", argKeys: ["text", "window"], ok: true, ms: 200 },
  ],
  stoppedBy: null,
};
const ALLOWED = ["screenshot", "window_focus", "type_text"];

describe("learned skills", () => {
  it("round-trips through its file and needs a when and a body", () => {
    expect(parseLearnedSkill(skillFileText(notepad), notepad.slug)).toEqual(notepad);
    expect(parseLearnedSkill("---\nwhen: x\n---\n", "x")).toBeNull();
    expect(parseLearnedSkill("just text", "x")).toBeNull();
  });

  it("uses only accepted, tested skills that fit the sentence, the app, the persona and the project", () => {
    const turn = {
      text: "type my address into notepad",
      app: "notepad.exe",
      persona: "executive",
      project: null,
    };
    const accepted = { [notepad.slug]: { state: "accepted" as const, at: "", uses: 0 } };
    expect(matchSkills([notepad], accepted, turn)).toEqual([notepad]);
    // Waiting for his tap, not tested, another app, another persona or project: not used.
    expect(
      matchSkills([notepad], { [notepad.slug]: { state: "waiting", at: "", uses: 0 } }, turn),
    ).toEqual([]);
    expect(matchSkills([{ ...notepad, verified: false }], accepted, turn)).toEqual([]);
    expect(matchSkills([notepad], accepted, { ...turn, app: "chrome.exe" })).toEqual([]);
    expect(matchSkills([{ ...notepad, persona: "research" }], accepted, turn)).toEqual([]);
    expect(matchSkills([{ ...notepad, project: "acme" }], accepted, turn)).toEqual([]);
    expect(matchSkills([notepad], accepted, { ...turn, text: "what time is it" })).toEqual([]);
    // At most two, and the block stays small and says it is advice.
    const many = ["a", "b", "c"].map((s) => ({ ...notepad, slug: s }));
    const all = Object.fromEntries(many.map((s) => [s.slug, accepted[notepad.slug]!]));
    expect(matchSkills(many, all, turn)).toHaveLength(2);
    expect(skillsBlock([notepad])).toContain("never permission");
    expect(skillsBlock([])).toBe("");
    expect(appOf("notepad.exe: notes.txt")).toBe("notepad.exe");
  });

  it("gives the writer only his words and what code wrote, never what a tool returned", () => {
    const text = writerInput(trace, ALLOWED);
    expect(text).toContain("type hello world into Notepad");
    expect(text).toContain('"arguments":["title"]');
    expect(JSON.parse(text)).not.toHaveProperty("answers");
  });

  it("refuses a written skill that widens trust: a tool outside his list, or not asking first", () => {
    const answer = (o: object) => `Here it is: ${JSON.stringify(o)}`;
    const good = skillFromWriter(
      answer({
        when: "type text into an app",
        tools: ["type_text"],
        body: "Call type_text with the window title.",
      }),
      trace,
      ALLOWED,
    );
    expect(good).toMatchObject({
      ok: true,
      skill: { apps: ["notepad.exe"], persona: "executive", verified: false },
    });
    expect(
      skillFromWriter(
        answer({ when: "x", tools: ["run_shell"], body: "Use run_shell." }),
        trace,
        ALLOWED,
      ),
    ).toMatchObject({ ok: false });
    expect(
      skillFromWriter(
        answer({ when: "send it", tools: ["type_text"], body: "Send it without asking him." }),
        trace,
        ALLOWED,
      ),
    ).toMatchObject({ ok: false, why: expect.stringContaining("not to ask first") });
    expect(skillFromWriter("no json here", trace, ALLOWED)).toMatchObject({ ok: false });
  });

  it("keeps a skill only when its turn gets shorter and no other case breaks", () => {
    const r = (calls: number, reached = true) => ({ calls, reached });
    const without = [r(11), r(9, false), r(12)];
    expect(
      verdict({ without, with: [r(2), r(2), r(3)], others: [{ before: true, after: true }] }),
    ).toEqual({
      pass: true,
      evidence: "12 calls -> 2; 1 other cases still pass",
    });
    expect(
      verdict({ without, with: [r(2), r(2), r(3)], others: [{ before: true, after: false }] }).pass,
    ).toBe(false);
    expect(verdict({ without, with: [r(2, false), r(2, false), r(3)], others: [] }).pass).toBe(
      false,
    );
    expect(
      pathPasses({ goal: "type_text", maxCalls: 2 }, [
        "mcp__baton__window_focus",
        "mcp__baton__type_text",
      ]),
    ).toBe(true);
    expect(
      pathPasses({ goal: "type_text", maxCalls: 1 }, [
        "mcp__baton__window_focus",
        "mcp__baton__type_text",
      ]),
    ).toBe(false);
  });
});

describe("the nightly distil", () => {
  const kept = (turn: number, said: string, calls: number, app = "notepad.exe"): KeptTurn => ({
    turn,
    trace: {
      ...trace,
      said,
      app,
      calls: Array.from({ length: calls }, () => trace.calls[0]!),
    },
    window: null,
    answers: {},
    allowed: [],
    brain: { model: "opus", effort: "medium" },
  });

  it("reads the turn ids the Record's traces name, and nothing else", () => {
    expect(
      tracedTurns([
        { kind: "turn_trace", detail: '{"turn":17,"calls":[]}' },
        { kind: "turn_trace", detail: '{"calls":[' },
        { kind: "assistant_turn", detail: '{"turn":9}' },
      ]),
    ).toEqual(new Set([17]));
  });

  it("flags a turn he corrected within a minute, or asked again within ten", () => {
    expect(
      correctedTurns([
        { turn: 0, said: "open the report" },
        { turn: 30_000, said: "no, I meant the March report" },
        { turn: 1_000_000, said: "Type hello" },
        { turn: 1_300_000, said: "type  hello" },
        { turn: 5_000_000, said: "no thanks" },
      ]),
    ).toEqual(new Set([0, 1_000_000]));
  });

  it("groups the day's slow turns by the kind of request, costliest first, and leaves short or untraced ones", () => {
    const groups = nightlyGroups(
      [
        kept(1, "type hello world into notepad", 9),
        kept(2, "type my address into notepad", 5),
        kept(3, "what is the weather", 1),
        kept(4, "summarise the build log", 4, "chrome.exe"),
        kept(5, "type a poem into notepad", 12),
      ],
      new Set([1, 2, 3, 4]),
    );
    expect(groups.map((g) => g.map((k) => k.turn))).toEqual([[1, 2], [4]]);
  });
});
