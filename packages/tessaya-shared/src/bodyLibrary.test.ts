import { describe, expect, it } from "vite-plus/test";

import { decodeBodyMove } from "./bodyControl.ts";
import { recall, type MotionEntry } from "./bodyLibrary.ts";
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

describe("an intent on a move", () => {
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
