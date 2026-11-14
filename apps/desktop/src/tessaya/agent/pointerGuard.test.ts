import { describe, expect, it } from "vite-plus/test";

import { createMouseConsent, pointerMoved } from "./pointerGuard.ts";

describe("the mouse stays his", () => {
  it("allows the first action of a turn, and one where the pointer was left", () => {
    expect(pointerMoved(null, { x: 500, y: 400 })).toBe(false);
    expect(pointerMoved({ x: 500, y: 400 }, { x: 503, y: 398 })).toBe(false);
  });
  it("stops when he has moved it", () => {
    expect(pointerMoved({ x: 500, y: 400 }, { x: 700, y: 400 })).toBe(true);
    expect(pointerMoved({ x: 500, y: 400 }, { x: 500, y: 450 })).toBe(true);
  });
});

describe("his mouse as a last resort", () => {
  it("asks before the first use in a turn, and a no stops the click", async () => {
    const answers = [false, true];
    let asked = 0;
    const mouse = createMouseConsent(async () => ((asked += 1), answers.shift() ?? false));
    await expect(mouse.need()).rejects.toThrow("said no");
    await mouse.need();
    await mouse.need();
    expect(asked).toBe(2);
    mouse.reset();
    await expect(mouse.need()).rejects.toThrow("said no");
    expect(asked).toBe(3);
  });
});
