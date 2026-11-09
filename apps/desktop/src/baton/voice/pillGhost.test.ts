import { describe, expect, it } from "vite-plus/test";

import { caretGeometry } from "./dictationSidecar.ts";
import { ghostPlacement } from "./pillGhost.ts";
import { flowWords, ghostScroll } from "./pillIsland.ts";

const field = { x: 100, y: 200, width: 600, height: 300 };

describe("the ghost at the caret", () => {
  it("covers the field's text box, wraps at the field's width and starts where the caret is", () => {
    expect(
      ghostPlacement({ caret: { x: 300, y: 240, width: 0, height: 22 }, field, fontPt: 11.25 }),
    ).toEqual({
      bounds: { x: 108, y: 200, width: 584, height: 300 },
      fontPx: 15,
      linePx: 22,
      width: 584,
      indent: 192,
      top: 40,
      height: 300,
    });
  });
  it("leaves a one-line box or one too narrow to flow words in to the pill", () => {
    const caret = { x: 120, y: 205, width: 0, height: 22 };
    expect(ghostPlacement({ caret, field: { ...field, height: 30 }, fontPt: 11.25 })).toBeNull();
    expect(ghostPlacement({ caret, field: { ...field, width: 180 }, fontPt: 11.25 })).toBeNull();
  });
  it("flows words from the caret and wraps each at the box's width, never one word a line", () => {
    // Box 100 wide, caret 60 in: the first fits after it, the next goes to a new line, which holds three.
    expect(flowWords([20, 30, 30, 30, 120], 5, 100, 60, 20)).toEqual([
      { x: 60, y: 0, w: 20 },
      { x: 0, y: 20, w: 30 },
      { x: 35, y: 20, w: 30 },
      { x: 70, y: 20, w: 30 },
      // Wider than the box: a line of its own, as a field does.
      { x: 0, y: 40, w: 120 },
    ]);
  });
  it("scrolls by whole lines once the text passes the field's bottom, keeping the newest line in view", () => {
    // The caret's line starts 40 down a 100 tall box of 20 px lines: three lines fit.
    expect([1, 3, 4, 6].map((lines) => ghostScroll(lines, 40, 20, 100))).toEqual([0, 0, 20, 60]);
  });
  it("guesses the font from the line when the field does not say", () => {
    expect(
      ghostPlacement({ caret: { x: 108, y: 240, width: 0, height: 25 }, field, fontPt: 0 })?.fontPx,
    ).toBe(18);
  });
  it("draws nothing where it could not sit right: a tiny field, a caret outside it, no line", () => {
    const caret = { x: 300, y: 240, width: 0, height: 22 };
    expect(ghostPlacement({ caret, field: { ...field, width: 100 }, fontPt: 11 })).toBeNull();
    expect(ghostPlacement({ caret: { ...caret, x: 50 }, field, fontPt: 11 })).toBeNull();
    expect(ghostPlacement({ caret: { ...caret, height: 0 }, field, fontPt: 11 })).toBeNull();
  });
  it("reads the sidecar's caret only when it is whole: a secret field sends none", () => {
    expect(caretGeometry({ caret: null })).toBeNull();
    expect(caretGeometry({ caret: { x: 1, y: 2, width: 0, height: 20 }, field: null })).toBeNull();
    expect(
      caretGeometry({
        caret: { x: 1, y: 2, width: 0, height: 20 },
        field: { x: 0, y: 0, width: 9, height: 9 },
      }),
    ).toEqual({
      caret: { x: 1, y: 2, width: 0, height: 20 },
      field: { x: 0, y: 0, width: 9, height: 9 },
      fontPt: 0,
    });
  });
});
