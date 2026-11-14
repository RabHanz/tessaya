import { describe, expect, it } from "vite-plus/test";

import { streamingScorer } from "./onnx.ts";

describe("streamingScorer", () => {
  it("reports how far behind the newest frame a late fire was", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    let chunks = 0;
    const s = streamingScorer({
      name: "fake",
      chunkSamples: 1280,
      reset: () => {},
      threshold: 1,
      // The second chunk is the name; scoring is stuck behind a slow first run until released.
      score: async () => {
        chunks += 1;
        await gate;
        return chunks === 2 ? 1 : 0;
      },
    });
    for (let i = 0; i < 20; i += 1) s.feed(new Int16Array(320));
    // Nothing scored yet: whatever it says now is about older audio.
    expect(s.scored()).toEqual({ speech: 0, quiet: 0 });
    release();
    await s.drain();
    // The name's chunk is speech; the three after it are quiet.
    expect(s.scored()).toEqual({ speech: 1280, quiet: 3 * 1280 });
    expect(s.take()).toBe(1);
    expect(s.firedAgo()).toBe(20 * 320 - 2 * 1280);
  });

  it("still scores speech 18 s behind, so a name said at launch fires", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const s = streamingScorer({
      name: "fake",
      chunkSamples: 1280,
      reset: () => {},
      threshold: 1,
      // Models still loading at launch: the name is in the third chunk, and 18 s arrive before the first score.
      score: async (chunk) => {
        await gate;
        return chunk[0] === 1_000 ? 1 : 0;
      },
    });
    for (let i = 0; i < 900; i += 1) s.feed(new Int16Array(320).fill(i >= 8 && i < 12 ? 1_000 : 0));
    release();
    await s.drain();
    expect(s.take()).toBe(1);
  });

  it("catches up after a stall by skipping old quiet audio, not scoring a backlog of it", async () => {
    let gate: Promise<void> = Promise.resolve();
    let release: () => void = () => {};
    let scored = 0;
    let resets = 0;
    const s = streamingScorer({
      name: "fake",
      chunkSamples: 1280,
      reset: () => void (resets += 1),
      threshold: 1,
      score: async () => {
        await gate;
        scored += 1;
        return 0;
      },
    });
    for (let i = 0; i < 4; i += 1) s.feed(new Int16Array(320));
    await s.drain();
    gate = new Promise<void>((resolve) => (release = resolve));
    // A busy computer: 20 s of quiet arrives while one score is stuck.
    for (let i = 0; i < 1_000; i += 1) s.feed(new Int16Array(320));
    release();
    await s.drain();
    // Only the newest few seconds (plus the chunk already running) are scored, from a fresh start.
    expect(scored).toBeLessThanOrEqual(1 + 1 + 4 * (16_000 / 1280));
    expect(resets).toBe(1);
  });

  // 0.1.73: the quiet a segment's end counts was kept across reset(), so a wake's new segment ended at once.
  it("starts its counts afresh on reset, and a chunk still being scored from before does not count after it", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const started: number[] = [];
    let first: () => void = () => {};
    const scoringFirst = new Promise<void>((resolve) => (first = resolve));
    const s = streamingScorer({
      name: "fake",
      chunkSamples: 1280,
      reset: () => {},
      threshold: 0.5,
      // Silence is quiet and sound is speech; the first chunk is still being scored when reset() comes.
      score: async (chunk) => {
        started.push(chunk[0] ?? 0);
        if (started.length === 1) {
          first();
          await gate;
        }
        return (chunk[0] ?? 0) > 0 ? 0.9 : 0.1;
      },
    });
    for (let i = 0; i < 8; i += 1) s.feed(new Int16Array(320));
    await scoringFirst;
    s.reset();
    expect(s.scored().quiet).toBe(0);
    release();
    await s.drain();
    // The quiet chunk that was in flight, and the one queued behind it, count for nothing now.
    expect(s.scored().quiet).toBe(0);
    expect(s.last()).toBe(0);
    for (let i = 0; i < 4; i += 1) s.feed(new Int16Array(320).fill(1_000));
    await s.drain();
    expect(s.scored()).toEqual({ speech: 1280, quiet: 0 });
    expect(s.last()).toBe(0.9);
  });
});
