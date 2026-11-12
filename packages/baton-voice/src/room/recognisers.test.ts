import { expect, it } from "vite-plus/test";

import { noteTime, pickRecogniser, STALE_MS, turnAcross, type TurnOn } from "./recognisers.ts";

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

it("hears a turn on the next recogniser, all of it, when the first turns it away", async () => {
  const heard: Record<string, number> = {};
  const log: string[] = [];
  const on = (url: string, refuses: boolean): TurnOn => {
    let failed = false;
    return {
      url,
      turn: {
        feed: (pcm) => void (heard[url] = (heard[url] ?? 0) + pcm.length),
        finish: async () => {
          failed = refuses;
          return refuses ? "" : `heard ${heard[url]} samples`;
        },
        cancel: () => undefined,
        failed: () => failed,
      },
    };
  };
  const order = ["busy", "spare"];
  const turn = turnAcross(
    (tried) => {
      const url = order.find((u) => !tried.has(u));
      return url === undefined ? null : on(url, url === "busy");
    },
    (url, _ms, failed, next) => log.push(`${url} ${failed ? `failed, next ${next}` : "ok"}`),
    () => 0,
  );
  turn.feed(new Int16Array(100));
  turn.feed(new Int16Array(60));
  expect(await turn.finish()).toBe("heard 160 samples");
  expect(log).toEqual(["busy failed, next spare", "spare ok"]);
});

it("gives his only recogniser one more go with the whole turn when it drops the stream (01:39, 13 Nov)", async () => {
  let tries = 0;
  const log: string[] = [];
  const turn = turnAcross(
    (tried) => {
      if (tried.has("voice-host")) return null;
      const attempt = (tries += 1);
      let samples = 0;
      let failed = false;
      return {
        url: "voice-host",
        turn: {
          feed: (pcm) => void (samples += pcm.length),
          finish: async () => {
            failed = attempt === 1;
            return failed ? "" : `heard ${samples} samples`;
          },
          cancel: () => undefined,
          failed: () => failed,
        },
      };
    },
    (url, _ms, failed, next) => log.push(`${url} ${failed ? `failed, next ${next}` : "ok"}`),
    () => 0,
  );
  turn.feed(new Int16Array(100));
  turn.feed(new Int16Array(60));
  expect(await turn.finish()).toBe("heard 160 samples");
  expect(log).toEqual(["voice-host failed, next voice-host", "voice-host ok"]);
});
