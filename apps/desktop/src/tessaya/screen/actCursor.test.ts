import { describe, expect, it } from "vite-plus/test";

import { actLabel, actTarget } from "./actCursor.ts";

describe("her cursor while she acts", () => {
  it("carries the control's name, Typing, or the keys, in a few words", () => {
    expect(actLabel({ kind: "click", name: "Save" })).toBe("Save");
    expect(actLabel({ kind: "click", name: "  Save   as  PDF  file " })).toBe("Save as PDF");
    expect(actLabel({ kind: "click", name: "Supercalifragilisticexpialidocious" })).toBe(
      "Supercalifragilisticexp…",
    );
    expect(actLabel({ kind: "click" })).toBe("Click");
    expect(actLabel({ kind: "click", name: "", double: true })).toBe("Double-click");
    expect(actLabel({ kind: "type" })).toBe("Typing");
    expect(actLabel({ kind: "press", keys: ["ctrl", "s"] })).toBe("Ctrl+S");
    expect(actLabel({ kind: "press", keys: ["control", "shift", "escape"] })).toBe(
      "Ctrl+Shift+Esc",
    );
    expect(actLabel({ kind: "press", keys: ["return"] })).toBe("Enter");
    expect(actLabel({ kind: "press", keys: ["f5"] })).toBe("F5");
  });

  it("goes to the control, else where she last acted, else the window's middle", () => {
    const control = { x: 1, y: 1 };
    const last = { x: 2, y: 2 };
    const window = { x: 3, y: 3 };
    expect(actTarget({ control, last, window })).toBe(control);
    expect(actTarget({ control: null, last, window })).toBe(last);
    expect(actTarget({ window })).toBe(window);
    expect(actTarget({})).toBeNull();
  });
});
