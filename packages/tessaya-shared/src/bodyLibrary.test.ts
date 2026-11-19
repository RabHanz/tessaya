import { describe, expect, it } from "vite-plus/test";

import { decodeBodyMove } from "./bodyControl.ts";
import { MEANING_FLOOR, recall, recallByMeaning, type MotionEntry } from "./bodyLibrary.ts";
import { MOTION_LIBRARY } from "./bodyMotionLibrary.ts";

const lib: MotionEntry[] = [
  { id: "a", text: "Salute like a soldier.", move: { gesture: "bow" }, score: 5, source: "t" },
  { id: "b", text: "Jump for joy.", move: { act: "dance" }, score: 4, source: "t" },
  {
    id: "c",
    text: "Shiver like you're freezing.",
    move: { posture: "guarded" },
    score: 4,
    source: "t",
  },
];

describe("recall", () => {
  it("finds the entry an intent's words point to, and nothing when no word is shared", () => {
    expect(recall("give a crisp salute", lib)?.entry.id).toBe("a");
    expect(recall("jumping for joy!", lib)?.entry.id).toBe("b");
    expect(recall("read me the news", lib)).toBeNull();
    expect(recall("show me", lib)).toBeNull();
  });
});

describe("recallByMeaning", () => {
  const unit = (...v: number[]) => {
    const n = Math.hypot(...v);
    return Float32Array.from(v.map((x) => x / n));
  };
  const vectors = new Map([
    ["a", unit(1, 0, 0)],
    ["b", unit(0, 1, 0)],
    ["c", unit(0, 0, 1)],
  ]);
  it("finds an entry that shares no word when its meaning is near, and words still count", () => {
    // "I'm so cold" shares no word with "Shiver like you're freezing", but its vector is near
    expect(recallByMeaning("I'm so cold", lib, unit(0.1, 0, 1), vectors)?.id).toBe("c");
    // a far vector alone finds nothing; the words then decide
    expect(recallByMeaning("a crisp salute", lib, unit(0.4, 0.5, 0.5), vectors)?.id).toBe("a");
    expect(recallByMeaning("read me the news", lib, unit(0.5, 0.5, 0.5), vectors)).toBeNull();
    // no model: words only
    expect(recallByMeaning("jumping for joy", lib, null, vectors)?.id).toBe("b");
    expect(MEANING_FLOOR).toBeGreaterThan(0.5);
  });
});

describe("an intent on a move", () => {
  it("plays the entry the server named by id", () => {
    const entry = MOTION_LIBRARY.at(-1)!;
    expect(decodeBodyMove({ intent: entry.id })).toEqual(decodeBodyMove(entry.move));
  });

  it("plays her library's performance, under what else the step says, and says when she has none", () => {
    const d = decodeBodyMove({ intent: "zqx florp" });
    expect(d).toMatchObject({
      ok: false,
      error: expect.stringMatching(/motion library has nothing near/),
    });
    const entry = MOTION_LIBRARY[0]!;
    const played = decodeBodyMove({ intent: entry.text });
    expect(played).toEqual(decodeBodyMove(entry.move));
    // the step's own fields go over the library's
    expect(decodeBodyMove({ intent: "zqx florp", look: { x: 0, y: 0.5 } })).toMatchObject({
      ok: true,
      move: { look: { x: 0, y: 0.5 } },
    });
  });
});
