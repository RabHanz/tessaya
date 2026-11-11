import { expect, it } from "vite-plus/test";

import { noteTime, pickRecogniser } from "./recognisers.ts";

it("sends the turn to the recogniser answering fastest lately, skipping busy and silent ones", () => {
  const onnyx = { url: "onnyx", queue: 0, recentMs: [1400, 1300, 6000] };
  const hetzner = { url: "hetzner", queue: 0, recentMs: [600, 700] };
  expect(pickRecogniser([onnyx, hetzner])?.url).toBe("hetzner");
  expect(pickRecogniser([onnyx, { ...hetzner, queue: 2 }])?.url).toBe("onnyx");
  expect(pickRecogniser([onnyx, { ...hetzner, queue: null }])?.url).toBe("onnyx");
  // Nothing measured yet: the first in his list.
  expect(
    pickRecogniser([
      { ...onnyx, recentMs: [] },
      { ...hetzner, recentMs: [] },
    ])?.url,
  ).toBe("onnyx");
  // None answering: still try one rather than none.
  expect(pickRecogniser([{ ...onnyx, queue: null }])?.url).toBe("onnyx");
  expect(noteTime([1, 2, 3, 4, 5], 6)).toEqual([2, 3, 4, 5, 6]);
});
