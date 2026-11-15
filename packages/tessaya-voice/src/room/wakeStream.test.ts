// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import { createOpenWakeWordScorer } from "../providers/onnx.ts";
import { createWakeStream, type WakeScorer } from "./wakeStream.ts";

const frame = (v: number) => {
  const pcm = new Int16Array(960).fill(v);
  return new Uint8Array(pcm.buffer);
};

/** Scores "Tessaya" 1.0 on a chunk carrying the marker value 7, else 0. */
const rig = (
  heard: string | ReadonlyArray<string> | (() => string),
  now?: () => number,
  kwsWake?: ReadonlyArray<{ word: string; threshold: number }>,
) => {
  const confirmed: number[] = [];
  const woken: string[] = [];
  const lines: string[] = [];
  const stream = createWakeStream({
    words: [
      { word: "Tessaya", threshold: 0.99 },
      { word: "Alfred", threshold: 0.95 },
    ],
    scorer: async (): Promise<WakeScorer> => ({
      chunkSamples: 1280,
      reset: () => undefined,
      score: async (chunk) => [chunk.includes(7) ? 0.995 : 0, 0],
    }),
    confirm: async (pcm) => {
      confirmed.push(pcm.length);
      const said = typeof heard === "function" ? heard() : heard;
      return typeof said === "string" ? [said] : said;
    },
    onWake: (id, word) => woken.push(`${id} ${word}`),
    log: (line) => lines.push(line),
    ...(now === undefined ? {} : { now }),
    ...(kwsWake === undefined ? {} : { kwsWake }),
  });
  return { stream, confirmed, woken, lines };
};

describe("waking her by name with no session open", () => {
  it("wakes on a confirmed name once per segment, and hears nothing else of it", async () => {
    // The clip ends where the model fired, just after the name.
    const t = rig("Hey Tessaya.");
    for (let i = 0; i < 5; i += 1) t.stream.frame("r1", frame(1));
    t.stream.frame("r1", frame(7));
    t.stream.frame("r1", frame(7));
    t.stream.frame("r1", frame(7));
    await t.stream.drained("r1");
    expect(t.woken).toEqual(["r1 Tessaya"]);
    expect(t.confirmed.length).toBe(1);
    // The confirm hears at most the 2 s before the fire.
    expect(t.confirmed[0]).toBeLessThanOrEqual(32_000);
    t.stream.end("r1");
    t.stream.frame("r1", frame(7));
    t.stream.frame("r1", frame(7));
    await t.stream.drained("r1");
    expect(t.woken).toEqual(["r1 Tessaya", "r1 Tessaya"]);
  });

  it("on a Tessel that sends its own kws, its pass decides her name on the whole segment and openWakeWord only logs (W2, 15 Nov)", async () => {
    let heard = "Hey Tessaya.";
    const t = rig(() => heard, undefined, [{ word: "Tessaya", threshold: 0.9 }]);
    const segment = async (
      seg: number,
      kws: { pass: boolean; best: number; first?: number; n?: number },
      kwsFirst = false,
    ) => {
      const event = { seg, name: "tessaya", score: 0, ...kws };
      if (kwsFirst) t.stream.kws("r1", event);
      for (let i = 0; i < 4; i += 1) t.stream.frame("r1", frame(7));
      t.stream.end("r1", seg);
      if (!kwsFirst) t.stream.kws("r1", event);
      await t.stream.drained("r1");
    };
    // Before its first kws event the Tessel is woken by openWakeWord, as before.
    await segment(1, { pass: true, best: 0.95 });
    expect(t.woken).toEqual(["r1 Tessaya"]);
    // Then openWakeWord's fire alone wakes nothing; the kws pass after the end does, confirmed on the whole segment.
    await segment(2, { pass: true, best: 0.95 });
    expect(t.woken).toEqual(["r1 Tessaya", "r1 Tessaya"]);
    expect(t.confirmed.at(-1)).toBe(4 * 960);
    await segment(3, { pass: false, best: 0.2 });
    await segment(4, { pass: true, best: 0.6 });
    expect(t.woken).toHaveLength(2);
    // Sure enough to need no text, whichever of the end and the kws event comes first.
    const asked = t.confirmed.length;
    await segment(5, { pass: true, best: 0.9995 }, true);
    expect(t.woken).toHaveLength(3);
    expect(t.confirmed.length).toBe(asked);
    heard = "Testing again.";
    await segment(6, { pass: true, best: 0.95 });
    expect(t.woken).toHaveLength(3);
    expect(t.lines.join("\n")).toMatch(
      /Tessaya kws pass \(kws 0\.950\/0\.9, segment 0\.2 s\), not confirmed/,
    );
    // His real wakes (15 Nov 23:36-23:48 GMT+5): the confirm hears the 2 s up to the passing window, not the
    // whole segment, and his name then a request in one breath ("Tessaya, are you there?", #4bd9c385) wakes her.
    heard = "Tessaya, are you there?";
    await segment(7, { pass: true, best: 0.95, first: 5, n: 1 });
    expect(t.woken).toHaveLength(4);
    expect(t.confirmed.at(-1)).toBe(6 * 320);
    heard = "So I said, Tessaya.";
    // The last scored window passed: 15 frames on per window, and never past the segment's end.
    await segment(8, { pass: true, best: 0.95, first: 0, n: 2 });
    expect(t.woken).toHaveLength(5);
    expect(t.confirmed.at(-1)).toBe(4 * 960);
    // A name only in the middle is still not hers.
    heard = "I told Tessaya about it.";
    await segment(9, { pass: true, best: 0.95 });
    expect(t.woken).toHaveLength(5);
  });

  it("hears the next segment when the one that woke her never ended (15 Nov soak: every other name opened nothing)", async () => {
    let t0 = 0;
    const t = rig("Hey Tessaya.", () => t0);
    for (let i = 0; i < 3; i += 1) t.stream.frame("r1", frame(7));
    await t.stream.drained("r1");
    // Her session starts mid-segment, so the R1 sends no voice/wake/end for it; the next name comes after the session.
    t0 = 20_000;
    t.stream.kws("r1", { seg: 4, score: 0.99, pass: true, name: "tessaya" });
    for (let i = 0; i < 3; i += 1) t.stream.frame("r1", frame(7));
    t.stream.end("r1", 4);
    await t.stream.drained("r1");
    expect(t.woken).toEqual(["r1 Tessaya", "r1 Tessaya"]);
    expect(t.lines.filter((l) => /\] woken by/.test(l))).toHaveLength(2);
  });

  it("a Wi-Fi stall over 3 s mid-segment splits it, and a name after the stall still wakes her once", async () => {
    let t0 = 0;
    const t = rig("Hey Tessaya.", () => t0);
    for (let i = 0; i < 5; i += 1) t.stream.frame("r1", frame(1));
    // The stalled frames arrive late, in a burst: the gap is measured on arrival.
    t0 = 8_000;
    for (let i = 0; i < 3; i += 1) t.stream.frame("r1", frame(7));
    t.stream.end("r1", 5);
    await t.stream.drained("r1");
    expect(t.woken).toEqual(["r1 Tessaya"]);
  });

  it("hears a newly trained word from the next segment, never by swapping mid-segment", async () => {
    const t = rig("Hey Nova.");
    t.stream.frame("r1", frame(1));
    await t.stream.drained("r1");
    t.stream.reload([{ word: "Nova", threshold: 0.9 }], async () => ({
      chunkSamples: 1280,
      reset: () => undefined,
      score: async (chunk) => [chunk.includes(9) ? 0.95 : 0],
    }));
    // The segment that was open keeps the old words: Nova's marker wakes nothing yet.
    for (let i = 0; i < 3; i += 1) t.stream.frame("r1", frame(9));
    await t.stream.drained("r1");
    expect(t.woken).toEqual([]);
    t.stream.end("r1");
    for (let i = 0; i < 3; i += 1) t.stream.frame("r1", frame(9));
    await t.stream.drained("r1");
    expect(t.woken).toEqual(["r1 Nova"]);
  });

  it("logs the R1's own wake model beside stage 2 for the same segment, whichever comes first", async () => {
    const t = rig("Hey Tessaya.");
    const kws = { score: 0.91, pass: true, name: "tessaya", best: 0.91, ms: 12, n: 40 };
    // The R1's verdict first, then the segment ends.
    t.stream.kws("r1", { seg: 4, ...kws });
    for (let i = 0; i < 3; i += 1) t.stream.frame("r1", frame(7));
    t.stream.end("r1", 4);
    await t.stream.drained("r1");
    expect(t.lines.at(-1)).toMatch(
      /^\[r1\] seg 4 kws tessaya 0\.910 pass .*; stage 2: woken by Tessaya/,
    );
    // Our end first, then the R1's verdict, on a segment that did not fire here.
    t.stream.frame("r1", frame(1));
    t.stream.end("r1", 5);
    await t.stream.drained("r1");
    t.stream.kws("r1", { seg: 5, ...kws, pass: false, score: 0.2 });
    expect(t.lines.at(-1)).toMatch(
      /seg 5 kws tessaya 0\.200 no pass .*stage 2: no fire, best Tessaya 0\.000/,
    );
  });

  it("never sends room speech to the recogniser, and drops a fire the text does not back", async () => {
    const quiet = rig("unused");
    for (let i = 0; i < 40; i += 1) quiet.stream.frame("r1", frame(1));
    await quiet.stream.drained("r1");
    expect(quiet.confirmed).toEqual([]);
    const tv = rig("Testing again once more.");
    for (let i = 0; i < 4; i += 1) tv.stream.frame("r1", frame(7));
    await tv.stream.drained("r1");
    expect(tv.woken).toEqual([]);
  });

  it("wakes when any recogniser hears the name: his personal one heard names the general one left empty (15 Nov)", async () => {
    const personal = rig(["", "Tessaya."]);
    for (let i = 0; i < 4; i += 1) personal.stream.frame("r1", frame(7));
    await personal.stream.drained("r1");
    expect(personal.woken).toEqual(["r1 Tessaya"]);
    const neither = rig(["", "Testing again."]);
    for (let i = 0; i < 4; i += 1) neither.stream.frame("r1", frame(7));
    await neither.stream.drained("r1");
    expect(neither.woken).toEqual([]);
  });

  it("hears his name in a segment shorter than the model's 1.28 s of context (01:41, 13 Nov)", async () => {
    const woken: string[] = [];
    // Like openWakeWord: nothing until 16 chunks since the last reset, then 1.0 on the name.
    let seen = 0;
    const stream = createWakeStream({
      words: [{ word: "Tessaya", threshold: 0.99 }],
      scorer: async (): Promise<WakeScorer> => ({
        chunkSamples: 1280,
        reset: () => {
          seen = 0;
        },
        score: async (chunk) => [(seen += 1) >= 16 && chunk.includes(7) ? 1 : 0],
      }),
      confirm: async () => ["Tessaya."],
      onWake: (id, word) => woken.push(`${id} ${word}`),
      log: () => undefined,
    });
    // 1.0 s: 300 ms before, the name, then quiet; as 0.3.36 sends it.
    for (let i = 0; i < 5; i += 1) stream.frame("r1", frame(1));
    for (let i = 0; i < 6; i += 1) stream.frame("r1", frame(7));
    for (let i = 0; i < 6; i += 1) stream.frame("r1", frame(1));
    stream.end("r1");
    await stream.drained("r1");
    expect(woken).toEqual(["r1 Tessaya"]);
  });
});

describe("her name through the loop's own wake path, with the real models", () => {
  const models = new URL("../../../../native/baton-dictation/models/", import.meta.url);
  const model = (file: string) => new URL(file, models).pathname;
  /** The voice/wake segment the R1 sent at 09:44:59, 13 Nov, captured at the broker (her name, 2.3 s). */
  const segment = NodeFS.readFileSync(
    new URL("../../test/fixtures/r1-wake-tessaya.pcm", import.meta.url),
  );
  const words = [{ word: "Tessaya", threshold: 0.99 }];

  it("wakes on the R1's real segment, sent as its 60 ms frames, and again on the next segment", async () => {
    const woken: string[] = [];
    const logs: string[] = [];
    const stream = createWakeStream({
      words,
      scorer: () =>
        createOpenWakeWordScorer({
          melspectrogram: model("melspectrogram.onnx"),
          embedding: model("embedding_model.onnx"),
          wakes: [{ word: "Tessaya", path: model("tessaya.onnx"), threshold: 0.99 }],
        }),
      confirm: async () => ["Tessaya"],
      onWake: (id, word) => woken.push(`${id} ${word}`),
      log: (l) => logs.push(l),
    });
    for (const round of [1, 2]) {
      for (let at = 0; at < segment.length; at += 1920)
        stream.frame("r1-a", segment.subarray(at, at + 1920));
      stream.end("r1-a");
      await stream.drained("r1-a");
      expect(woken).toHaveLength(round);
    }
    expect(logs[0]).toMatch(/woken by Tessaya \((1\.000|0\.99\d)\/0\.99 after /);
  });
});
