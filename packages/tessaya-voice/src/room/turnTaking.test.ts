import { describe, expect, it } from "vite-plus/test";

import { createTurnTaking, ROOM_TURN, WINDOW, type TurnAction } from "./turnTaking.ts";

const w = () => new Int16Array(WINDOW);
const run = (t: ReturnType<typeof createTurnTaking>, probs: number[], speaking = false) =>
  probs.flatMap((p) => t.feed(w(), p, speaking));
const kinds = (a: TurnAction[]) => a.map((x) => x.kind).filter((k) => k !== "audio");

describe("room turn-taking", () => {
  it("opens after 96 ms of speech with the pre-roll, asks Smart Turn at the first pause, and ends on its yes", () => {
    const t = createTurnTaking();
    expect(kinds(run(t, [0.9, 0.9]))).toEqual([]);
    const opened = run(t, [0.9]);
    expect(opened[0]).toMatchObject({ kind: "start" });
    expect((opened[0] as { pcm: Int16Array }).pcm.length).toBe(3 * WINDOW);
    const paused = run(t, [0.9, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1]);
    const check = paused.find((a) => a.kind === "check") as { id: number; pcm: Int16Array };
    expect(check).toBeDefined();
    const ended = t.verdict(check.id, 0.8);
    expect(ended).toMatchObject([{ kind: "end", reason: "complete" }]);
  });

  it("keeps listening through a thinking pause: a no, then speech again, makes the old answer stale", () => {
    const t = createTurnTaking();
    run(t, [0.9, 0.9, 0.9, 0.9]);
    const check = run(t, [0.1, 0.1, 0.1, 0.1, 0.1, 0.1]).find((a) => a.kind === "check") as {
      id: number;
    };
    expect(t.verdict(check.id, 0.2)).toEqual([]);
    run(t, [0.9]);
    expect(t.verdict(check.id, 0.9)).toEqual([]);
    expect(t.inTurn()).toBe(true);
  });

  it("ends on long silence whatever Smart Turn says", () => {
    const t = createTurnTaking();
    run(t, [0.9, 0.9, 0.9]);
    const n = Math.round(ROOM_TURN.maxSilenceMs / 32);
    expect(
      kinds(
        run(
          t,
          Array.from({ length: n }, () => 0.1),
        ),
      ),
    ).toContain("end");
  });

  it("while she speaks, needs a stronger and longer onset, and reports it as a cut-in", () => {
    const t = createTurnTaking();
    expect(kinds(run(t, [0.55, 0.55, 0.55, 0.55, 0.55, 0.55], true))).toEqual([]);
    expect(kinds(run(t, [0.8, 0.8, 0.8, 0.8, 0.8], true))).toEqual(["barge", "start"]);
  });
});
