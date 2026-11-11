import { expect, it } from "vite-plus/test";

import { noteTime, pickRecogniser, STALE_MS } from "./recognisers.ts";

const at = (...ms: number[]) => ms.map((m) => ({ ms: m, at: 0 }));

it("sends the turn to the recogniser answering fastest lately, skipping busy and silent ones", () => {
  const near = { url: "near", queue: 0, recent: at(1400, 1300, 6000) };
  const far = { url: "far", queue: 0, recent: at(600, 700) };
  expect(pickRecogniser([near, far], 0)?.url).toBe("far");
  expect(pickRecogniser([near, { ...far, queue: 2 }], 0)?.url).toBe("near");
  expect(pickRecogniser([near, { ...far, queue: null }], 0)?.url).toBe("near");
  // Nothing measured yet: the first in his list.
  expect(
    pickRecogniser(
      [
        { ...near, recent: [] },
        { ...far, recent: [] },
      ],
      0,
    )?.url,
  ).toBe("near");
  // None answering: still try one rather than none.
  expect(pickRecogniser([{ ...near, queue: null }], 0)?.url).toBe("near");
  expect(noteTime(at(1, 2, 3, 4, 5), 6, 9)).toEqual([...at(2, 3, 4, 5), { ms: 6, at: 9 }]);
});

it("tries a recogniser again once its slow turns are a minute old, instead of never", () => {
  const slowOnce = { url: "near", queue: 0, recent: at(15_000, 12_000) };
  const fast = { url: "far", queue: 0, recent: [{ ms: 2_000, at: STALE_MS }] };
  expect(pickRecogniser([slowOnce, fast], STALE_MS - 1)?.url).toBe("far");
  expect(pickRecogniser([slowOnce, fast], STALE_MS + 1)?.url).toBe("near");
});
