import { describe, expect, it } from "vite-plus/test";

import { decodeBodyMove, moveCues } from "./bodyControl.ts";
import { parseCue } from "./bodyCues.ts";

describe("bodyLocomotion", () => {
  it("a move turns her, walks her and aims her at someone, bounded, and the cues reach the renderer intact", () => {
    const d = decodeBodyMove({
      turn: { to: "away", ms: 99_000 },
      then: [
        { afterMs: 4000, look: { x: 0.4, y: 0 }, toward: "him" },
        { afterMs: 6000, walk: { to: { x: 0.9, y: 1.4 }, speed: 3, style: "tiptoe" } },
        { afterMs: 9000, gesture: "wave", toward: "sebastian" },
      ],
    });
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.move.turn).toEqual({ to: { kind: "away" }, ms: 4000 });
    expect(d.move.then?.[1]?.walk).toEqual({
      to: { kind: "point", x: 0.9, y: 1 },
      speed: 1,
      style: "tiptoe",
      stop: 0.2,
    });
    const cues = moveCues(d.move);
    expect(cues[0]).toEqual({ kind: "turn", to: { kind: "away" }, ms: 4000 });
    // the renderer's own parse takes what the server sends
    const seq = cues.find((c) => c.kind === "seq") as {
      steps: ReadonlyArray<{ cues: ReadonlyArray<unknown> }>;
    };
    for (const c of [cues[0], ...seq.steps.flatMap((s) => s.cues)])
      expect(parseCue(c), JSON.stringify(c)).not.toBeNull();
  });

  it("teaches what a target is, and never walks 'away'", () => {
    expect(decodeBodyMove({ walk: { to: "away" } })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/not "away"/),
    });
    expect(decodeBodyMove({ toward: { x: "left" } })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/a target is/),
    });
    expect(decodeBodyMove({ walk: { to: "him", style: "moonwalk" } })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/stroll/),
    });
  });
});
