import { describe, expect, it } from "vite-plus/test";

import {
  noteLive,
  autoResumeAllowed,
  classifyTranscriptTail,
  diedAgain,
  emptyAutoResumeState,
  markStoppedOnPurpose,
  recordAutoResume,
  RESTART_NOTICE,
} from "./AutoResume.ts";

const line = (o: unknown) => JSON.stringify(o);
const user = (content: unknown, extra: Record<string, unknown> = {}) =>
  line({ type: "user", message: { role: "user", content }, ...extra });
const assistant = (content: unknown, stop: string | null | undefined) =>
  line({
    type: "assistant",
    message: { role: "assistant", content, ...(stop === undefined ? {} : { stop_reason: stop }) },
  });

describe("what the end of a transcript says about the last turn", () => {
  it("is unfinished when the last entry is a question nobody answered", () => {
    expect(
      classifyTranscriptTail(
        [assistant([{ type: "text", text: "Done" }], "end_turn"), user("Now fix the tests")].join(
          "\n",
        ),
      ),
    ).toBe("unfinished");
  });
  it("is unfinished on a tool call with no result, a tool result nobody read, or an assistant cut off mid-turn", () => {
    const call = assistant([{ type: "tool_use", id: "t1", name: "Bash", input: {} }], "tool_use");
    expect(classifyTranscriptTail([user("go"), call].join("\n"))).toBe("unfinished");
    expect(
      classifyTranscriptTail(
        [user("go"), call, user([{ type: "tool_result", tool_use_id: "t1", content: "ok" }])].join(
          "\n",
        ),
      ),
    ).toBe("unfinished");
    expect(
      classifyTranscriptTail(
        [user("go"), assistant([{ type: "text", text: "Working on" }], null)].join("\n"),
      ),
    ).toBe("unfinished");
  });
  it("is finished after a clean end of turn, and when he interrupted or left on purpose", () => {
    expect(
      classifyTranscriptTail(
        [user("hi"), assistant([{ type: "text", text: "Hello" }], "end_turn")].join("\n"),
      ),
    ).toBe("finished");
    expect(
      classifyTranscriptTail(
        [user("go"), user([{ type: "text", text: "[Request interrupted by user]" }])].join("\n"),
      ),
    ).toBe("finished");
    expect(
      classifyTranscriptTail([user("hi"), user("<command-name>/exit</command-name>")].join("\n")),
    ).toBe("finished");
  });
  it("skips lines that are not conversation, and does not guess from nothing or from an old format", () => {
    expect(
      classifyTranscriptTail(
        [user("hi"), line({ type: "summary", summary: "x" }), "{broken"].join("\n"),
      ),
    ).toBe("unfinished");
    expect(classifyTranscriptTail("")).toBe("unknown");
    expect(
      classifyTranscriptTail(
        [user("hi"), assistant([{ type: "text", text: "ok" }], undefined)].join("\n"),
      ),
    ).toBe("unknown");
  });
});

describe("when the watchdog may resume a session", () => {
  it("only for a session that was live, and not in the first minutes after it stopped", () => {
    const base2 = {
      verdict: "unfinished" as const,
      background: false,
      enabled: true,
      running: false,
      now: 1_000_000_000,
      sessionId: "s1",
    };
    expect(autoResumeAllowed({ ...base2, state: emptyAutoResumeState }).why).toMatch(/only listed/);
    const seen = noteLive(emptyAutoResumeState, ["s1"], base2.now - 600_000);
    expect(autoResumeAllowed({ ...base2, state: seen, idleMs: 30_000 }).why).toMatch(
      /can still be marked/,
    );
    expect(autoResumeAllowed({ ...base2, state: seen, idleMs: 300_000 }).resume).toBe(true);
  });
  const base = {
    verdict: "unfinished" as const,
    background: false,
    enabled: true,
    running: false,
    now: 1_000_000_000,
  };
  const live = (id: string) => noteLive(emptyAutoResumeState, [id], base.now - 600_000);
  it("resumes an unfinished session and says it was restarted", () => {
    expect(autoResumeAllowed({ ...base, state: live("s1"), sessionId: "s1" }).resume).toBe(true);
    expect(RESTART_NOTICE).toMatch(/restarted after your process stopped/);
  });
  it("never when it is off, finished, a background run, already live, or he stopped it on purpose", () => {
    const stopped = markStoppedOnPurpose(live("s1"), "s1");
    for (const input of [
      { ...base, enabled: false },
      { ...base, verdict: "finished" as const },
      { ...base, verdict: "unknown" as const },
      { ...base, background: true },
      { ...base, running: true },
    ])
      expect(autoResumeAllowed({ ...input, state: live("s1"), sessionId: "s1" }).resume).toBe(
        false,
      );
    expect(autoResumeAllowed({ ...base, state: stopped, sessionId: "s1" }).resume).toBe(false);
  });
  it("at most three times an hour for one session", () => {
    let state = live("s1");
    state = noteLive(state, ["other"], base.now - 600_000);
    for (let i = 0; i < 3; i += 1) state = recordAutoResume(state, "s1", base.now + i * 1000);
    // The watch reports a capped session as failed, keyed on this flag rather than on the wording.
    expect(
      autoResumeAllowed({ ...base, now: base.now + 5000, state, sessionId: "s1" }),
    ).toMatchObject({ resume: false, capped: true });
    expect(
      autoResumeAllowed({ ...base, now: base.now + 5000, state, sessionId: "other" }).resume,
    ).toBe(true);
    expect(
      autoResumeAllowed({ ...base, now: base.now + 3_700_000, state, sessionId: "s1" }).resume,
    ).toBe(true);
  });
});

describe("a death already reported", () => {
  it("is new again once the session has run since it was noted", () => {
    const at = Date.parse("2026-11-07T10:00:00.000Z");
    expect(diedAgain(undefined, "2026-11-07T11:00:00.000Z")).toBe(false);
    expect(diedAgain({ at }, "2026-11-07T09:59:00.000Z")).toBe(false);
    expect(diedAgain({ at }, "2026-11-07T10:30:00.000Z")).toBe(true);
  });
});
