import { describe, expect, it } from "vite-plus/test";

import { bodyPlaceOf, privateBodyBounds, readBodyAsk, shapeOnScreen } from "./desktopMascot.ts";

// a 1920×1080 screen with a 48 px taskbar along the bottom
const work = { x: 0, y: 0, width: 1920, height: 1032 };

describe("her private body on the desk", () => {
  it("stands full height at her size's share of the screen, bottom-right above the taskbar, not in the mascot's box", () => {
    expect(privateBodyBounds(work, "medium")).toEqual({ x: 1432, y: 568, width: 464, height: 464 });
    expect(privateBodyBounds(work, "huge").height).toBe(774);
  });

  it("goes back where he left her on that display, at his height, and never off it", () => {
    const moved = { x: 300, y: 200, width: 600, height: 600 };
    expect(privateBodyBounds(work, "medium", bodyPlaceOf(work, moved))).toEqual(moved);
    // a new size keeps where he put her and takes the size's height
    expect(privateBodyBounds(work, "small", { right: 1320, bottom: 232 })).toMatchObject({
      height: 310,
      x: 290,
    });
    // a place from a bigger screen is pulled onto this one
    expect(privateBodyBounds(work, "medium", { right: 5000, bottom: -40, height: 3000 })).toEqual({
      x: 0,
      y: 0,
      width: 1032,
      height: 1032,
    });
  });

  it("shapes her window in the screen's pixels, so at 175% her legs and feet are inside it", () => {
    // her page on his laptop: 267 × 534 CSS px in a 468 × 934 px window
    const page = [{ x: 40, y: 20, width: 190, height: 510 }];
    expect(shapeOnScreen(page, 1.75)).toEqual([{ x: 70, y: 35, width: 333, height: 893 }]);
    expect(shapeOnScreen(page, 1)).toEqual(page);
  });

  it("hears only her page's own asks in its title", () => {
    expect(readBodyAsk('tessaya-body:{"shape":[[10.4,20,100,300]]}')).toEqual({
      shape: [{ x: 10, y: 20, width: 100, height: 300 }],
    });
    expect(readBodyAsk('tessaya-body:{"move":[5,-3]}')).toEqual({ move: [5, -3] });
    expect(readBodyAsk('tessaya-body:{"shown":false,"n":3}')).toEqual({ shown: false });
    expect(readBodyAsk('tessaya-body:{"grow":40}')).toEqual({ grow: 40 });
    expect(readBodyAsk('tessaya-body:{"done":true}')).toEqual({ done: true });
    expect(readBodyAsk("Tessaya")).toBeNull();
    expect(readBodyAsk('tessaya-body:{"move":[1e9,0]}')).toBeNull();
    expect(readBodyAsk("tessaya-body:{nope")).toBeNull();
  });
});
