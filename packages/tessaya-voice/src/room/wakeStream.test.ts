// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import { createOpenWakeWordScorer } from "../providers/onnx.ts";
import {
  createWakeStream,
  kwsSettingsCommand,
  parseWakeGate,
  requestAfterName,
  type WakeRequest,
  type WakeScorer,
} from "./wakeStream.ts";

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
  const requests: Array<Promise<WakeRequest | null> | undefined> = [];
  const lines: string[] = [];
  /** What each step was asked, in order: Voice ID ("voice") beside the confirms. */
  const asked: string[] = [];
  const voices: Array<Promise<unknown> | undefined> = [];
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
      asked.push(`confirm ${pcm.length}`);
      const said = typeof heard === "function" ? heard() : heard;
      return typeof said === "string" ? [said] : said;
    },
    onWake: (id, word, _level, _score, _clip, request, voice) => {
      woken.push(`${id} ${word}`);
      requests.push(request);
      voices.push(voice);
    },
    voice: async (pcm) => {
      asked.push(`voice ${pcm.length}`);
      return undefined;
    },
    log: (line) => lines.push(line),
    ...(now === undefined ? {} : { now }),
    ...(kwsWake === undefined ? {} : { kwsWake }),
  });
  return { stream, confirmed, woken, requests, lines, asked, voices };
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
    expect(t.lines.join("\n")).toMatch(/seg 4 kws 0\.600 under the loop's 0\.9; not a wake/);
    // Sure enough to need no confirm, whichever of the end and the kws event comes first: only the whole segment is
    // recognised, for a request after her name.
    const asked = t.confirmed.length;
    await segment(5, { pass: true, best: 0.9995 }, true);
    expect(t.woken).toHaveLength(3);
    expect(t.confirmed.length).toBe(asked + 1);
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

  it.each([
    // The one-breath requests the recogniser wrote from his Tessel (13-16 Nov).
    [["Tessaya, what time is it?"], "what time is it?"],
    [["Tessaya, are you there?"], "are you there?"],
    [["Hey Tessaya, turn on the fan."], "turn on the fan."],
    [["", "Tessaya, what's the weather like?"], "what's the weather like?"],
    // The room's general then personal recogniser on the 22 one-breath bench clips (16 Nov): her name's "T" goes soft.
    [
      ["Eseya, what's on my calendar tomorrow?", "Esseya, what's on my calendar tomorrow?"],
      "what's on my calendar tomorrow?",
    ],
    [["Isaya, you there?", "Essaya, you there?"], "you there?"],
    [
      ["Esaya, how many days until Christmas?", "Esia, how many days until Christmas?"],
      "how many days until Christmas?",
    ],
    [
      ["Esia, what's the capital of Portugal?", "Esseia, what's the capital of Portugal?"],
      "what's the capital of Portugal?",
    ],
    [
      [
        "Essay yeah, give me a quick tip for sleeping better.",
        "Essaya, give me a quick tip for sleeping better.",
      ],
      "give me a quick tip for sleeping better.",
    ],
    [["", "Esseia, are you there?"], "are you there?"],
    // The near misses as the same recognisers wrote them stay names of their own.
    [["Vanessa, what time is it?"], null],
    [["Odessa, what time is it?"], null],
    [["Teresa, what time is it?"], null],
    [["Messiah, what time is it?"], null],
    [["Isaiah, what time is it?"], null],
    [["Necessary, what time is it?"], null],
    [["Tess, hi."], null],
    [["Tessaya."], null],
    [["Tessaya, um."], null],
    [["I told Tessaya about it."], null],
  ])("finds the request after her name in %j", (texts, request) => {
    expect(requestAfterName(texts, "Tessaya")).toBe(request);
  });

  it("an early kws pass starts the confirm mid-segment, and the request after her name goes with the wake (16 Nov)", async () => {
    let t0 = 10_000;
    const t = rig(["Tessaya, what time is it?"], () => t0, [{ word: "Tessaya", threshold: 0.9 }]);
    for (let i = 0; i < 20; i += 1) t.stream.frame("r1", frame(1));
    // The first window over 0.9 ends at feature frame 50 (1.0 s): sent then, with the rest of his request to come.
    t.stream.kws("r1", {
      seg: 9,
      name: "tessaya",
      pass: true,
      best: 0.95,
      first: 50,
      n: 1,
      early: true,
    });
    await t.stream.drained("r1");
    expect(t.confirmed).toEqual([51 * 320]);
    for (let i = 0; i < 30; i += 1) t.stream.frame("r1", frame(1));
    t0 = 13_000;
    t.stream.end("r1", 9, 50);
    await t.stream.drained("r1");
    expect(t.woken).toEqual(["r1 Tessaya"]);
    // One more read, of the whole segment; the clip's confirm is not asked again.
    expect(t.confirmed).toEqual([51 * 320, 50 * 960]);
    // Voice ID on the whole segment begins as it ends, before its recognition, and goes with the wake.
    expect(t.asked).toEqual([`confirm ${51 * 320}`, `voice ${50 * 960}`, `confirm ${50 * 960}`]);
    expect(t.voices[0]).toBeInstanceOf(Promise);
    expect(await t.requests[0]).toEqual({
      text: "what time is it?",
      startedAt: 10_000,
      endedAt: 12_520,
    });
  });

  it("on a Tessel whose kws scorer is ready, openWakeWord never wakes her, even before its first kws event (01:18, 16 Nov)", async () => {
    const t = createWakeStream({
      words: [{ word: "Tessaya", threshold: 0.99 }],
      scorer: async (): Promise<WakeScorer> => ({
        chunkSamples: 1280,
        reset: () => undefined,
        score: async (chunk) => [chunk.includes(7) ? 0.995 : 0],
      }),
      confirm: async () => ["Tessaya, what time is it?"],
      onWake: () => woken.push("woken"),
      log: () => undefined,
      kwsWake: [{ word: "Tessaya", threshold: 0.9 }],
      kwsReady: () => true,
    });
    const woken: string[] = [];
    for (let i = 0; i < 4; i += 1) t.frame("r1", frame(7));
    await t.drained("r1");
    expect(woken).toEqual([]);
    t.end("r1", 1, 4);
    t.kws("r1", { seg: 1, name: "tessaya", pass: true, best: 0.95 });
    await t.drained("r1");
    expect(woken).toEqual(["woken"]);
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

  it("keeps a whole segment over a stall once the Tessel counts its frames (16 Nov: 2.5 s heard as 0.1-0.4 s)", async () => {
    let t0 = 0;
    const t = rig("Tessaya, what time is it?", () => t0, [{ word: "Tessaya", threshold: 0.9 }]);
    t.stream.frame("r1", frame(1));
    t.stream.end("r1", 1, 1);
    for (let i = 0; i < 30; i += 1) t.stream.frame("r1", frame(1));
    t0 = 10_000;
    for (let i = 0; i < 8; i += 1) t.stream.frame("r1", frame(1));
    t.stream.end("r1", 2, 38);
    t.stream.kws("r1", { seg: 2, name: "tessaya", pass: true, best: 0.95 });
    await t.stream.drained("r1");
    expect(t.woken).toEqual(["r1 Tessaya"]);
    expect(t.confirmed).toEqual([38 * 960, 32_000]);
    expect(t.lines.join("\n")).toMatch(/segment 2\.3 s/);
  });

  it("sends the Tessel its early kws threshold and wake gate until it reports them (both are lost on every boot)", () => {
    const kws = [{ word: "Tessaya", threshold: 0.9 }];
    const gate = { min: 64, x10: 25 };
    expect(kwsSettingsCommand({ early: 0 }, kws, null)).toBe('{"early":0.9}');
    expect(kwsSettingsCommand({}, kws, null)).toBe('{"early":0.9}');
    expect(kwsSettingsCommand({ early: 900 }, kws, null)).toBeNull();
    expect(kwsSettingsCommand({ early: 0 }, [], null)).toBeNull();
    // firmware before 0.3.146 reports no gate: it is never sent one, or every reply would ask again
    expect(kwsSettingsCommand({ early: 900 }, kws, gate)).toBeNull();
    expect(kwsSettingsCommand({ early: 0, gate_min: 160, gate_x10: 30 }, kws, gate)).toBe(
      '{"early":0.9,"gate_min":64,"gate_x10":25}',
    );
    expect(kwsSettingsCommand({ early: 900, gate_min: 64, gate_x10: 30 }, kws, gate)).toBe('{"gate_x10":25}');
    expect(kwsSettingsCommand({ early: 900, gate_min: 64, gate_x10: 25 }, kws, gate)).toBeNull();
    expect(parseWakeGate("min=64,x=2.5")).toEqual(gate);
    expect(parseWakeGate(" min=160 , x=3 ")).toEqual({ min: 160, x10: 30 });
    for (const bad of [undefined, "", "64,2.5", "min=20,x=2.5", "min=64,x=9", "min=64,x=1"]) {
      expect(parseWakeGate(bad)).toBeNull();
    }
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
