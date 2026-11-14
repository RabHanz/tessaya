import { describe, expect, it } from "vite-plus/test";

import { SessionClosed } from "../screen/claudeVision.ts";
import { createTurnLedger, stoppedBy, traceCalls } from "./turnLedger.ts";

describe("each turn's own record", () => {
  it("gives a turn only what ran while it was the one running", () => {
    const ledger = createTurnLedger();
    const first = ledger.ask();
    const second = ledger.ask();
    ledger.begin();
    ledger.current().tools.push("mcp__baton__type_text");
    ledger.current().decisions.push({ tool: "mcp__baton__type_text", outcome: "asked" });
    first.done();
    // The second sentence was heard while the first waited, and stopped before it began.
    second.done();
    expect(first.record().tools).toEqual(["mcp__baton__type_text"]);
    expect(second.record()).toEqual({
      tools: [],
      results: [],
      decisions: [],
      routes: [],
      answers: {},
      skills: [],
    });
    // A late answer after both ended lands in no turn.
    ledger.current().decisions.push({ tool: "mcp__baton__type_text", outcome: "he said no" });
    const third = ledger.ask();
    ledger.begin();
    expect(third.record().decisions).toEqual([]);
  });

  it("says what stopped a turn and keeps its calls without values or answers", () => {
    const ok = { tool: "type_text", ok: true, argKeys: ["text"], ms: 120 };
    const guard = {
      tool: "window_focus",
      ok: false,
      error: "Stopped: window_focus has failed 2 times in a row with these same arguments.",
      argKeys: ["title"],
      ms: 5,
    };
    const mouse = { ...guard, error: "He moved the mouse, so I stopped." };
    expect(stoppedBy([ok], null)).toBeNull();
    expect(stoppedBy([ok], new SessionClosed("Stopped."))).toBe("stop");
    expect(stoppedBy([ok, guard], null)).toBe("guard");
    expect(stoppedBy([mouse], new Error("x"))).toBe("mouse");
    expect(traceCalls([ok, guard])).toEqual([
      { tool: "type_text", argKeys: ["text"], ok: true, ms: 120 },
      { tool: "window_focus", argKeys: ["title"], ok: false, ms: 5 },
    ]);
  });
});
