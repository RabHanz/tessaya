import { describe, expect, it } from "vite-plus/test";

import { caretGeometry } from "./dictationSidecar.ts";
import { ghostPlacement } from "./pillGhost.ts";

const field = { x: 100, y: 200, width: 600, height: 300 };

describe("the ghost at the caret", () => {
  it("sits on the caret's line, wraps at the field's width and starts where the caret is", () => {
    expect(
      ghostPlacement({ caret: { x: 300, y: 240, width: 0, height: 22 }, field, fontPt: 11.25 }),
    ).toEqual({
      bounds: { x: 108, y: 240, width: 584, height: 264 },
      fontPx: 15,
      linePx: 22,
      width: 584,
      indent: 192,
    });
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
