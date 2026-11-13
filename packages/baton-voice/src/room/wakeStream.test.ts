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
const rig = (heard: string) => {
  const confirmed: number[] = [];
  const woken: string[] = [];
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
      return heard;
    },
    onWake: (id, word) => woken.push(`${id} ${word}`),
    log: () => undefined,
  });
  return { stream, confirmed, woken };
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
      confirm: async () => "Tessaya.",
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
      confirm: async () => "Tessaya",
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
