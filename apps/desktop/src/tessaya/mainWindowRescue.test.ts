import { describe, expect, it } from "vite-plus/test";

import { rescuedPosition } from "./mainWindowRescue.ts";

const home = { x: 0, y: 0, width: 1920, height: 1040 };
const size = { width: 1000, height: 700 };

describe("a window he cannot see", () => {
  it("is left alone when a display shows it", () => {
    expect(rescuedPosition({ ...size, x: 100, y: 100 }, [home], home)).toBeNull();
  });

  it("is left alone when only an edge is off the display", () => {
    expect(rescuedPosition({ ...size, x: 1500, y: 100 }, [home], home)).toBeNull();
  });

  it("comes back to the middle when its monitor has gone", () => {
    expect(rescuedPosition({ ...size, x: 3000, y: 100 }, [home], home)).toEqual({
      x: 460,
      y: 170,
    });
  });

  it("comes back when a sliver too thin to grab is all that shows", () => {
    expect(rescuedPosition({ ...size, x: 1900, y: 100 }, [home], home)).not.toBeNull();
  });

  it("counts a second monitor, at negative coordinates too", () => {
    const left = { x: -1920, y: 0, width: 1920, height: 1040 };
    expect(rescuedPosition({ ...size, x: -1500, y: 50 }, [home, left], home)).toBeNull();
  });
});
