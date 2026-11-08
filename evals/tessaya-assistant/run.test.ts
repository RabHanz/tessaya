import { describe, expect, it } from "vite-plus/test";

import type { AssistantCase } from "./cases.ts";
import { casePasses, firstTool, passes } from "./grade.ts";

const c: AssistantCase = {
  id: "t",
  source: "test",
  said: "tell the build session to rerun the tests",
  first: ["sessions_list", "session_send"],
  not: ["weave_send"],
};

describe("the assistant eval's grader", () => {
  it("reads the first tool, with the MCP prefix off, and none when there was none", () => {
    expect(firstTool(["mcp__baton__needs_me", "Read"])).toBe("needs_me");
    expect(firstTool([])).toBe("none");
  });

  const s = (...calls: string[]) => ({ calls, reply: "" });
  it("passes an accepted first tool and fails a wrong one", () => {
    expect(passes(c, s("mcp__baton__sessions_list"))).toBe(true);
    expect(passes(c, s("mcp__baton__weave_send"))).toBe(false);
    expect(passes(c, s())).toBe(false);
  });

  it("fails a turn run on another model than the case's", () => {
    const fast = { ...c, model: "haiku" };
    expect(passes(fast, { ...s("mcp__baton__sessions_list"), model: "haiku" })).toBe(true);
    expect(passes(fast, { ...s("mcp__baton__sessions_list"), model: "opus" })).toBe(false);
  });

  it("fails a reply that leaves out the words the case needs", () => {
    const named = { ...c, first: ["none"], says: "ten" };
    expect(passes(named, { calls: [], reply: "It's ten." })).toBe(true);
    expect(passes(named, { calls: [], reply: "It's four." })).toBe(false);
  });

  it("fails a spoken reply that says what the case forbids, such as a path", () => {
    const quiet = { ...c, first: ["none"], notSays: [".md", "/"] };
    expect(passes(quiet, { calls: [], reply: "The security policy has a conflict." })).toBe(true);
    expect(passes(quiet, { calls: [], reply: "A conflict in .github/SECURITY.md." })).toBe(false);
  });

  it("fails a persona's reply that opens with its name", () => {
    const freya = { ...c, first: ["none"], wake: "Freya" };
    expect(passes(freya, { calls: [], reply: "Freya here. It's ten." })).toBe(false);
    expect(passes(freya, { calls: [], reply: "It's ten, Freya says." })).toBe(true);
  });

  it("passes a recorded turn only when it reaches its goal tool within its calls", () => {
    const recorded = { ...c, first: ["window_focus", "type_text"], goal: "type_text", maxCalls: 2 };
    expect(passes(recorded, s("mcp__baton__window_focus", "mcp__baton__type_text"))).toBe(true);
    expect(
      passes(
        recorded,
        s("mcp__baton__window_focus", "mcp__baton__screenshot", "mcp__baton__type_text"),
      ),
    ).toBe(false);
    expect(passes(recorded, s("mcp__baton__window_focus"))).toBe(false);
    const split = { ...c, first: ["job_split"], goal: "job_split", goalArgs: ["Alfred"] };
    const call = (role: string) => ({
      calls: ["mcp__baton__job_split"],
      inputs: [{ id: "j", parts: [{ title: "code", goal: "fix", role }] }],
      reply: "",
    });
    expect(passes(split, call("alfred"))).toBe(true);
    expect(passes(split, call("engineering"))).toBe(false);
    const words = { ...split, goalArgs: [], notGoalArgs: ['"parts":'] };
    expect(passes(words, call("alfred"))).toBe(false);
  });

  it("fails a case when half or more of its samples fail", () => {
    expect(casePasses(c, [s("mcp__baton__session_send"), s()])).toBe(false);
    expect(casePasses(c, [s("mcp__baton__session_send"), s("mcp__baton__session_send"), s()])).toBe(
      true,
    );
  });
});
