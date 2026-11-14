// @effect-diagnostics globalDate:off
import { describe, expect, it } from "vite-plus/test";

import { makeVoiceTurnLog } from "./voiceTurnLog.ts";

const rig = () => {
  const lines: Array<Record<string, unknown>> = [];
  const log = makeVoiceTurnLog(
    (line) => lines.push(JSON.parse(line)),
    () => new Date("2026-11-01T00:00:00.000Z"),
  );
  return { lines, log };
};
const timings = {
  route: "answer",
  source: "model",
  decideMs: 900,
  firstSentenceMs: 2100,
  totalMs: 6000,
};

describe("the voice log", () => {
  it("writes one line for a turn: wake, words, route and times", () => {
    const { lines, log } = rig();
    log.event({ type: "wake", word: "Alfred", score: 0.97, at: 1, lateMs: 900, checkMs: 700 });
    log.event({ type: "transcript", text: "what time is it", at: 2 });
    log.timings(timings);
    expect(lines).toEqual([
      {
        at: "2026-11-01T00:00:00.000Z",
        kind: "turn",
        wake: { word: "Alfred", score: 0.97, lateMs: 900, checkMs: 700 },
        transcript: "what time is it",
        ...timings,
      },
    ]);
  });

  it("shows where an answered turn's time went, from his last word to her first sound", () => {
    let now = 10_000;
    const lines: Array<Record<string, unknown>> = [];
    const log = makeVoiceTurnLog(
      (line) => lines.push(JSON.parse(line)),
      () => new Date(now),
    );
    log.event({ type: "speech_end", at: 1, quietMs: 560 });
    now += 900;
    log.event({
      type: "transcript",
      text: "what time is it",
      at: 2,
      recogniseMs: 600,
      holdMs: 300,
    });
    now += 50;
    log.note("agent_turn_start", { said: "what time is it" });
    now += 1_000;
    log.note("agent_turn", { said: "what time is it", firstAudioMs: 800, totalMs: 1_100 });
    log.note("agent_turn", { said: "typed later" });
    expect(lines.slice(1)).toMatchObject([
      { kind: "agent_turn_start", endpointMs: 560, recogniseMs: 600, holdMs: 300, routeMs: 50 },
      {
        kind: "agent_turn",
        endpointMs: 560,
        // His last word at 9440; the turn began at 10850 and spoke 800 ms later.
        speechToAudioMs: 2_210,
      },
      { kind: "agent_turn" },
    ]);
    expect(lines.at(-1)).not.toHaveProperty("endpointMs");
  });

  it("records noise it dropped, a spoken stop, and a wake with nothing after it", () => {
    const { lines, log } = rig();
    log.event({ type: "wake", word: "Freya", score: 0.96, at: 1 });
    log.event({ type: "dropped", text: "Yeah.", reason: "filler" });
    log.event({ type: "stop_heard", text: "stop", at: 2 });
    log.event({ type: "state", state: "sleeping", target: null });
    expect(lines.map((line) => line["kind"])).toEqual(["dropped", "stop", "wake_only"]);
    expect(lines[0]).toMatchObject({ text: "Yeah.", reason: "filler" });
  });

  it("does not report a wake that heard nothing as a wake-only at the next wake", () => {
    const { lines, log } = rig();
    log.event({ type: "wake", word: "Freya", score: 1.05, at: 1 });
    log.event({ type: "nothing" });
    log.event({ type: "wake", word: "Alfred", score: 0.97, at: 2 });
    expect(lines.map((line) => line["kind"])).toEqual(["nothing_heard"]);
  });

  it("never writes dictated words", () => {
    const { lines, log } = rig();
    log.event({ type: "transcript", text: "the private letter", at: 1 });
    log.event({ type: "effect", effect: { kind: "dictate", text: "the private letter" } });
    log.event({ type: "outcome", outcome: { kind: "dictated", inserted: true, reply: "" } });
    expect(JSON.stringify(lines)).not.toContain("private");
    expect(lines).toEqual([{ at: "2026-11-01T00:00:00.000Z", kind: "dictated", chars: 18 }]);
  });

  it("records the reply and any refusal reason", () => {
    const { lines, log } = rig();
    log.event({ type: "transcript", text: "delete everything", at: 1 });
    log.event({
      type: "outcome",
      outcome: { kind: "refused", reply: "I won't do that.", reason: "high_risk" },
    });
    expect(lines[0]).toMatchObject({ reply: "I won't do that.", reason: "high_risk" });
  });

  it("leaves a screen turn's line to its timings", () => {
    const { lines, log } = rig();
    log.event({ type: "transcript", text: "explain this", at: 1 });
    log.event({
      type: "outcome",
      outcome: { kind: "ran", reply: "", workSessionId: null, source: "screen" },
    });
    log.timings(timings);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ kind: "turn", transcript: "explain this" });
  });

  it("does not hang an answered wake on what is dropped after it", async () => {
    const { lines, log } = rig();
    log.event({ type: "wake", word: "Freya", score: 1.05, at: 1, lateMs: 14_340, checkMs: 14_320 });
    log.event({ type: "transcript", text: "what time is it", at: 2 });
    // An agent turn: the brain answered it, with no timings line.
    log.event({
      type: "outcome",
      outcome: { kind: "ran", reply: "", workSessionId: null, source: "screen" },
    });
    log.event({ type: "dropped", text: "Freya", reason: "own voice", score: 1.05 });
    // Over her voice: the score is kept for tuning, and no wake is hung on it.
    expect(lines.at(-1)).toMatchObject({ kind: "dropped", score: 1.05 });
    expect(lines.at(-1)).not.toHaveProperty("wake");
    // A wake with nothing after it: the speech detector's view of it is kept, to tell noise from speech.
    log.event({
      type: "dropped",
      text: "",
      reason: "wake not heard",
      score: 1.052,
      vadPeak: 0.04,
      vadMean: 0.01,
    });
    expect(lines.at(-1)).toMatchObject({ reason: "wake not heard", vadPeak: 0.04, vadMean: 0.01 });
  });
});
