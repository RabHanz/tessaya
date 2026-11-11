import { expect, it } from "vite-plus/test";

import { noteTime, pickRecogniser } from "./recognisers.ts";

it("sends the turn to the recogniser answering fastest lately, skipping busy and silent ones", () => {
  const near = { url: "near", queue: 0, recentMs: [1400, 1300, 6000] };
  const far = { url: "far", queue: 0, recentMs: [600, 700] };
  expect(pickRecogniser([near, far])?.url).toBe("far");
  expect(pickRecogniser([near, { ...far, queue: 2 }])?.url).toBe("near");
  expect(pickRecogniser([near, { ...far, queue: null }])?.url).toBe("near");
  // Nothing measured yet: the first in his list.
  expect(
    pickRecogniser([
      { ...near, recentMs: [] },
      { ...far, recentMs: [] },
    ])?.url,
  ).toBe("near");
  // None answering: still try one rather than none.
  expect(pickRecogniser([{ ...near, queue: null }])?.url).toBe("near");
  expect(noteTime([1, 2, 3, 4, 5], 6)).toEqual([2, 3, 4, 5, 6]);
});
