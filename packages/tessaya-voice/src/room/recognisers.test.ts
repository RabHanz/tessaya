import { expect, it } from "vite-plus/test";

import {
  hedge,
  noteTime,
  pickRecogniser,
  recognisersFor,
  STALE_MS,
  turnAcross,
  type TurnOn,
} from "./recognisers.ts";

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
        why: () => (failed ? "busy: 16 connections open" : null),
      },
    };
  };
  const order = ["busy", "spare"];
  const turn = turnAcross(
    (tried) => {
      const url = order.find((u) => !tried.has(u));
      return url === undefined ? null : on(url, url === "busy");
    },
    (url, _ms, failed, next, why) =>
      log.push(`${url} ${failed ? `failed (${why}), next ${next}` : "ok"}`),
    () => 0,
  );
  turn.feed(new Int16Array(100));
  turn.feed(new Int16Array(60));
  expect(turn.by?.()).toBeNull();
  expect(await turn.finish()).toBe("heard 160 samples");
  // The recogniser's own reason reaches the log (18 Nov: four first tries "failed" with none).
  expect(log).toEqual(["busy failed (busy: 16 connections open), next spare", "spare ok"]);
  // The metrics name the one whose words were taken, not the one it started on.
  expect(turn.by?.()).toEqual({ host: "spare" });
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

it("gives his personal model only his held voice, and the general one everyone else or when it is down", () => {
  const general = { url: "general", queue: 0, recent: [] };
  const personal = { url: "personal", queue: 0, recent: [], personal: true };
  const urls = (states: ReadonlyArray<{ readonly url: string }>) => states.map((s) => s.url);
  expect(urls(recognisersFor([general, personal], true))).toEqual(["personal"]);
  expect(urls(recognisersFor([general, personal], false))).toEqual(["general"]);
  expect(urls(recognisersFor([general, { ...personal, queue: null }], true))).toEqual(["general"]);
  // Tried and failed (left out of the pool): the general one hears it all.
  expect(urls(recognisersFor([general], true))).toEqual(["general"]);
});

it("hears his turn on his personal model and a general one at once, and takes the general words when his are late (23:30, 17 Nov)", async () => {
  const after = (text: string) => {
    let answer: (t: string) => void = () => undefined;
    const fed: number[] = [];
    return {
      fed,
      answer: () => answer(text),
      turn: {
        feed: (pcm: Int16Array) => void fed.push(pcm.length),
        finish: () => new Promise<string>((r) => (answer = r)),
        cancel: () => undefined,
        by: () => ({ host: text === "Kazi said" ? "mine:1" : "theirs:1" }),
      },
    };
  };
  // Who answers, in order ("budget": its timer fires); one left out never answers.
  const run = async (
    order: ReadonlyArray<"personal" | "general" | "budget">,
    personalText = "Kazi said",
  ) => {
    const mine = after(personalText);
    const theirs = after("Causey said");
    let budget: () => void = () => undefined;
    const won: string[] = [];
    const turn = hedge(
      mine.turn,
      theirs.turn,
      () => new Promise<void>((r) => (budget = r)),
      (who) => won.push(who),
    );
    turn.feed(new Int16Array(160));
    const text = turn.finish();
    for (const step of order) {
      if (step === "budget") budget();
      else (step === "personal" ? mine : theirs).answer();
    }
    return { text: await text, won, fed: [mine.fed, theirs.fed], by: turn.by?.() };
  };
  // His model inside the budget: its words, though the general one answered first.
  expect(await run(["general", "personal"])).toEqual({
    text: "Kazi said",
    won: ["personal"],
    fed: [[160], [160]],
    by: { host: "mine:1", hedge: "personal" },
  });
  // Over the budget (5336 ms that turn): the general words, as soon as they are there.
  expect(await run(["budget", "general"])).toMatchObject({
    text: "Causey said",
    won: ["general"],
    by: { host: "theirs:1", hedge: "general" },
  });
  // Over the budget with the general one slower still: whichever answers first.
  expect((await run(["budget", "personal"])).won).toEqual(["personal"]);
  // His model heard nothing (or failed): the general words, without waiting out the budget.
  expect(await run(["personal", "general"], "")).toMatchObject({
    text: "Causey said",
    won: ["general"],
  });
});
