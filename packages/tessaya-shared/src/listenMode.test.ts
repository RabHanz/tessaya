import { describe, expect, it } from "vite-plus/test";

import {
  LISTEN_LIMIT_MS,
  classifyListen,
  listenPhrases,
  listenStep,
  listenWaitMs,
  type ListenState,
} from "./listenMode.ts";

const idle = { listening: false, names: ["Freya"] } as const;
const on = { listening: true } as const;

describe("listen mode's words", () => {
  it("starts only when the line opens with a start phrase, and keeps what follows a mark", () => {
    expect(
      [
        "Just listen.",
        "Freya, just listen for a bit.",
        "Okay, let me think out loud",
        "Bear with me.",
        "Just listen. So I've been thinking about the garden.",
        "You never just listen to me.",
        "Just listen to this song.",
        "Let me think out loud about why it failed",
      ].map((t) => classifyListen(t, idle)),
    ).toEqual([
      { kind: "start", text: "" },
      { kind: "start", text: "" },
      { kind: "start", text: "" },
      { kind: "start", text: "" },
      { kind: "start", text: "So I've been thinking about the garden." },
      { kind: "none" },
      { kind: "none" },
      { kind: "none" },
    ]);
  });

  it("ends on a phrase that closes the line, keeping the words before it", () => {
    expect(
      [
        "So that's the idea. Over to you.",
        "and the roof should be green, okay over to you",
        "That's it.",
        "That's it for the roof, now the walls",
        "What do you think?",
        "I wonder what you think of it",
      ].map((t) => classifyListen(t, on)),
    ).toEqual([
      { kind: "end", text: "So that's the idea." },
      { kind: "end", text: "and the roof should be green" },
      { kind: "end", text: "" },
      { kind: "text", text: "That's it for the roof, now the walls" },
      { kind: "end", text: "" },
      { kind: "text", text: "I wonder what you think of it" },
    ]);
  });

  it("takes his own phrases, and a cancel drops the thought", () => {
    expect(
      classifyListen("Done thinking.", { ...on, ends: listenPhrases("done thinking; your go") }),
    ).toEqual({ kind: "end", text: "" });
    expect(classifyListen("Brain dump time", { ...idle, starts: ["brain dump time"] })).toEqual({
      kind: "start",
      text: "",
    });
    expect(classifyListen("Never mind.", on)).toEqual({ kind: "cancel" });
    expect(classifyListen("Dismissed.", on)).toEqual({ kind: "cancel" });
    // "Hold on" stops her when she speaks; mid-thought it is his words.
    expect(classifyListen("Hold on, the other way round.", on).kind).toBe("text");
  });

  it("reads his silence setting within 5 s and 2 min", () => {
    expect(
      ["", "30", "30 seconds", "a minute", "2 min", "1", "600", "soon"].map(listenWaitMs),
    ).toEqual([20_000, 30_000, 30_000, 60_000, 120_000, 5_000, 120_000, 20_000]);
  });
});

describe("listen mode's steps", () => {
  const config = { waitMs: 20_000 };
  const run = (events: ReadonlyArray<Parameters<typeof listenStep>[1]>) => {
    let state: ListenState | null = null;
    return events.map((e) => {
      const step = listenStep(state, e, config);
      state = step.state;
      return step.out;
    });
  };

  it("keeps every line through long pauses and answers once, on the end phrase", () => {
    const outs = run([
      { type: "utterance", text: "Just listen.", at: 0 },
      { type: "utterance", text: "I want a planner for the garden.", at: 5_000 },
      { type: "tick", at: 20_000 },
      { type: "utterance", text: "It should know the seasons here.", at: 24_000 },
      { type: "tick", at: 43_000 },
      { type: "utterance", text: "And remind me to water. Over to you.", at: 60_000 },
    ]);
    expect(outs.map((o) => o.kind)).toEqual(["started", "ack", "pass", "ack", "pass", "done"]);
    const done = outs.at(-1)!;
    expect(done.kind === "done" && done.why).toBe("end");
    expect(done.kind === "done" && done.text).toMatch(
      /only listen[\s\S]*I want a planner for the garden\. It should know the seasons here\. And remind me to water\.$/,
    );
  });

  it("ends after his silence, drops an empty thought, and never runs past the limit", () => {
    expect(
      run([
        { type: "start", at: 0, text: "First thought." },
        { type: "tick", at: 19_999 },
        { type: "tick", at: 20_000 },
      ]).map((o) => (o.kind === "done" ? o.why : o.kind)),
    ).toEqual(["started", "pass", "silence"]);
    expect(
      run([
        { type: "start", at: 0 },
        { type: "tick", at: 20_000 },
      ]).at(-1),
    ).toEqual({
      kind: "cancelled",
      lines: [],
    });
    const long = run([
      { type: "start", at: 0, text: "One." },
      { type: "utterance", text: "Two.", at: LISTEN_LIMIT_MS - 1_000 },
      { type: "utterance", text: "Three.", at: LISTEN_LIMIT_MS + 1 },
    ]);
    expect(long.at(-1)?.kind === "done" && long.at(-1)).toMatchObject({ why: "limit" });
  });

  it("a cancel ends it with the lines it drops, and nothing is listened to when it is off", () => {
    expect(
      run([
        { type: "start", at: 0, text: "An idea." },
        { type: "utterance", text: "Cancel that.", at: 1_000 },
        { type: "utterance", text: "What's the time?", at: 2_000 },
      ]),
    ).toEqual([{ kind: "started" }, { kind: "cancelled", lines: ["An idea."] }, { kind: "pass" }]);
  });
});
